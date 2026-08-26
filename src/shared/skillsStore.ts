import { parse as parseYaml } from "yaml";
import type { PluginSkillRoot } from "./types";

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

export type SkillType = "prompt" | "inline" | "flow" | "reference";
export type SkillDiscoveryMode = "auto";
/**
 * 发现目录的类别。
 * - "builtin"：CLI 内置技能，仅作说明项，不扫描磁盘。
 * - "user-brand"：Kimi Code 用户级技能目录（$KIMI_CODE_HOME/skills）。
 * - "user-common"：通用代理技能目录（~/.agents/skills）。
 * - "project"：当前工作目录向上找到的最近 Git 项目下的技能目录。
 * - "extra"：config.toml extra_skill_dirs 追加目录。
 * UI 只对 "builtin" 特判，其余组共用同一渲染路径。
 */
export type SkillPathGroup = "builtin" | "user-brand" | "user-common" | "project" | "plugin" | "extra";

export interface SkillFileAccess {
  readText(path: string): Promise<string | null>;
  listDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  pathExists(path: string): Promise<boolean>;
  realPath?(path: string): Promise<string>;
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
  pluginId?: string;
  rootSkillOnly?: boolean;
}

export interface SkillMetadata {
  name: string;
  description: string;
  type: SkillType;
  license: string;
  compatibility: string;
  whenToUse: string;
  disableModelInvocation: boolean;
  arguments: string[];
  metadata: Record<string, string>;
  hasSubSkill: boolean;
  isSubSkill?: boolean;
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
  valid: boolean;
  diagnostics: string[];
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
 * - userHome: 默认缩略主目录路径（如 "~"），用于展开 ~ 起始的 extra_skill_dirs。
 *   缺省按 "~" 处理，方可与纯 ~ 路径断言共存。
 * - envHome: KIMI_CODE_HOME 生效时的用户级技能主目录路径（如 "~/.my-kimi-home"）。
 *   缺失时回退 `~/.kimi-code`。
 * - projectWorkingDirectory: GUI 启动 Kimi 时使用的 cwd；向上寻找最近 `.git`。
 * - projectRoots: 测试或集成显式注入的项目根，与最近 Git 根合并去重。
 * - extraSkillDirs: config.toml extra_skill_dirs（绝对或 ~ 起始路径）。缺省为空。
 */
export interface ScanSkillsOptions {
  mergeAllAvailableSkills: boolean;
  userHome?: string;
  envHome?: string;
  projectRoots?: string[];
  projectWorkingDirectory?: string;
  pluginSkillRoots?: PluginSkillRoot[];
  extraSkillDirs?: string[];
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
    let discovered: SkillEntry[];
    try {
      const scanResult = await loadSkillsFromPath(files, path);
      discovered = scanResult.skills;
      if (scanResult.warnings.length > 0) {
        path.reason = `${path.reason} Warnings: ${scanResult.warnings.join("; ")}`.trim();
      }
    } catch (error) {
      path.selected = false;
      path.reason = `Skill scan failed: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    for (const skill of discovered) {
      if (!skill.valid) {
        skill.enabled = false;
        skill.effective = false;
        skill.overriddenBy = "Invalid Skill metadata";
        skills.push(skill);
        continue;
      }
      if (!skill.enabled) {
        skill.effective = false;
        skill.overriddenBy = "Disabled directory";
        skills.push(skill);
        continue;
      }

      const identity = skill.name.toLocaleLowerCase();
      const existing = firstLoadedByName.get(identity);
      if (!existing) {
        firstLoadedByName.set(identity, skill);
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
 * - 项目级：当前 cwd 向上最近 Git 根下的 .kimi-code/skills 与 .agents/skills。
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
  const normalizedWorkingDirectory = options.projectWorkingDirectory
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const nearestProjectRoot = normalizedWorkingDirectory
    ? await resolveNearestGitProjectRoot(files, normalizedWorkingDirectory) ?? normalizedWorkingDirectory
    : null;
  const workspacesRoots = dedupe([
    ...(nearestProjectRoot ? [nearestProjectRoot] : []),
    ...(options.projectRoots ?? []),
  ]);

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

  for (const root of options.pluginSkillRoots ?? []) {
    const candidate = createCandidate(
      `plugin-${slugify(root.pluginId)}-${slugify(root.path)}`,
      "plugin",
      root.path,
    );
    candidate.pluginId = root.pluginId;
    candidate.rootSkillOnly = root.rootSkillOnly;
    candidates.push(candidate);
  }

  // extra_skill_dirs：官方按绝对路径 / OS home / 最近 Git project root 解析。
  const seenExtraRoots = new Set<string>();
  for (const dir of options.extraSkillDirs ?? []) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    let resolved = normalizedConfiguredPath(trimmed, userHome, nearestProjectRoot);
    if (files.realPath && await files.pathExists(resolved)) {
      try {
        resolved = await files.realPath(resolved);
      } catch {
        // Existence and scan diagnostics below remain authoritative when the
        // path disappears or becomes unreadable between probes.
      }
    }
    if (seenExtraRoots.has(resolved)) continue;
    seenExtraRoots.add(resolved);
    candidates.push(createCandidate(`extra-${slugify(resolved)}`, "extra", resolved));
  }

  const realizedCandidates = await Promise.all(candidates.map(async (candidate) => {
    const exists = candidate.group === "builtin" ? true : await files.pathExists(candidate.path);
    let resolvedPath = candidate.path;
    if (exists && candidate.group !== "builtin" && files.realPath) {
      try {
        resolvedPath = await files.realPath(candidate.path);
      } catch {
        // Keep the lexical candidate so the later scanner can report the race.
      }
    }
    return {
      ...candidate,
      path: resolvedPath,
      label: pathLabel(candidate.group, resolvedPath),
      exists,
      selected: false,
      priority: Number.MAX_SAFE_INTEGER,
      reason: candidate.group === "builtin" ? "Built-in skills are documented but not scanned from disk." : "",
    };
  }));
  const seenResolvedRoots = new Set<string>();
  const candidatesWithExistence = realizedCandidates.filter((candidate) => {
    if (!candidate.exists || candidate.group === "builtin") return true;
    const sourceIdentity = candidate.group === "user-brand" || candidate.group === "user-common"
      ? "user"
      : candidate.group === "plugin"
        ? `plugin:${candidate.pluginId ?? ""}`
        : candidate.group;
    const key = `${sourceIdentity}\0${candidate.path}`;
    if (seenResolvedRoots.has(key)) return false;
    seenResolvedRoots.add(key);
    return true;
  });

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

  // Plugin 是比显式 extra 更低的来源；当前实现按 first-wins 合并，
  // 因此必须在 extra 之后扫描，才能得到 workspace > user > extra > plugin > builtin。
  for (const entry of candidatesWithExistence) {
    if (entry.group === "plugin") {
      mark(entry, () => {
        entry.reason = `Loaded from enabled plugin ${entry.pluginId ?? "unknown"}.`;
      });
    }
  }

  paths.push(...candidatesWithExistence);
  return paths;
}

export async function resolveNearestGitProjectRoot(
  files: SkillFileAccess,
  start: string,
): Promise<string | null> {
  let current = start.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!current) return null;
  for (let depth = 0; depth < 64; depth += 1) {
    if (await files.pathExists(join(current, ".git"))) return current;
    const slash = current.lastIndexOf("/");
    const parent = slash <= 0 ? (current.startsWith("/") ? "/" : "") : current.slice(0, slash);
    if (!parent || parent === current) return null;
    current = parent;
  }
  return null;
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

function normalizedConfiguredPath(path: string, userHome: string, projectRoot: string | null): string {
  const expanded = normalizedUserPath(path, userHome);
  const isAbsolute = expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded);
  if (isAbsolute || !projectRoot || expanded === userHome || path.startsWith("~/")) {
    return expanded;
  }
  return join(projectRoot, expanded);
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
): Promise<{ skills: SkillEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (!source.exists || source.group === "builtin") {
    return { skills: [], warnings };
  }
  const rootSkillPath = join(source.path, "SKILL.md");
  if (source.rootSkillOnly) {
    try {
      const rootSkill = await buildSkillEntry(files, {
        rootPath: source.path,
        directoryName: basename(source.path),
        source,
      });
      return { skills: rootSkill ? [rootSkill] : [], warnings };
    } catch (error) {
      warnings.push(`${rootSkillPath}: ${error instanceof Error ? error.message : String(error)}`);
      return { skills: [], warnings };
    }
  }
  return {
    skills: await walkSkillDirectory(files, source, source.path, true, 0, undefined, warnings, rootSkillPath),
    warnings,
  };
}

const MAX_SKILL_SCAN_DEPTH = 8;

async function walkSkillDirectory(
  files: SkillFileAccess,
  source: SkillDiscoveryPath,
  directoryPath: string,
  isTopLevel: boolean,
  depth: number,
  parentSkillName: string | undefined,
  warnings: string[],
  rootSkillPath?: string,
): Promise<SkillEntry[]> {
  if (depth > MAX_SKILL_SCAN_DEPTH) return [];
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    entries = (await files.listDir(directoryPath))
      .filter((entry) => entry.name !== "node_modules" && !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    warnings.push(`${directoryPath}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const result: SkillEntry[] = [];

  if (isTopLevel && source.group === "plugin" && rootSkillPath) {
    try {
      if (await files.pathExists(rootSkillPath)) {
        const rootSkill = await buildSkillEntry(files, {
          rootPath: directoryPath,
          directoryName: basename(directoryPath),
          source,
        });
        if (rootSkill) result.push(parentSkillName ? qualifySubSkill(rootSkill, parentSkillName) : rootSkill);
      }
    } catch (error) {
      warnings.push(`${rootSkillPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const directories = entries.filter((entry) => entry.isDirectory);
  const bundles = await Promise.all(directories.map(async (entry) => {
    const skillPath = join(directoryPath, entry.name, "SKILL.md");
    try {
      return { entry, hasSkill: await files.pathExists(skillPath) };
    } catch (error) {
      warnings.push(`${skillPath}: ${error instanceof Error ? error.message : String(error)}`);
      return { entry, hasSkill: false };
    }
  }));
  const bundleNames = new Set(
    bundles.filter((bundle) => bundle.hasSkill).map((bundle) => bundle.entry.name),
  );
  const bundleSkills = new Map<string, SkillEntry>();
  for (const bundle of bundles) {
    if (!bundle.hasSkill) continue;
    let skill: SkillEntry | null;
    try {
      skill = await buildSkillEntry(files, {
        rootPath: join(directoryPath, bundle.entry.name),
        directoryName: bundle.entry.name,
        source,
      });
    } catch (error) {
      warnings.push(`${join(directoryPath, bundle.entry.name, "SKILL.md")}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!skill) continue;
    const qualified = parentSkillName ? qualifySubSkill(skill, parentSkillName) : skill;
    bundleSkills.set(bundle.entry.name, qualified);
    result.push(qualified);
  }

  if (isTopLevel) {
    for (const entry of entries) {
      if (entry.isDirectory || entry.name === "SKILL.md" || !entry.name.endsWith(".md")) continue;
      const flatName = entry.name.slice(0, -3);
      if (bundleNames.has(flatName)) continue;
      let skill: SkillEntry | null;
      try {
        skill = await buildSkillEntry(files, {
          rootPath: directoryPath,
          directoryName: flatName,
          skillFilePath: join(directoryPath, entry.name),
          source,
        });
      } catch (error) {
        warnings.push(`${join(directoryPath, entry.name)}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (skill) result.push(parentSkillName ? qualifySubSkill(skill, parentSkillName) : skill);
    }
  }

  for (const bundle of bundles) {
    if (bundle.hasSkill) {
      const parent = bundleSkills.get(bundle.entry.name);
      if (!parent?.valid || !parent.metadata.hasSubSkill) continue;
      result.push(...await walkSkillDirectory(
        files,
        source,
        join(directoryPath, bundle.entry.name),
        false,
        depth + 1,
        parent.name,
        warnings,
      ));
    } else {
      result.push(...await walkSkillDirectory(
        files,
        source,
        join(directoryPath, bundle.entry.name),
        false,
        depth + 1,
        parentSkillName,
        warnings,
      ));
    }
  }
  return result;
}

function qualifySubSkill(skill: SkillEntry, parentName: string): SkillEntry {
  const name = skill.name === parentName || skill.name.startsWith(`${parentName}.`)
    ? skill.name
    : `${parentName}.${skill.name}`;
  return {
    ...skill,
    name,
    metadata: { ...skill.metadata, name, isSubSkill: true },
  };
}

async function buildSkillEntry(
  files: SkillFileAccess,
  options: {
    rootPath: string;
    directoryName: string;
    skillFilePath?: string;
    source: SkillDiscoveryPath;
  },
): Promise<SkillEntry | null> {
  const skillFilePath = options.skillFilePath ?? join(options.rootPath, "SKILL.md");
  const content = await files.readText(skillFilePath);
  if (!content?.trim()) {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const isFlatFile = options.skillFilePath !== undefined;
  const diagnostics = [
    ...(frontmatter.parseError ? [`Invalid YAML frontmatter: ${frontmatter.parseError}`] : []),
    ...validateSkillFrontmatter(frontmatter.attributes, isFlatFile),
  ];
  const metadata = normalizeMetadata(frontmatter.attributes, options.directoryName, frontmatter.body, isFlatFile);
  const children = options.skillFilePath ? [] : await files.listDir(options.rootPath);

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
    valid: diagnostics.length === 0,
    diagnostics,
  };
}

function validateSkillFrontmatter(
  attributes: Record<string, unknown>,
  isFlatFile: boolean,
): string[] {
  const diagnostics: string[] = [];
  if (!isFlatFile) {
    if (typeof attributes.name !== "string" || !attributes.name.trim()) {
      diagnostics.push("Directory-form Skills require a name in YAML frontmatter.");
    }
    if (typeof attributes.description !== "string" || !attributes.description.trim()) {
      diagnostics.push("Directory-form Skills require a description in YAML frontmatter.");
    }
  }
  if (attributes.type !== undefined) {
    const type = typeof attributes.type === "string" ? attributes.type.trim() : "";
    if (!type || (type !== "prompt" && type !== "inline" && type !== "flow" && type !== "reference")) {
      diagnostics.push(`Unsupported Skill type: ${String(attributes.type)}`);
    }
  }
  return diagnostics;
}

function parseFrontmatter(document: string): {
  hasFrontmatter: boolean;
  attributes: Record<string, unknown>;
  body: string;
  parseError?: string;
} {
  const normalized = document.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return {
      hasFrontmatter: false,
      attributes: {},
      body: document,
    };
  }

  const closingLine = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingLine < 0) {
    return {
      hasFrontmatter: false,
      attributes: {},
      body: normalized,
    };
  }

  const header = lines.slice(1, closingLine).join("\n");
  const body = lines.slice(closingLine + 1).join("\n");
  try {
    const parsed = parseYaml(header, {
      maxAliasCount: 50,
      strict: true,
      uniqueKeys: true,
    }) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { hasFrontmatter: true, attributes: {}, body, parseError: "frontmatter root must be a mapping" };
    }
    return { hasFrontmatter: true, attributes: parsed as Record<string, unknown>, body };
  } catch (error) {
    return {
      hasFrontmatter: true,
      attributes: {},
      body,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeMetadata(
  attributes: Record<string, unknown>,
  directoryName: string,
  body: string,
  isFlatFile: boolean,
): SkillMetadata {
  const rawName = typeof attributes.name === "string" ? attributes.name : directoryName;
  const rawDescription =
    typeof attributes.description === "string" && attributes.description.trim()
      ? attributes.description
      : isFlatFile
        ? firstBodyLine(body)
        : "No description provided.";
  const rawType = typeof attributes.type === "string" ? attributes.type.trim() : "";
  const metadata =
    typeof attributes.metadata === "object" && attributes.metadata !== null && !Array.isArray(attributes.metadata)
      ? Object.fromEntries(
          Object.entries(attributes.metadata).map(([key, value]) => [key, String(value)]),
        )
      : {};
  const nestedMetadata = typeof attributes.metadata === "object"
    && attributes.metadata !== null
    && !Array.isArray(attributes.metadata)
    ? attributes.metadata as Record<string, unknown>
    : {};
  const hasSubSkill = readAliasedStrictBoolean(attributes, ["hasSubSkill", "has-sub-skill"])
    || readAliasedStrictBoolean(nestedMetadata, ["hasSubSkill", "has-sub-skill"]);

  return {
    name: rawName.trim() || directoryName,
    description: normalizeInlineText(rawDescription) || "No description provided.",
    type: rawType === "flow"
      ? "flow"
      : rawType === "inline"
        ? "inline"
        : rawType === "reference"
          ? "reference"
        : rawType === "prompt"
          ? "prompt"
          : "prompt",
    license: typeof attributes.license === "string" ? attributes.license.trim() : "",
    compatibility: typeof attributes.compatibility === "string" ? attributes.compatibility.trim() : "",
    whenToUse: readAliasedString(attributes, ["whenToUse", "when-to-use", "when_to_use"]),
    disableModelInvocation: readAliasedStrictBoolean(attributes, [
      "disableModelInvocation",
      "disable-model-invocation",
      "disable_model_invocation",
    ]),
    arguments: parseSkillArguments(attributes.arguments),
    metadata,
    hasSubSkill,
  };
}

function firstBodyLine(body: string): string {
  return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240)
    ?? "No description provided.";
}

function readAliasedString(
  attributes: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim()) return normalizeInlineText(value);
  }
  return "";
}

function readAliasedStrictBoolean(
  attributes: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.some((key) => attributes[key] === true);
}

function parseSkillArguments(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item).trim())
      .filter(Boolean);
  }
  return value
    .split(/\r?\n|\s+/)
    .map((item) => item.trim().replace(/^[-]+/, ""))
    .filter(Boolean);
}

function buildSummary(skills: SkillEntry[]): SkillsScanSummary {
  return {
    total: skills.length,
    effective: skills.filter((skill) => skill.effective).length,
    overrides: skills.filter((skill) => !skill.effective).length,
    warnings: skills.filter((skill) => skill.valid && !skill.effective).length,
    errors: skills.filter((skill) => !skill.valid).length,
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
          : group === "plugin"
            ? "Plugin"
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

function normalizeInlineText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
