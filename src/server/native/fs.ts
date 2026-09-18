// Wave 2：把 src-tauri/src/fs_access.rs 的「文件 I/O」命令组忠实移植成 Node 实现。
// 语义对齐点（B1 安全模型，必须保留）：
//   - 所有写/删/移命令必须通过 authorizeMutation 授权：落在固定受管根
//     （~/.kimi、~/.kimi-code、~/.kimi-code-switch-gui）或 durable grant
//     （~/.kimi-code-switch-gui/access-grants.json，root/kind/source/createdAt，
//      目录 0700 / 文件 0600）范围内。
//   - 写/删/移前解析 symlink 最终目标并复核授权范围，禁止受管目录内 symlink 逃逸。
//   - write_text_cas：expectedSha256 为空表示 create-only、非空表示 compare-and-swap。
//   - 原子写（临时文件 + rename）；私密文件 0600 / 私密目录 0700（仅 unix）。
//   - portable directory 上限 4000 文件 / 4000 目录 / 64MB / 深度 32 / 单路径 4096。
//   - quarantine_journal 移到 ~/.kimi-code-switch-gui/quarantine/ 并返回新路径。
//   - reconcile_durable_grants 按面板设置里的 managed 环境 home 重建 durable grants。
import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import * as fs from "node:fs";

import type { CommandHandlers } from "./index";
import { expandHome, getAppDataDir, getKimiCodeHome } from "./paths";

const PORTABLE_DIRECTORY_MAX_FILES = 4_000;
const PORTABLE_DIRECTORY_MAX_DIRECTORIES = 4_000;
const PORTABLE_DIRECTORY_MAX_BYTES = 64 * 1024 * 1024;
const PORTABLE_DIRECTORY_MAX_DEPTH = 32;
const PORTABLE_PATH_MAX_LENGTH = 4_096;

const DURABLE_GRANTS_FILE_NAME = "access-grants.json";

const IS_UNIX = process.platform !== "win32";

type GrantKind = "File" | "DirectoryTree";
type GrantSource = "dialog" | "managed-root";

/** access-grants.json 中的一条持久 durable 授权记录（camelCase 序列化）。 */
export interface GrantRecord {
  root: string;
  kind: GrantKind;
  source: GrantSource;
  createdAt: string;
}

interface DurableGrantFile {
  version: number;
  grants: GrantRecord[];
}

/** 命令希望产生的写入目标类型。 */
type MutationKind = "SingleFile" | "DirectoryTree";

interface DirectoryMergeResult {
  sourceExists: boolean;
  copiedEntries: number;
  skippedConflicts: number;
}

interface SkillMaterializationEntry {
  name: string;
  copied: boolean;
  reason: string;
}

interface NativeHomeSymlinkRepairResult {
  repaired: boolean;
  reason: string;
  skillsMaterialized: SkillMaterializationEntry[];
}

interface PortableFileBundle {
  relativePath: string;
  contentBase64: string;
  executable: boolean;
}

interface PortableDirectoryBundle {
  exists: boolean;
  directories: string[];
  files: PortableFileBundle[];
  sha256: string | null;
}

// ── 进程内 durable grant 状态 ──
// Rust 侧是 PathGrantState（Mutex<HashMap>）。服务端 handler 无状态，因此用模块级数组
// 在进程生命周期内保存授权；由 reconcile_durable_grants 从磁盘重建，pick_backup_directory
// 为桌面专属（见下）。dialog 来源在服务端没有原生来源，只能来自 durable store 或受管根。
const durableGrantsState: GrantRecord[] = [];

/** 把一条授权登记进 state（同 root+kind+source 幂等替换；root 规范化）。 */
function registerGrant(state: GrantRecord[], record: GrantRecord): void {
  const root = canonicalizeOrSelf(record.root);
  const normalized: GrantRecord = { ...record, root };
  for (let index = state.length - 1; index >= 0; index -= 1) {
    const current = state[index];
    if (current.root === normalized.root
      && current.kind === normalized.kind
      && current.source === normalized.source) {
      state.splice(index, 1);
    }
  }
  state.push(normalized);
}

/** 测试/启动时可注入的进程内授权入口。 */
export function registerDurableGrant(root: string, kind: GrantKind, source: GrantSource, createdAt?: string): void {
  registerGrant(durableGrantsState, { root, kind, source, createdAt: createdAt ?? new Date().toISOString() });
}

/** 清空进程内授权（测试用）。 */
export function clearDurableGrants(): void {
  durableGrantsState.length = 0;
}

/** 返回进程内授权数组（测试复用）。 */
export function getDurableGrantsState(): GrantRecord[] {
  return durableGrantsState;
}

function canonicalizeOrSelf(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

// ── 哈希 / 基础工具 ──
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(content: string): string {
  return sha256Bytes(Buffer.from(content, "utf8"));
}

function randomHex(byteLen: number): string {
  return randomBytes(byteLen).toString("hex");
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`missing or invalid string argument '${key}'`);
  }
  return value;
}

// ── 路径范围 / 授权 ──
function validateNoParentTraversal(path: string): void {
  if (path.split(/[\\/]/).includes("..")) {
    throw new Error(`Path '${path}' contains '..' segments and is not allowed`);
  }
}

/** 判断路径是否落在固定受管根内（组件级比较）。 */
export function withinManagedRootAt(path: string, home: string): boolean {
  const bases = [
    join(home, ".kimi"),
    join(home, ".kimi-code"),
    join(home, ".kimi-code-switch-gui"),
  ];
  return bases.some((base) => path === base || path.startsWith(base + sep));
}

// homedir() 的 canonical 版本：/var → /private/var 等符号链接别名统一后再与
// canonical 化后的写目标比较，避免符号链接 HOME（如 /var/folders 临时目录）下
// 误拒受管根写入。对 canonical 的真实 HOME（/Users/xxx）无影响；只增不删授权范围。
let canonicalHomeCache: string | null = null;
function canonicalizedHome(): string {
  if (canonicalHomeCache === null) {
    canonicalHomeCache = canonicalizeOrSelf(homedir());
  }
  return canonicalHomeCache;
}

function withinManagedRoot(path: string): boolean {
  return withinManagedRootAt(path, canonicalizedHome());
}

/** 解析路径的最终写目标：已存在则 canonicalize（跟随 symlink 链）；否则解析存在的父目录后拼接。 */
export function resolveFinalTarget(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`resolve write target ${path}: ${(error as Error).message}`);
    }
    const existing = nearestExistingAncestor(path);
    if (existing === null) {
      const parent = dirname(path) || path;
      if (parent === "") {
        throw new Error(`cannot scope path ${path}`);
      }
      return join(parent, basename(path));
    }
    const resolvedAncestor = fs.realpathSync(existing);
    const rel = relative(existing, path);
    return rel ? join(resolvedAncestor, rel) : resolvedAncestor;
  }
}

function nearestExistingAncestor(path: string): string | null {
  let current = dirname(path);
  for (;;) {
    try {
      fs.statSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function scopeContains(state: GrantRecord[], candidate: string, kind: GrantKind): boolean {
  return state.some((grant) => {
    const inScope = candidate === grant.root || candidate.startsWith(grant.root + sep);
    if (!inScope) return false;
    return grant.kind === "DirectoryTree" || (grant.kind === "File" && kind === "File");
  });
}

/** 所有写/删/移命令的唯一授权入口（B1）。 */
export function authorizeMutation(state: GrantRecord[], path: string, kind: MutationKind): string {
  validateNoParentTraversal(path);
  const finalTarget = resolveFinalTarget(path);
  if (withinManagedRoot(finalTarget)) {
    return finalTarget;
  }
  const grantKind: GrantKind = kind === "SingleFile" ? "File" : "DirectoryTree";
  if (scopeContains(state, finalTarget, grantKind)) {
    return finalTarget;
  }
  throw new Error(
    `Path '${finalTarget}' is outside the authorized scope (managed roots, native dialog grants, or project-local config)`,
  );
}

/** 只读命令保留的宽松校验：只拒绝路径穿越。 */
function validateReadScope(path: string): void {
  validateNoParentTraversal(path);
}

// ── 原子写 ──
function atomicWriteTarget(path: string): string {
  try {
    const meta = fs.lstatSync(path);
    if (meta.isSymbolicLink()) {
      return fs.realpathSync(path);
    }
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw new Error(`stat atomic write target ${path}: ${(error as Error).message}`);
  }
}

function currentFileHash(path: string): string {
  try {
    return sha256Bytes(fs.readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`read current file ${path} for CAS: ${(error as Error).message}`);
  }
}

function verifyExpectedHash(path: string, expected: string | null | undefined): void {
  if (expected === null || expected === undefined) return;
  const actual = currentFileHash(path);
  if (actual === expected) return;
  throw new Error(`write conflict for ${path}: expected sha256 ${expected}, found ${actual}`);
}

function getExistingMode(path: string): number | null {
  if (!IS_UNIX) return null;
  try {
    return fs.statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

function fsyncFile(path: string): void {
  const fd = fs.openSync(path, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncParentDirectory(path: string): void {
  if (!IS_UNIX) return;
  const parent = dirname(path);
  if (!parent) return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(parent, "r");
    fs.fsyncSync(fd);
  } catch {
    // best-effort：目录 fsync 在部分平台不可用，失败不阻断写入。
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** 原子写文本：临时文件 + rename；保留既有权限，新文件 0600。 */
export function atomicWriteText(path: string, content: string, expected: string | null | undefined): void {
  const effectivePath = atomicWriteTarget(path);
  verifyExpectedHash(effectivePath, expected);
  const existingMode = getExistingMode(effectivePath);
  const parent = dirname(effectivePath);
  const tmp = join(parent, `.${basename(effectivePath)}.tmp-${randomHex(8)}`);
  try {
    fs.writeFileSync(tmp, content);
    if (IS_UNIX) {
      fs.chmodSync(tmp, existingMode ?? 0o600);
    }
    fsyncFile(tmp);
    fs.renameSync(tmp, effectivePath);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp already renamed */ }
  }
  syncParentDirectory(effectivePath);
}

// ── symlink 工具 ──
function createSymlinkPath(target: string, link: string): void {
  if (process.platform === "win32") {
    let type: "dir" | "file" = "file";
    try {
      type = fs.statSync(target).isDirectory() ? "dir" : "file";
    } catch { /* fall back to auto */ }
    fs.symlinkSync(target, link, type);
    return;
  }
  fs.symlinkSync(target, link);
}

function resolveLinkAgainst(linkPath: string, rawTarget: string): string {
  if (isAbsolute(rawTarget)) return rawTarget;
  return join(dirname(linkPath), rawTarget);
}

// ── copy / merge / move ──
function copyDirRecursive(from: string, to: string): void {
  if (!fs.existsSync(from)) {
    fs.mkdirSync(to, { recursive: true });
    return;
  }
  if (!fs.statSync(from).isDirectory()) {
    throw new Error(`Source is not a directory: ${from}`);
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) {
      createSymlinkPath(fs.readlinkSync(source), target);
    } else if (entry.isDirectory()) {
      copyDirRecursive(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

function mergeDirectoryMissingRecursive(
  from: string,
  to: string,
  result: DirectoryMergeResult,
): void {
  let sourceMeta: fs.Stats;
  try {
    sourceMeta = fs.lstatSync(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`stat source directory ${from}: ${(error as Error).message}`);
  }
  if (sourceMeta.isSymbolicLink() || !sourceMeta.isDirectory()) {
    throw new Error(`Source is not a real directory: ${from}`);
  }
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (fs.existsSync(target)) {
      const targetType = fs.lstatSync(target);
      if (entry.isDirectory() && targetType.isDirectory() && !targetType.isSymbolicLink()) {
        mergeDirectoryMissingRecursive(source, target, result);
      } else {
        result.skippedConflicts += 1;
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      createSymlinkPath(fs.readlinkSync(source), target);
    } else if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      mergeDirectoryMissingRecursive(source, target, result);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    } else {
      continue;
    }
    result.copiedEntries += 1;
  }
}

// ── repair native home symlink ──
export function repairNativeHomeSymlinkAt(home: string): NativeHomeSymlinkRepairResult {
  const nativeHome = join(home, ".kimi-code");
  const envRoot = join(home, ".kimi-code-switch-gui", ".env");
  const managedDefaultHome = join(envRoot, "default");

  let linkMeta: fs.Stats;
  try {
    linkMeta = fs.lstatSync(nativeHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { repaired: false, reason: "native-home-missing", skillsMaterialized: [] };
    }
    throw new Error(`stat native home ${nativeHome}: ${(error as Error).message}`);
  }
  if (!linkMeta.isSymbolicLink()) {
    return { repaired: false, reason: "not-a-symlink", skillsMaterialized: [] };
  }
  const rawLinkTarget = fs.readlinkSync(nativeHome);
  if (!isDirSync(managedDefaultHome)) {
    return { repaired: false, reason: "legacy-source-missing", skillsMaterialized: [] };
  }
  const linkTarget = resolveLinkAgainst(nativeHome, rawLinkTarget);
  const resolvedTarget = canonicalizeOrSelf(linkTarget);
  const resolvedManaged = canonicalizeOrSelf(managedDefaultHome);
  if (resolvedTarget !== resolvedManaged) {
    return { repaired: false, reason: "foreign-symlink-target", skillsMaterialized: [] };
  }

  const staging = join(envRoot, ".native-home-repair-staging");
  if (fs.existsSync(staging)) {
    throw new Error(`refusing to repair: staging path already exists ${staging}`);
  }
  fs.renameSync(managedDefaultHome, staging);
  try {
    fs.unlinkSync(nativeHome);
  } catch (error) {
    fs.renameSync(staging, managedDefaultHome);
    throw new Error(`remove symlink ${nativeHome}: ${(error as Error).message}`);
  }
  try {
    fs.renameSync(staging, nativeHome);
  } catch (error) {
    fs.renameSync(staging, managedDefaultHome);
    createSymlinkPath(managedDefaultHome, nativeHome);
    throw new Error(`rename ${staging} to ${nativeHome}: ${(error as Error).message}`);
  }

  const skillsMaterialized: SkillMaterializationEntry[] = [];
  const skillsDir = join(nativeHome, "skills");
  if (isDirSync(skillsDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch (error) {
      skillsMaterialized.push({
        name: "<skills>",
        copied: false,
        reason: `scan-failed: ${(error as Error).message}`,
      });
      return { repaired: true, reason: "symlink-materialized", skillsMaterialized };
    }
    for (const entry of entries) {
      const name = entry.name;
      const sourcePath = join(skillsDir, name);
      if (!entry.isSymbolicLink()) continue;
      let rawTarget: string;
      try {
        rawTarget = fs.readlinkSync(sourcePath);
      } catch (error) {
        skillsMaterialized.push({ name, copied: false, reason: `read-link-failed: ${(error as Error).message}` });
        continue;
      }
      const target = resolveLinkAgainst(sourcePath, rawTarget);
      let targetMeta: fs.Stats;
      try {
        targetMeta = fs.statSync(target);
      } catch {
        skillsMaterialized.push({ name, copied: false, reason: "broken-target" });
        continue;
      }
      if (!targetMeta.isDirectory()) {
        skillsMaterialized.push({ name, copied: false, reason: "not-a-directory" });
        continue;
      }
      const stagingCopy = join(skillsDir, `.${name}.materializing`);
      try { fs.rmSync(stagingCopy, { recursive: true, force: true }); } catch { /* ignore */ }
      try {
        copyDirRecursive(target, stagingCopy);
      } catch (error) {
        try { fs.rmSync(stagingCopy, { recursive: true, force: true }); } catch { /* ignore */ }
        skillsMaterialized.push({ name, copied: false, reason: `copy-failed: ${(error as Error).message}` });
        continue;
      }
      try {
        fs.unlinkSync(sourcePath);
      } catch (error) {
        try { fs.rmSync(stagingCopy, { recursive: true, force: true }); } catch { /* ignore */ }
        skillsMaterialized.push({ name, copied: false, reason: `unlink-failed: ${(error as Error).message}` });
        continue;
      }
      try {
        fs.renameSync(stagingCopy, join(skillsDir, name));
      } catch (error) {
        createSymlinkPath(target, sourcePath);
        try { fs.rmSync(stagingCopy, { recursive: true, force: true }); } catch { /* ignore */ }
        skillsMaterialized.push({ name, copied: false, reason: `rename-failed: ${(error as Error).message}` });
        continue;
      }
      skillsMaterialized.push({ name, copied: true, reason: "" });
    }
  }

  return { repaired: true, reason: "symlink-materialized", skillsMaterialized };
}

function isDirSync(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ── portable directory ──
function u64le(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

/** 与 Rust portable_directory_hash 逐字节对齐的 revision 哈希。 */
export function portableDirectoryHash(bundle: PortableDirectoryBundle): string {
  const hash = createHash("sha256");
  hash.update(bundle.exists ? Buffer.from("exists\0", "utf8") : Buffer.from("absent\0", "utf8"));
  const directories = [...bundle.directories].sort();
  for (const directory of directories) {
    hash.update(Buffer.from("dir\0", "utf8"));
    hash.update(u64le(Buffer.byteLength(directory, "utf8")));
    hash.update(Buffer.from(directory, "utf8"));
  }
  const files = [...bundle.files].sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  for (const file of files) {
    const bytes = Buffer.from(file.contentBase64, "base64");
    hash.update(Buffer.from("file\0", "utf8"));
    hash.update(u64le(Buffer.byteLength(file.relativePath, "utf8")));
    hash.update(Buffer.from(file.relativePath, "utf8"));
    hash.update(Buffer.from([file.executable ? 1 : 0]));
    hash.update(u64le(bytes.length));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function portableRelativePath(path: string): string {
  return path.split(/[\\/]/).join("/");
}

function validatePortableRelativePath(value: string): void {
  if (value.length === 0 || value.length > PORTABLE_PATH_MAX_LENGTH || value.includes("\\") || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`invalid portable relative path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")
    || parts.length > PORTABLE_DIRECTORY_MAX_DEPTH) {
    throw new Error(`invalid portable relative path: ${value}`);
  }
}

function collectPortableDirectory(
  root: string,
  directory: string,
  bundle: PortableDirectoryBundle,
  totalBytes: { value: number },
  depth: number,
): void {
  if (depth > PORTABLE_DIRECTORY_MAX_DEPTH) {
    throw new Error(`portable directory exceeds maximum depth ${PORTABLE_DIRECTORY_MAX_DEPTH}`);
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = fs.lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`portable directory cannot contain symbolic links: ${path}`);
    }
    const rel = relative(root, path);
    const relativePath = portableRelativePath(rel);
    if (relativePath.length > PORTABLE_PATH_MAX_LENGTH) {
      throw new Error(`portable path is too long: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      if (bundle.directories.length >= PORTABLE_DIRECTORY_MAX_DIRECTORIES) {
        throw new Error(`portable directory exceeds ${PORTABLE_DIRECTORY_MAX_DIRECTORIES} directories`);
      }
      bundle.directories.push(relativePath);
      collectPortableDirectory(root, path, bundle, totalBytes, depth + 1);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`unsupported portable entry: ${path}`);
    }
    if (bundle.files.length >= PORTABLE_DIRECTORY_MAX_FILES) {
      throw new Error(`portable directory exceeds ${PORTABLE_DIRECTORY_MAX_FILES} files`);
    }
    totalBytes.value += metadata.size;
    if (totalBytes.value > PORTABLE_DIRECTORY_MAX_BYTES) {
      throw new Error(`portable directory exceeds ${PORTABLE_DIRECTORY_MAX_BYTES} bytes`);
    }
    const bytes = fs.readFileSync(path);
    const executable = IS_UNIX ? (metadata.mode & 0o111) !== 0 : false;
    bundle.files.push({
      relativePath,
      contentBase64: bytes.toString("base64"),
      executable,
    });
  }
}

export function exportPortableDirectoryAt(path: string): PortableDirectoryBundle {
  const resolved = expandHome(path);
  validateReadScope(resolved);
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        directories: [],
        files: [],
        sha256: sha256Bytes(Buffer.from("absent\0", "utf8")),
      };
    }
    throw new Error(`stat portable directory ${resolved}: ${(error as Error).message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`portable directory root must be a real directory: ${resolved}`);
  }
  const bundle: PortableDirectoryBundle = { exists: true, directories: [], files: [], sha256: null };
  const totalBytes = { value: 0 };
  collectPortableDirectory(resolved, resolved, bundle, totalBytes, 0);
  bundle.sha256 = portableDirectoryHash(bundle);
  return bundle;
}

function randomStagingPath(target: string, label: string): string {
  const parent = dirname(target);
  const name = basename(target);
  return join(parent, `.${name}.${label}-${randomHex(8)}`);
}

function removePathIfPresent(path: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`stat restore path ${path}: ${(error as Error).message}`);
  }
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    fs.rmSync(path, { recursive: true, force: true });
  } else {
    fs.unlinkSync(path);
  }
}

function setPrivateDirectoryPermissions(path: string): void {
  if (!IS_UNIX) return;
  fs.chmodSync(path, 0o700);
}

function setPortableFilePermissions(path: string, executable: boolean): void {
  if (!IS_UNIX) return;
  fs.chmodSync(path, executable ? 0o700 : 0o600);
}

export function replacePortableDirectoryInner(
  path: string,
  bundle: PortableDirectoryBundle,
  expected: string | null | undefined,
  state: GrantRecord[],
): string {
  const resolved = expandHome(path);
  const finalTarget = authorizeMutation(state, resolved, "DirectoryTree");
  if (expected !== null && expected !== undefined) {
    const actual = exportPortableDirectoryAt(finalTarget).sha256 ?? "";
    if (actual !== expected) {
      throw new Error(`portable directory conflict for ${finalTarget}: expected ${expected}, found ${actual}`);
    }
  }
  if (!bundle.exists && (bundle.directories.length > 0 || bundle.files.length > 0)) {
    throw new Error("absent portable directory must not contain entries");
  }
  if (bundle.files.length > PORTABLE_DIRECTORY_MAX_FILES) {
    throw new Error(`portable directory exceeds ${PORTABLE_DIRECTORY_MAX_FILES} files`);
  }
  if (bundle.directories.length > PORTABLE_DIRECTORY_MAX_DIRECTORIES) {
    throw new Error(`portable directory exceeds ${PORTABLE_DIRECTORY_MAX_DIRECTORIES} directories`);
  }

  const seen = new Set<string>();
  const directories: string[] = [];
  for (const value of bundle.directories) {
    validatePortableRelativePath(value);
    if (seen.has(value)) {
      throw new Error(`duplicate portable path: ${value}`);
    }
    seen.add(value);
    directories.push(value);
  }
  directories.sort((left, right) => {
    const leftDepth = left.split("/").length;
    const rightDepth = right.split("/").length;
    return leftDepth - rightDepth;
  });

  const files: Array<{ relative: string; bytes: Buffer; executable: boolean }> = [];
  let totalBytes = 0;
  for (const file of bundle.files) {
    validatePortableRelativePath(file.relativePath);
    if (seen.has(file.relativePath)) {
      throw new Error(`duplicate portable path: ${file.relativePath}`);
    }
    seen.add(file.relativePath);
    const bytes = Buffer.from(file.contentBase64, "base64");
    totalBytes += bytes.length;
    if (totalBytes > PORTABLE_DIRECTORY_MAX_BYTES) {
      throw new Error(`portable directory exceeds ${PORTABLE_DIRECTORY_MAX_BYTES} bytes`);
    }
    files.push({ relative: file.relativePath, bytes, executable: file.executable });
  }

  const parent = dirname(finalTarget);
  fs.mkdirSync(parent, { recursive: true });
  const backup = randomStagingPath(finalTarget, "previous");
  removePathIfPresent(backup);

  if (!bundle.exists) {
    if (fs.existsSync(finalTarget)) {
      fs.renameSync(finalTarget, backup);
      removePathIfPresent(backup);
      syncParentDirectory(finalTarget);
    }
    return exportPortableDirectoryAt(finalTarget).sha256 ?? "";
  }

  const staging = randomStagingPath(finalTarget, "staging");
  removePathIfPresent(staging);
  fs.mkdirSync(staging);
  setPrivateDirectoryPermissions(staging);
  try {
    for (const relative of directories) {
      const directory = join(staging, relative);
      fs.mkdirSync(directory, { recursive: true });
      setPrivateDirectoryPermissions(directory);
    }
    for (const file of files) {
      const target = join(staging, file.relative);
      if (dirname(target)) {
        fs.mkdirSync(dirname(target), { recursive: true });
        setPrivateDirectoryPermissions(dirname(target));
      }
      fs.writeFileSync(target, file.bytes);
      fsyncFile(target);
      setPortableFilePermissions(target, file.executable);
    }
  } catch (error) {
    removePathIfPresent(staging);
    throw error;
  }

  // B2：staging 构建完成后、首次 rename 前，重新复核目标目录 revision。
  if (expected !== null && expected !== undefined) {
    const currentBeforeSwap = exportPortableDirectoryAt(finalTarget).sha256 ?? "";
    if (currentBeforeSwap !== expected) {
      removePathIfPresent(staging);
      throw new Error(
        `portable directory external change conflict for ${finalTarget}: staging completed but target revision changed (expected ${expected}, found ${currentBeforeSwap}); target left untouched`,
      );
    }
  }

  const hadPrevious = fs.existsSync(finalTarget);
  if (hadPrevious) {
    fs.renameSync(finalTarget, backup);
  }
  try {
    fs.renameSync(staging, finalTarget);
  } catch (error) {
    if (hadPrevious) fs.renameSync(backup, finalTarget);
    removePathIfPresent(staging);
    throw new Error(`activate portable directory ${finalTarget}: ${(error as Error).message}`);
  }
  if (hadPrevious) {
    removePathIfPresent(backup);
  }
  syncParentDirectory(finalTarget);
  return exportPortableDirectoryAt(finalTarget).sha256 ?? "";
}

// ── backup encryption secret ──
export function isValidBackupEncryptionSecret(value: string): boolean {
  return value.length === 64 && /^[0-9a-fA-F]{64}$/.test(value);
}

export function getOrCreateBackupEncryptionSecretAt(appDir: string): string {
  fs.mkdirSync(appDir, { recursive: true });
  if (IS_UNIX) fs.chmodSync(appDir, 0o700);
  const keyPath = join(appDir, "backup-encryption.key");
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`read backup encryption key: ${(error as Error).message}`);
    }
  }
  if (existing !== null) {
    const trimmed = existing.trim();
    if (isValidBackupEncryptionSecret(trimmed)) return trimmed;
    throw new Error("backup encryption key file is invalid");
  }
  const secret = randomBytes(32).toString("hex");
  try {
    atomicWriteText(keyPath, secret, "");
  } catch (error) {
    if ((error as Error).message.includes("write conflict")) {
      const concurrent = fs.readFileSync(keyPath, "utf8").trim();
      if (isValidBackupEncryptionSecret(concurrent)) return concurrent;
      throw new Error("concurrently created backup encryption key is invalid");
    }
    throw error;
  }
  return secret;
}

export function getBackupEncryptionSecretCandidatesAt(appDir: string): string[] {
  const current = getOrCreateBackupEncryptionSecretAt(appDir);
  const previousPath = join(appDir, "backup-encryption.key.previous");
  const candidates = [current];
  try {
    const previous = fs.readFileSync(previousPath, "utf8").trim().toLowerCase();
    if (isValidBackupEncryptionSecret(previous) && previous !== current) {
      candidates.push(previous);
    }
  } catch { /* no previous key */ }
  return candidates;
}

export function importBackupEncryptionSecretAt(appDir: string, secret: string, replace: boolean): string {
  const normalized = secret.trim().toLowerCase();
  if (!isValidBackupEncryptionSecret(normalized)) {
    throw new Error("backup encryption recovery key must contain exactly 64 hexadecimal characters");
  }
  fs.mkdirSync(appDir, { recursive: true });
  if (IS_UNIX) fs.chmodSync(appDir, 0o700);
  const keyPath = join(appDir, "backup-encryption.key");
  let current: string | null = null;
  try {
    current = fs.readFileSync(keyPath, "utf8");
  } catch { /* absent */ }
  if (current !== null) {
    if (current.trim().toLowerCase() === normalized) {
      return keyPath;
    }
    if (!replace) {
      throw new Error("a different backup encryption recovery key already exists");
    }
    const previousPath = join(appDir, "backup-encryption.key.previous");
    if (!fs.existsSync(previousPath)) {
      atomicWriteText(previousPath, current.trim(), "");
    }
  }
  const expectedHash = current !== null ? sha256Bytes(Buffer.from(current, "utf8")) : "";
  atomicWriteText(keyPath, normalized, expectedHash);
  return keyPath;
}

// ── durable grant store ──
function accessGrantsFile(): string {
  const appDir = getAppDataDir();
  fs.mkdirSync(appDir, { recursive: true });
  if (IS_UNIX) fs.chmodSync(appDir, 0o700);
  return join(appDir, DURABLE_GRANTS_FILE_NAME);
}

export function loadDurableGrantsFrom(filePath: string): GrantRecord[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content) as DurableGrantFile;
    if (!Array.isArray(parsed.grants)) return [];
    return parsed.grants.filter((record) => (
      typeof record === "object"
      && record !== null
      && typeof record.root === "string"
      && (record.kind === "File" || record.kind === "DirectoryTree")
      && (record.source === "dialog" || record.source === "managed-root")
      && typeof record.createdAt === "string"
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

export function saveDurableGrantTo(filePath: string, record: GrantRecord): void {
  const existing = loadDurableGrantsFrom(filePath).filter((current) => !(
    current.root === record.root
    && current.kind === record.kind
    && current.source === record.source
  ));
  existing.push(record);
  const file: DurableGrantFile = { version: 1, grants: existing };
  atomicWriteText(filePath, JSON.stringify(file, null, 2), null);
}

export function managedEnvironmentHomesFromPanelSettingsAt(settingsJson: string, home: string): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch (error) {
    throw new Error(`parse saved panel settings for environment homes: ${(error as Error).message}`);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("saved panel settings for environment homes must be a JSON object");
  }
  const environments = (settings as { kimi_code_environments?: unknown }).kimi_code_environments;
  if (!Array.isArray(environments)) {
    return [];
  }
  const homes: string[] = [];
  for (const environment of environments) {
    if (typeof environment !== "object" || environment === null) continue;
    const homePath = (environment as { homePath?: unknown }).homePath;
    if (typeof homePath !== "string") continue;
    const trimmed = homePath.trim();
    if (trimmed.length === 0) continue;
    const resolved = expandHome(trimmed);
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
    } catch {
      continue;
    }
    if (!withinManagedRootAt(canonical, home)) continue;
    if (!homes.includes(canonical)) homes.push(canonical);
  }
  return homes;
}

export function reconcileDurableGrantsInner(
  state: GrantRecord[],
  storeFile: string | null,
  home: string,
  settingsJson: string | null,
): void {
  if (storeFile !== null) {
    for (const record of loadDurableGrantsFrom(storeFile)) {
      registerGrant(state, record);
    }
  }
  if (settingsJson !== null) {
    for (const envHome of managedEnvironmentHomesFromPanelSettingsAt(settingsJson, home)) {
      registerGrant(state, {
        root: envHome,
        kind: "DirectoryTree",
        source: "managed-root",
        createdAt: new Date().toISOString(),
      });
    }
  }
}

// ── quarantine journal ──
export function quarantineJournalAtHome(source: string, home: string): string {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`stat journal ${source}: ${(error as Error).message}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`journal is not a regular file: ${source}`);
  }
  const quarantineDir = join(home, ".kimi-code-switch-gui", "quarantine");
  fs.mkdirSync(quarantineDir, { recursive: true });
  if (IS_UNIX) fs.chmodSync(quarantineDir, 0o700);
  const suffix = randomHex(8);
  const fileName = basename(source) || "journal.json";
  const destination = join(quarantineDir, `${fileName}.${suffix}`);
  fs.renameSync(source, destination);
  if (IS_UNIX) fs.chmodSync(destination, 0o600);
  return destination;
}

// ── 命令注册表 ──
export const fsCommands: CommandHandlers = {
  read_text: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    try {
      return fs.readFileSync(resolved, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`read_text ${resolved}: ${(error as Error).message}`);
    }
  },
  get_kimi_code_home: () => getKimiCodeHome(),
  get_or_create_backup_encryption_secret: () => getOrCreateBackupEncryptionSecretAt(getAppDataDir()),
  get_backup_encryption_secret_candidates: () => getBackupEncryptionSecretCandidatesAt(getAppDataDir()),
  import_backup_encryption_secret: (args) => (
    importBackupEncryptionSecretAt(getAppDataDir(), strArg(args, "secret"), args.replace === true)
  ),
  write_text: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    const finalTarget = authorizeMutation(durableGrantsState, resolved, "SingleFile");
    fs.mkdirSync(dirname(finalTarget), { recursive: true });
    atomicWriteText(finalTarget, strArg(args, "content"), null);
  },
  write_text_cas: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    const finalTarget = authorizeMutation(durableGrantsState, resolved, "SingleFile");
    fs.mkdirSync(dirname(finalTarget), { recursive: true });
    const content = strArg(args, "content");
    const expected = strArg(args, "expectedSha256");
    atomicWriteText(finalTarget, content, expected);
    return sha256Text(content);
  },
  ensure_dir: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    const finalTarget = authorizeMutation(durableGrantsState, resolved, "DirectoryTree");
    fs.mkdirSync(finalTarget, { recursive: true });
  },
  ensure_private_dir: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    const finalTarget = authorizeMutation(durableGrantsState, resolved, "DirectoryTree");
    fs.mkdirSync(finalTarget, { recursive: true });
    if (IS_UNIX) fs.chmodSync(finalTarget, 0o700);
  },
  remove_file: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    const finalTarget = authorizeMutation(durableGrantsState, resolved, "SingleFile");
    try {
      fs.unlinkSync(finalTarget);
      syncParentDirectory(finalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`remove_file ${finalTarget}: ${(error as Error).message}`);
      }
    }
  },
  remove_file_cas: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    const finalTarget = authorizeMutation(durableGrantsState, resolved, "SingleFile");
    const expected = strArg(args, "expectedSha256");
    verifyExpectedHash(finalTarget, expected);
    try {
      fs.unlinkSync(finalTarget);
      syncParentDirectory(finalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`write conflict for ${finalTarget}: file no longer exists`);
      }
      throw new Error(`remove_file_cas ${finalTarget}: ${(error as Error).message}`);
    }
  },
  remove_dir: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    const finalTarget = authorizeMutation(durableGrantsState, resolved, "DirectoryTree");
    try {
      fs.rmSync(finalTarget, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`remove_dir ${finalTarget}: ${(error as Error).message}`);
      }
    }
  },
  move_file: (args) => {
    const fromResolved = expandHome(strArg(args, "from"));
    const toResolved = expandHome(strArg(args, "to"));
    const fromFinal = authorizeMutation(durableGrantsState, fromResolved, "SingleFile");
    const toFinal = authorizeMutation(durableGrantsState, toResolved, "SingleFile");
    if (!fs.existsSync(fromFinal)) {
      throw new Error(`Source file does not exist: ${fromFinal}`);
    }
    fs.mkdirSync(dirname(toFinal), { recursive: true });
    fs.renameSync(fromFinal, toFinal);
  },
  copy_dir: (args) => {
    const fromResolved = expandHome(strArg(args, "from"));
    const toResolved = expandHome(strArg(args, "to"));
    const fromFinal = authorizeMutation(durableGrantsState, fromResolved, "DirectoryTree");
    const toFinal = authorizeMutation(durableGrantsState, toResolved, "DirectoryTree");
    copyDirRecursive(fromFinal, toFinal);
  },
  merge_directory_missing: (args) => {
    const fromResolved = expandHome(strArg(args, "from"));
    const toResolved = expandHome(strArg(args, "to"));
    const fromFinal = authorizeMutation(durableGrantsState, fromResolved, "DirectoryTree");
    const toFinal = authorizeMutation(durableGrantsState, toResolved, "DirectoryTree");
    if (!fs.existsSync(fromFinal)) {
      return { sourceExists: false, copiedEntries: 0, skippedConflicts: 0 };
    }
    const result: DirectoryMergeResult = { sourceExists: true, copiedEntries: 0, skippedConflicts: 0 };
    mergeDirectoryMissingRecursive(fromFinal, toFinal, result);
    return result;
  },
  repair_native_home_symlink: () => {
    const home = homedir();
    authorizeMutation(durableGrantsState, join(home, ".kimi-code"), "DirectoryTree");
    authorizeMutation(durableGrantsState, join(home, ".kimi-code-switch-gui", ".env", "default"), "DirectoryTree");
    return repairNativeHomeSymlinkAt(home);
  },
  hostname: () => {
    const value = osHostname();
    return value && value.trim().length > 0 ? value : "unknown-host";
  },
  list_subdirs: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    try {
      return fs.readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`list_subdirs ${resolved}: ${(error as Error).message}`);
    }
  },
  path_exists: (args) => fs.existsSync(expandHome(strArg(args, "path"))),
  resolve_home_path: (args) => expandHome(strArg(args, "path")),
  real_path: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    try {
      return fs.realpathSync(resolved);
    } catch (error) {
      throw new Error(`real_path ${resolved}: ${(error as Error).message}`);
    }
  },
  list_dir: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    try {
      return fs.readdirSync(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`list_dir ${resolved}: ${(error as Error).message}`);
    }
  },
  list_dir_typed: (args) => {
    const resolved = expandHome(strArg(args, "path"));
    try {
      return fs.readdirSync(resolved, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`list_dir_typed ${resolved}: ${(error as Error).message}`);
    }
  },
  export_portable_directory: (args) => exportPortableDirectoryAt(strArg(args, "path")),
  replace_portable_directory: (args) => {
    const path = strArg(args, "path");
    const bundle = args.bundle as PortableDirectoryBundle;
    const expected = args.expectedSha256;
    return replacePortableDirectoryInner(
      path,
      bundle,
      typeof expected === "string" ? expected : null,
      durableGrantsState,
    );
  },
  save_file_with_dialog: () => {
    throw new Error("save_file_with_dialog is only available on desktop; the web/browser runtime uses a client-side download instead");
  },
  pick_backup_directory: () => {
    throw new Error("pick_backup_directory is only available on desktop; the web/browser runtime selects a directory via a client-side prompt");
  },
  write_project_local_config: (args) => {
    const root = expandHome(strArg(args, "projectRoot"));
    validateNoParentTraversal(root);
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(root);
    } catch (error) {
      throw new Error(`resolve project root ${root}: ${(error as Error).message}`);
    }
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      throw new Error(`project root is not a directory: ${canonicalRoot}`);
    }
    const target = join(canonicalRoot, ".kimi-code", "local.toml");
    fs.mkdirSync(dirname(target), { recursive: true });
    const content = strArg(args, "content");
    atomicWriteText(target, content, strArg(args, "expectedSha256"));
    return sha256Text(content);
  },
  reconcile_durable_grants: async () => {
    const home = homedir();
    let storeFile: string | null = null;
    try {
      storeFile = accessGrantsFile();
    } catch {
      storeFile = null;
    }
    let settingsJson: string | null = null;
    try {
      // 惰性 import，避免与服务端其他并行移植模块（usage/stores）的中间态耦合。
      const { invokeCommand } = await import("./index");
      const raw = await invokeCommand<string | null>("get_panel_settings", {});
      if (typeof raw === "string") settingsJson = raw;
    } catch {
      // 面板存储暂不可用（并行 agent 中间态或初始化顺序）时不阻断启动。
    }
    reconcileDurableGrantsInner(durableGrantsState, storeFile, home, settingsJson);
  },
  quarantine_journal: (args) => {
    const source = expandHome(strArg(args, "path"));
    return quarantineJournalAtHome(source, homedir());
  },
};
