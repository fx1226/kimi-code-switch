// POSIX 路径工具（内联实现，避免依赖 node:path，使本模块可在 renderer 直接运行）。
function join(...segments: string[]): string {
  return segments
    .filter((seg) => seg.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export type SkillType = "prompt" | "flow";
export type SkillDiscoveryMode = "auto";
/**
 * 发现目录的类别。
 * - "builtin"：CLI 内置技能，仅作说明项，不扫描磁盘。
 * - "user-brand"：Kimi Code 用户级技能目录（$KIMI_CODE_HOME/skills）。
 * - "user-common"：通用代理技能目录（~/.agents/skills）。
 * - "project"：工作区（workspaces.json 根）下的项目级技能目录。
 * - "extra"：config.toml extra_skill_dirs 追加目录。
 * UI 只对 "builtin" 特判，其余组共用同一渲染路径。
 */
export type SkillPathGroup = "builtin" | "user-brand" | "user-common" | "project" | "extra";

export interface SkillFileAccess {
  readText(path: string): Promise<string | null>;
  listDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  pathExists(path: string): Promise<boolean>;
}

export interface SkillDiscoveryPath {
  id: string;
  group: SkillPathGroup;
  label: string;
  path: string;
  exists: boolean;
  selected: boolean;
  priority: number;
  reason: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  type: SkillType;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
}

export interface SkillEntry {
  id: string;
  name: string;
  sourcePathId: string;
  directoryName: string;
  directoryPath: string;
  skillFilePath: string;
  sourceLabel: string;
  sourceGroup: SkillPathGroup;
  priority: number;
  enabled: boolean;
  effective: boolean;
  overriddenBy?: string;
  frontmatter: boolean;
  metadata: SkillMetadata;
  content: string;
  lineCount: number;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}

export interface SkillsScanSummary {
  total: number;
  effective: number;
  overrides: number;
  warnings: number;
  errors: number;
  flow: number;
}

export interface SkillsScanReport {
  builtinNotice: string;
  discoveryMode: SkillDiscoveryMode;
  mergeAllAvailableSkills: boolean;
  paths: SkillDiscoveryPath[];
  skills: SkillEntry[];
  summary: SkillsScanSummary;
}

/**
 * 扫描选项。注入项用于对接真实运行时：
 * - userHome: 默认缩略主目录路径（如 "~"），用于展开 ~ 起始的 extra_skill_dirs 与 workspaces.json。
 *   缺省按 "~" 处理，方可与纯 ~ 路径断言共存。
 * - envHome: KIMI_CODE_HOME 生效时的用户级技能主目录路径（如 "~/.my-kimi-home"）。
 *   缺失时回退 `~/.kimi-code`。
 * - projectRoots: 工作区根列表（来自 workspaces.json 的 root 字段）。每个根下扫描
 *   `.kimi-code/skills` + `.agents/skills`。
 * - readJson: 用于读取并解析 workspaces.json 等轻量 JSON 文档的钩子（Tauri 适配器注入，
 *   测试注入内存 FS）。缺失时不解析任何 JSON。
 * - extraSkillDirs: config.toml extra_skill_dirs（绝对或 ~ 起始路径）。缺省为空。
 */
export interface ScanSkillsOptions {
  mergeAllAvailableSkills: boolean;
  userHome?: string;
  envHome?: string;
  projectRoots?: string[];
  extraSkillDirs?: string[];
  readJson?: (path: string) => Promise<string | null>;
}

export async function scanSkills(
  files: SkillFileAccess,
  options: ScanSkillsOptions,
): Promise<SkillsScanReport> {
  const discoveryMode: SkillDiscoveryMode = "auto";
  const paths = await buildDiscoveryPaths(files, options);
  const scannedPaths = paths
    .filter((entry) => entry.group !== "builtin" && entry.exists)
    .sort((left, right) => left.priority - right.priority);

  const skills: SkillEntry[] = [];
  const firstLoadedByName = new Map<string, SkillEntry>();

  for (const path of scannedPaths) {
    const discovered = await loadSkillsFromPath(files, path);
    for (const skill of discovered) {
      if (!skill.enabled) {
        skill.effective = false;
        skill.overriddenBy = "Disabled directory";
        skills.push(skill);
        continue;
      }

      const existing = firstLoadedByName.get(skill.name);
      if (!existing) {
        firstLoadedByName.set(skill.name, skill);
      } else {
        skill.effective = false;
        skill.overriddenBy = `${existing.name} · ${existing.sourceLabel}`;
      }
      skills.push(skill);
    }
  }

  const summary = buildSummary(skills);

  return {
    builtinNotice: "Built-in skills are provided by Kimi Code and are not enumerated from the local filesystem.",
    discoveryMode,
    mergeAllAvailableSkills: options.mergeAllAvailableSkills,
    paths,
    skills,
    summary,
  };
}

/**
 * 构造 0.38.0 技能发现目录集，回到 CLI 的真实扫描行为：
 * - 用户级 brand：$KIMI_CODE_HOME/skills（默认 ~/.kimi-code/skills）。
 * - 用户级 common：~/.agents/skills。
 * - 项目级：每个工作区根（workspaces.json）下的 .kimi-code/skills 与 .agents/skills。
 * - extra_skill_dirs：config.toml 追加目录。
 * `~/.claude/skills`、`~/.codex/skills`、`~/.config/agents/skills` 不再扫描（CLI 不扫）。
 *
 * 优先级（priority 越小越先加载，同名技能以先加载者有效）：
 * 项目级 > 用户级 > extra_skill_dirs。
 */
async function buildDiscoveryPaths(
  files: SkillFileAccess,
  options: ScanSkillsOptions,
): Promise<SkillDiscoveryPath[]> {
  const userHome = options.userHome ?? "~";
  const kimiCodeHome = options.envHome ?? "~/.kimi-code";
  const workspacesFile = join(kimiCodeHome, "workspaces.json");

  // 显式注入的工作区根优先；未注入时从 workspaces.json 读取（CLI 真实来源）。
  const fileRoots = await readWorkspacesRoots(workspacesFile, options.readJson);
  const workspacesRoots = dedupe([...(options.projectRoots ?? []), ...fileRoots]);

  const candidates: SkillDiscoveryPath[] = [
    createCandidate("builtin", "builtin", "(managed by CLI package)"),
    // 用户级 brand：KIMI_CODE_HOME 优先，否则默认 ~/.kimi-code。
    createCandidate("user-brand-kimi", "user-brand", join(kimiCodeHome, "skills")),
    // 用户级 common：通用代理技能目录。
    createCandidate("user-common-agents", "user-common", join(userHome, ".agents", "skills")),
  ];

  // 项目级：每个工作区根下的 .kimi-code/skills 与 .agents/skills。
  for (const root of workspacesRoots) {
    candidates.push(createCandidate(`project-${slugify(root)}-kimi`, "project", join(root, ".kimi-code", "skills")));
    candidates.push(createCandidate(`project-${slugify(root)}-agents`, "project", join(root, ".agents", "skills")));
  }

  // extra_skill_dirs：config.toml 追加目录（绝对或 ~ 起始路径）。
  for (const dir of options.extraSkillDirs ?? []) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = normalizedUserPath(trimmed, userHome);
    candidates.push(createCandidate(`extra-${slugify(resolved)}`, "extra", resolved));
  }

  const candidatesWithExistence = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      exists: candidate.group === "builtin" ? true : await files.pathExists(candidate.path),
      selected: false,
      priority: Number.MAX_SAFE_INTEGER,
      reason: candidate.group === "builtin" ? "Built-in skills are documented but not scanned from disk." : "",
    })),
  );

  let priority = 0;
  const paths: SkillDiscoveryPath[] = [];

  const mark = (entry: SkillDiscoveryPath, builder: () => void): void => {
    const target = candidatesWithExistence.find((item) => item.id === entry.id);
    if (!target) {
      return;
    }
    if (!target.exists) {
      target.reason = "Directory not found.";
      return;
    }
    target.selected = true;
    target.priority = priority;
    priority += 1;
    builder();
  };

  const selectGroup = (group: SkillPathGroup, mode: "single" | "all"): void => {
    const groupCandidates = candidatesWithExistence.filter((entry) => entry.group === group);
    if (mode === "all") {
      for (const entry of groupCandidates) {
        mark(entry, () => {
          entry.reason = "Loaded because merge_all_available_skills is enabled for brand directories.";
        });
      }
      return;
    }

    const selected = groupCandidates.find((entry) => entry.exists);
    for (const entry of groupCandidates) {
      if (entry === selected) {
        mark(entry, () => {
          entry.reason = "First existing directory in this priority group.";
        });
      } else if (entry.exists) {
        entry.reason = "Skipped because a higher-priority directory in the same group already exists.";
      } else {
        entry.reason = "Directory not found.";
      }
    }
  };

  // 项目级：每个工作区根为独立优先组。同一根下 .kimi-code/skills 与 .agents/skills
  // 是两种独立来源，彼此不互斥——只要存在都加载（既不跟随 merge_all_available_skills，
  // 也不同根内二选一）。
  for (const root of workspacesRoots) {
    const rootCandidates = candidatesWithExistence.filter(
      (entry) => entry.group === "project" && entry.id.startsWith(`project-${slugify(root)}-`),
    );
    for (const entry of rootCandidates) {
      mark(entry, () => {
        entry.reason = "Project-level directory inside this workspace root.";
      });
    }
  }

  // 用户级：brand 遵循 merge_all_available_skills（同一品牌多目录合并），common 仅取第一个存在的目录。
  selectGroup("user-brand", options.mergeAllAvailableSkills ? "all" : "single");
  selectGroup("user-common", "single");

  // extra_skill_dirs：全部追加加载（无互斥）。
  for (const entry of candidatesWithExistence) {
    if (entry.group === "extra") {
      mark(entry, () => {
        entry.reason = "Loaded because it is listed in config.toml extra_skill_dirs.";
      });
    }
  }

  paths.push(...candidatesWithExistence);
  return paths;
}

/**
 * 读取并解析 ~/.kimi-code/workspaces.json，返回各工作区 root 列表。
 * 形如 {"version":1,"workspaces":{"<key>":{"root":"/abs/path","name":"..."}}}。
 */
async function readWorkspacesRoots(
  workspacesFile: string,
  readJson?: ScanSkillsOptions["readJson"],
): Promise<string[]> {
  if (!readJson) {
    return [];
  }
  let raw: string | null = null;
  try {
    raw = await readJson(workspacesFile);
  } catch {
    return [];
  }
  if (!raw?.trim()) {
    return [];
  }
  try {
    return parseWorkspacesRoots(JSON.parse(raw));
  } catch {
    return [];
  }
}

function parseWorkspacesRoots(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const workspaces = (data as { workspaces?: unknown }).workspaces;
  if (!workspaces || typeof workspaces !== "object") {
    return [];
  }
  const roots: string[] = [];
  for (const value of Object.values(workspaces as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const root = (value as { root?: unknown }).root;
    if (typeof root === "string" && root.trim()) {
      roots.push(root.trim());
    }
  }
  return roots;
}

/** ~ 起始路径按 userHome 展开为绝对路径；绝对路径原样保留。 */
function normalizedUserPath(path: string, userHome: string): string {
  if (path === "~") {
    return userHome;
  }
  if (path.startsWith("~/")) {
    return join(userHome, path.slice(2));
  }
  return path.replace(/\/+$/, "");
}

/** 去重并保留顺序。 */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/** 用于生成稳定 candidate id/label：保留绝对路径可读性但去掉斜杠，供 slug 化 id 使用。 */
function slugify(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized.replace(/[/~]/g, "-") || "root";
}

async function loadSkillsFromPath(
  files: SkillFileAccess,
  source: SkillDiscoveryPath,
): Promise<SkillEntry[]> {
  if (!source.exists || source.group === "builtin") {
    return [];
  }

  const rootSkillPath = join(source.path, "SKILL.md");
  if (await files.pathExists(rootSkillPath)) {
    const skill = await buildSkillEntry(files, {
      rootPath: source.path,
      directoryName: basename(source.path),
      source,
    });
    return skill ? [skill] : [];
  }

  const entries = await files.listDir(source.path);
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory)
      .map((entry) =>
        buildSkillEntry(files, {
          rootPath: join(source.path, entry.name),
          directoryName: entry.name,
          source,
        }),
      ),
  );

  return skills.filter((entry): entry is SkillEntry => Boolean(entry));
}

async function buildSkillEntry(
  files: SkillFileAccess,
  options: {
    rootPath: string;
    directoryName: string;
    source: SkillDiscoveryPath;
  },
): Promise<SkillEntry | null> {
  const skillFilePath = join(options.rootPath, "SKILL.md");
  const content = await files.readText(skillFilePath);
  if (!content?.trim()) {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const metadata = normalizeMetadata(frontmatter.attributes, options.directoryName, frontmatter.body);
  const children = await files.listDir(options.rootPath);

  return {
    id: `${options.source.id}:${metadata.name}:${options.directoryName}`,
    name: metadata.name,
    sourcePathId: options.source.id,
    directoryName: options.directoryName,
    directoryPath: options.rootPath,
    skillFilePath,
    sourceLabel: options.source.label,
    sourceGroup: options.source.group,
    priority: options.source.priority,
    enabled: options.source.selected,
    effective: true,
    frontmatter: frontmatter.hasFrontmatter,
    metadata,
    content,
    lineCount: content.split(/\r?\n/).length,
    hasScripts: children.some((entry) => entry.isDirectory && entry.name === "scripts"),
    hasReferences: children.some((entry) => entry.isDirectory && entry.name === "references"),
    hasAssets: children.some((entry) => entry.isDirectory && entry.name === "assets"),
  };
}

function parseFrontmatter(document: string): {
  hasFrontmatter: boolean;
  attributes: Record<string, string | Record<string, string>>;
  body: string;
} {
  if (!document.startsWith("---\n") && !document.startsWith("---\r\n")) {
    return {
      hasFrontmatter: false,
      attributes: {},
      body: document,
    };
  }

  const normalized = document.replace(/\r\n/g, "\n");
  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex < 0) {
    return {
      hasFrontmatter: false,
      attributes: {},
      body: normalized,
    };
  }

  const header = normalized.slice(4, endIndex).split("\n");
  const body = normalized.slice(endIndex + 5);
  const attributes: Record<string, string | Record<string, string>> = {};
  let currentObjectKey = "";

  for (let index = 0; index < header.length; index += 1) {
    const rawLine = header[index];
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }

    if (/^\s{2,}[A-Za-z0-9._-]+\s*:/.test(rawLine) && currentObjectKey) {
      const match = rawLine.match(/^\s+([A-Za-z0-9._-]+)\s*:\s*(.*)$/);
      if (!match) {
        continue;
      }
      const current = attributes[currentObjectKey];
      if (typeof current === "object" && current !== null && !Array.isArray(current)) {
        current[match[1]] = stripQuotes(match[2]);
      }
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9._-]+)\s*:\s*(.*)$/);
    if (!pair) {
      currentObjectKey = "";
      continue;
    }

    const [, key, rawValue] = pair;
    const indentedBlock = collectIndentedBlock(header, index + 1);
    if (isBlockScalar(rawValue)) {
      attributes[key] = normalizeBlockScalar(indentedBlock.lines);
      currentObjectKey = "";
      index = indentedBlock.nextIndex - 1;
      continue;
    }
    if (!rawValue.trim()) {
      if (indentedBlock.lines.length === 0) {
        attributes[key] = "";
        currentObjectKey = "";
        continue;
      }
      if (isIndentedKeyValueBlock(indentedBlock.lines)) {
        attributes[key] = {};
        currentObjectKey = key;
        index = indentedBlock.startIndex - 1;
      } else {
        attributes[key] = normalizeBlockScalar(indentedBlock.lines);
        currentObjectKey = "";
        index = indentedBlock.nextIndex - 1;
      }
      continue;
    }
    attributes[key] = stripQuotes(rawValue);
    currentObjectKey = "";
  }

  return {
    hasFrontmatter: true,
    attributes,
    body,
  };
}

function normalizeMetadata(
  attributes: Record<string, string | Record<string, string>>,
  directoryName: string,
  body: string,
): SkillMetadata {
  const rawName = typeof attributes.name === "string" ? attributes.name : directoryName;
  const rawDescription =
    typeof attributes.description === "string" && attributes.description.trim()
      ? attributes.description
      : "No description provided.";
  const rawType = typeof attributes.type === "string" ? attributes.type.trim().toLowerCase() : "";
  const metadata =
    typeof attributes.metadata === "object" && attributes.metadata !== null && !Array.isArray(attributes.metadata)
      ? Object.fromEntries(
          Object.entries(attributes.metadata).map(([key, value]) => [key, String(value)]),
        )
      : {};

  return {
    name: rawName.trim() || directoryName,
    description: normalizeInlineText(rawDescription) || "No description provided.",
    type: rawType === "flow" || inferFlowFromContent(body) ? "flow" : "prompt",
    license: typeof attributes.license === "string" ? attributes.license.trim() : "",
    compatibility: typeof attributes.compatibility === "string" ? attributes.compatibility.trim() : "",
    metadata,
  };
}

function inferFlowFromContent(content: string): boolean {
  return /```(?:mermaid|d2)\b/.test(content);
}

function buildSummary(skills: SkillEntry[]): SkillsScanSummary {
  return {
    total: skills.length,
    effective: skills.filter((skill) => skill.effective).length,
    overrides: skills.filter((skill) => !skill.effective).length,
    warnings: 0,
    errors: 0,
    flow: skills.filter((skill) => skill.metadata.type === "flow").length,
  };
}

function createCandidate(id: string, group: SkillPathGroup, path: string): SkillDiscoveryPath {
  return {
    id,
    group,
    label: pathLabel(group, path),
    path,
    exists: false,
    selected: false,
    priority: Number.MAX_SAFE_INTEGER,
    reason: "",
  };
}

function pathLabel(group: SkillPathGroup, path: string): string {
  if (group === "builtin") {
    return "Built-in Skills";
  }
  const prefix =
    group === "user-brand"
      ? "User Brand"
      : group === "user-common"
        ? "User Common"
        : group === "project"
          ? "Project"
          : "Extra";
  return `${prefix} · ${path}`;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isBlockScalar(value: string): boolean {
  return /^[>|][+-]?\s*$/.test(value.trim());
}

function normalizeBlockScalar(lines: string[]): string {
  const nonEmptyIndents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^(\s*)/)?.[1].length ?? 0);
  const sharedIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;

  return lines
    .map((line) => {
      if (!line.trim()) {
        return "";
      }
      return line.slice(sharedIndent);
    })
    .join("\n")
    .trim();
}

function normalizeInlineText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectIndentedBlock(lines: string[], startIndex: number): {
  lines: string[];
  startIndex: number;
  nextIndex: number;
} {
  const blockLines: string[] = [];
  let cursor = startIndex;
  while (cursor < lines.length) {
    const nextLine = lines[cursor];
    if (nextLine.trim() && !/^\s+/.test(nextLine)) {
      break;
    }
    blockLines.push(nextLine);
    cursor += 1;
  }
  return {
    lines: blockLines,
    startIndex,
    nextIndex: cursor,
  };
}

function isIndentedKeyValueBlock(lines: string[]): boolean {
  const contentLines = lines.filter((line) => line.trim().length > 0);
  if (contentLines.length === 0) {
    return false;
  }
  return contentLines.every((line) => /^\s+[A-Za-z0-9._-]+\s*:\s*.*$/.test(line));
}
