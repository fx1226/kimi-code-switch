import { scanSkills } from "./skillsStore";

describe("skillsStore", () => {
  it("discovers the existing user-level directories by default", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/writer/SKILL.md": `---
name: writer
description: Writing helper
---
# Writer
`,
      "~/.agents/skills/reviewer/SKILL.md": `---
name: reviewer
description: Review helper
---
# Reviewer
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: false,
    });

    expect(report.discoveryMode).toBe("auto");
    expect(report.paths.find((entry) => entry.id === "user-brand-kimi")?.selected).toBe(true);
    expect(report.paths.find((entry) => entry.id === "user-common-agents")?.selected).toBe(true);
    expect(report.skills.map((skill) => skill.name)).toEqual(["writer", "reviewer"]);
    expect(report.skills.find((skill) => skill.name === "writer")?.enabled).toBe(true);
    expect(report.skills.find((skill) => skill.name === "reviewer")?.enabled).toBe(true);
  });

  it("does not scan legacy claude/codex/config-agents directories", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/planner/SKILL.md": `---
name: planner
description: Plan helper
---
# Planner
`,
      "~/.claude/skills/reviewer/SKILL.md": `---
name: reviewer
description: Review helper
---
# Reviewer
`,
      "~/.codex/skills/builder/SKILL.md": `---
name: builder
description: Build helper
---
# Builder
`,
      "~/.config/agents/skills/legacy/SKILL.md": `---
name: legacy
description: Legacy common helper
---
# Legacy
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
    });

    expect(report.paths.some((entry) => entry.id === "user-brand-claude")).toBe(false);
    expect(report.paths.some((entry) => entry.id === "user-brand-codex")).toBe(false);
    expect(report.paths.some((entry) => entry.id === "user-common-config")).toBe(false);
    expect(report.skills.map((skill) => skill.name)).toEqual(["planner"]);
  });

  it("prefers KIMI_CODE_HOME user skills over the legacy default home", async () => {
    const files = createMemorySkillFs({
      "~/.custom-kimi-home/skills/custom/SKILL.md": `---
name: custom
description: Custom home helper
---
# Custom
`,
      "~/.kimi-code/skills/default-home/SKILL.md": `---
name: default-home
description: Default home helper
---
# Default
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: false,
      envHome: "~/.custom-kimi-home",
    });

    expect(report.paths.find((entry) => entry.id === "user-brand-kimi")?.path).toBe("~/.custom-kimi-home/skills");
    expect(report.paths.find((entry) => entry.id === "user-brand-kimi")?.selected).toBe(true);
    expect(report.skills.map((skill) => skill.name)).toEqual(["custom"]);
  });

  it("merges all available brand directories when enabled", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/planner/SKILL.md": `---
name: planner
description: Plan helper
---
# Planner
`,
      "~/.agents/skills/reviewer/SKILL.md": `---
name: reviewer
description: Review helper
---
# Reviewer
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
    });

    // brand/common 组始终各自加载可用的目录，不受 merge 开关影响
    expect(report.paths.filter((entry) => entry.selected).map((entry) => entry.id)).toEqual([
      "user-brand-kimi",
      "user-common-agents",
    ]);
    expect(report.summary.total).toBe(2);
  });

  it("loads project-level skills from workspace roots", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/user-skill/SKILL.md": `---
name: user-skill
description: User level
---
# User
`,
      "/work/alpha/.kimi-code/skills/project-a/SKILL.md": `---
name: project-a
description: Project A helper
---
# Project A
`,
      "/work/alpha/.agents/skills/project-agents/SKILL.md": `---
name: project-agents
description: Agents helper
---
# Agents
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      projectRoots: ["/work/alpha"],
      readJson: async () => null,
    });

    const projectKimi = report.paths.find((entry) => entry.id === "project--work-alpha-kimi");
    expect(projectKimi?.group).toBe("project");
    expect(projectKimi?.path).toBe("/work/alpha/.kimi-code/skills");
    expect(projectKimi?.selected).toBe(true);
    const projectAgents = report.paths.find((entry) => entry.id === "project--work-alpha-agents");
    expect(projectAgents?.group).toBe("project");
    expect(projectAgents?.path).toBe("/work/alpha/.agents/skills");
    expect(projectAgents?.selected).toBe(true);
    // 同根下两个目录都加载，相互不互斥；用户级目录也照常加载
    const projectSkillNames = report.skills
      .filter((skill) => skill.sourceGroup === "project")
      .map((skill) => skill.name)
      .sort();
    expect(projectSkillNames).toEqual(["project-a", "project-agents"]);
    expect(report.skills.map((skill) => skill.name).sort()).toEqual(["project-a", "project-agents", "user-skill"]);
  });

  it("keeps project skills effective ahead of user-level when names collide", async () => {
    const files = createMemorySkillFs({
      "/work/alpha/.kimi-code/skills/reviewer/SKILL.md": `---
name: reviewer
description: Project reviewer
---
# Reviewer
`,
      "~/.kimi-code/skills/reviewer/SKILL.md": `---
name: reviewer
description: User reviewer
---
# Reviewer
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      projectRoots: ["/work/alpha"],
      readJson: async () => null,
    });

    const projectSkill = report.skills.find((skill) => skill.sourceGroup === "project");
    const userSkill = report.skills.find((skill) => skill.sourceGroup === "user-brand");
    expect(projectSkill?.effective).toBe(true);
    expect(userSkill?.effective).toBe(false);
    expect(userSkill?.overriddenBy).toContain("reviewer");
  });

  it("appends extra_skill_dirs paths", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/user-skill/SKILL.md": `---
name: user-skill
description: User level
---
# User
`,
      "/opt/shared-skills/skill-a/SKILL.md": `---
name: skill-a
description: Extra helper
---
# Extra
`,
      "~/team-skills/skill-b/SKILL.md": `---
name: skill-b
description: Team helper
---
# Team
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      extraSkillDirs: ["/opt/shared-skills", "~/team-skills"],
    });

    const extra = report.paths.filter((entry) => entry.group === "extra");
    expect(extra.map((entry) => entry.id)).toContain("extra--opt-shared-skills");
    expect(extra.map((entry) => entry.id)).toContain("extra---team-skills");
    expect(report.skills.map((skill) => skill.name).sort()).toEqual(["skill-a", "skill-b", "user-skill"]);
  });

  it("parses workspaces.json to derive project roots", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/user-skill/SKILL.md": `---
name: user-skill
description: User level
---
# User
`,
      "/repo/one/.kimi-code/skills/one/SKILL.md": `---
name: one
description: First workspace
---
# One
`,
      "/repo/two/.kimi-code/skills/two/SKILL.md": `---
name: two
description: Second workspace
---
# Two
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      readJson: async (path) =>
        path === "~/.kimi-code/workspaces.json"
          ? JSON.stringify({
              version: 1,
              workspaces: {
                one: { root: "/repo/one", name: "One" },
                two: { root: "/repo/two", name: "Two" },
              },
            })
          : null,
    });

    expect(report.paths.filter((entry) => entry.group === "project").map((entry) => entry.path))
      .toEqual(["/repo/one/.kimi-code/skills", "/repo/one/.agents/skills", "/repo/two/.kimi-code/skills", "/repo/two/.agents/skills"]);
    expect(report.skills.map((skill) => skill.name).sort()).toEqual(["one", "two", "user-skill"]);
  });

  it("reads user skills and workspaces from a custom KIMI_CODE_HOME", async () => {
    const files = createMemorySkillFs({
      "/custom/kimi-home/skills/custom-user/SKILL.md": `---
name: custom-user
description: Custom environment user skill
---
# Custom User
`,
      "/repo/custom/.kimi-code/skills/custom-project/SKILL.md": `---
name: custom-project
description: Custom environment project skill
---
# Custom Project
`,
    });
    const requestedJsonPaths: string[] = [];

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      envHome: "/custom/kimi-home",
      readJson: async (path) => {
        requestedJsonPaths.push(path);
        return path === "/custom/kimi-home/workspaces.json"
          ? JSON.stringify({ workspaces: { custom: { root: "/repo/custom" } } })
          : null;
      },
    });

    expect(requestedJsonPaths).toEqual(["/custom/kimi-home/workspaces.json"]);
    expect(report.skills.map((skill) => skill.name).sort()).toEqual(["custom-project", "custom-user"]);
  });

  it("marks later duplicate skills as overridden based on discovery priority", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/reviewer/SKILL.md": `---
name: reviewer
description: Preferred reviewer
---
# Reviewer
`,
      "~/.agents/skills/reviewer/SKILL.md": `---
name: reviewer
description: Secondary reviewer
---
# Reviewer
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
    });

    const effective = report.skills.find((skill) => skill.sourceLabel.includes("~/.kimi-code/skills"));
    const overridden = report.skills.find((skill) => skill.sourceLabel.includes("~/.agents/skills"));

    expect(effective?.effective).toBe(true);
    expect(overridden?.effective).toBe(false);
    expect(overridden?.overriddenBy).toContain("reviewer");
  });

  it("ignores removed custom directory settings and keeps auto discovery", async () => {
    const files = createMemorySkillFs({
      "/tmp/custom-skills/custom-writer/SKILL.md": `---
name: custom-writer
description: Custom directory
---
# Custom
`,
      "~/.kimi-code/skills/ignored/SKILL.md": `---
name: ignored
description: Should not load
---
# Ignored
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
    });

    expect(report.discoveryMode).toBe("auto");
    expect(report.skills.map((skill) => skill.name)).toEqual(["ignored"]);
    expect(report.skills.find((skill) => skill.name === "ignored")?.enabled).toBe(true);
  });

  it("still infers flow skills from frontmatter and diagram content", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/flow-helper/SKILL.md": `---
name: FlowHelper
type: flow
---
# Flow Helper

\`\`\`mermaid
graph TD
BEGIN --> middle
\`\`\`
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: false,
    });

    expect(report.skills[0]?.metadata.type).toBe("flow");
    expect(report.summary.warnings).toBe(0);
    expect(report.summary.errors).toBe(0);
  });

  it("parses multiline block scalar descriptions into a readable summary", async () => {
    const files = createMemorySkillFs({
      "~/.agents/skills/pdf-parser/SKILL.md": `---
name: pdf-parser
description: |
  Pdf Parser - Auto-activating skill for Business Automation.
  Triggers on: pdf parser, pdf parser
  Part of the Business Automation skill category.
---
# Pdf Parser
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: false,
    });

    expect(report.skills[0]?.metadata.description).toBe(
      "Pdf Parser - Auto-activating skill for Business Automation. Triggers on: pdf parser, pdf parser Part of the Business Automation skill category.",
    );
  });

  it("parses indented multiline descriptions without block scalar markers", async () => {
    const files = createMemorySkillFs({
      "~/.agents/skills/code-reviewer/SKILL.md": `---
name: code-reviewer
description:
  Use this skill to review code. It supports both local changes (staged or working tree)
  and remote Pull Requests (by ID or URL). It focuses on correctness, maintainability,
  and adherence to project standards.
---
# Code Reviewer
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: false,
    });

    expect(report.skills[0]?.metadata.description).toBe(
      "Use this skill to review code. It supports both local changes (staged or working tree) and remote Pull Requests (by ID or URL). It focuses on correctness, maintainability, and adherence to project standards.",
    );
  });

  it("marks same-name common skills as not effective when the brand already loads them", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/reviewer/SKILL.md": `---
name: reviewer
description: Preferred reviewer
---
# Reviewer
`,
      "~/.agents/skills/reviewer/SKILL.md": `---
name: reviewer
description: Visible but secondary
---
# Reviewer
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: false,
    });

    const enabled = report.skills.find((skill) => skill.sourceLabel.includes("~/.kimi-code/skills"));
    const secondary = report.skills.find((skill) => skill.sourceLabel.includes("~/.agents/skills"));

    expect(enabled?.enabled).toBe(true);
    expect(enabled?.effective).toBe(true);
    expect(secondary?.enabled).toBe(true);
    expect(secondary?.effective).toBe(false);
    expect(secondary?.overriddenBy).toContain("reviewer");
  });
});

function createMemorySkillFs(files: Record<string, string>) {
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, content]) => [normalizePath(path), content]),
  );
  const directories = new Set<string>();

  for (const path of normalizedFiles.keys()) {
    let current = dirname(path);
    while (current && !directories.has(current)) {
      directories.add(current);
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return {
    async readText(path: string): Promise<string | null> {
      return normalizedFiles.get(normalizePath(path)) ?? null;
    },
    async listDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
      const normalized = normalizePath(path);
      const children = new Map<string, boolean>();

      for (const directory of directories) {
        if (!isDirectChild(normalized, directory)) {
          continue;
        }
        children.set(directory.slice(normalized.length + (normalized === "~" ? 2 : 1)), true);
      }

      for (const file of normalizedFiles.keys()) {
        const parent = dirname(file);
        if (parent !== normalized) {
          continue;
        }
        children.set(file.slice(parent.length + 1), false);
      }

      return [...children.entries()]
        .filter(([name]) => name.length > 0)
        .map(([name, isDirectory]) => ({ name, isDirectory }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    async pathExists(path: string): Promise<boolean> {
      const normalized = normalizePath(path);
      return directories.has(normalized) || normalizedFiles.has(normalized);
    },
  };
}

function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/$/, "");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "~" || normalized === "/") {
    return normalized;
  }
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return normalized.startsWith("~") ? "~" : "/";
  }
  return normalized.slice(0, index);
}

function isDirectChild(parent: string, child: string): boolean {
  if (!child.startsWith(parent === "/" ? "/" : `${parent}/`)) {
    return false;
  }
  const remainder = child.slice(parent === "/" ? 1 : parent.length + 1);
  return remainder.length > 0 && !remainder.includes("/");
}
