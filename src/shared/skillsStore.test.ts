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

  it("resolves relative extra_skill_dirs from the nearest Git project root", async () => {
    const files = createMemorySkillFs({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.agents/team/review/SKILL.md": `---
name: team-review
description: Team review
---
# Team review
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      projectWorkingDirectory: "/repo/packages/app",
      extraSkillDirs: [".agents/team"],
    });

    expect(report.paths.find((entry) => entry.group === "extra")?.path).toBe("/repo/.agents/team");
    expect(report.skills.some((skill) => skill.name === "team-review")).toBe(true);
  });

  it("realpath-deduplicates extra_skill_dirs aliases like the official catalog", async () => {
    const base = createMemorySkillFs({
      "/real/team/review/SKILL.md": `---
name: review
description: Review
---
`,
      "/alias/team/placeholder.txt": "alias",
    });
    const files = {
      ...base,
      async realPath(path: string) {
        return path === "/alias/team" ? "/real/team" : path;
      },
    };

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      extraSkillDirs: ["/alias/team", "/real/team"],
    });

    expect(report.paths.filter((entry) => entry.group === "extra")).toHaveLength(1);
    expect(report.skills.filter((skill) => skill.name === "review")).toHaveLength(1);
  });

  it("keeps user-brand display path logical while deduping by the resolved physical path", async () => {
    const physicalSkills = "/Users/demo/.kimi-code-switch-gui/.env/default/skills";
    const base = createMemorySkillFs({
      "~/.kimi-code/skills/writer/SKILL.md": `---
name: writer
description: Writer
---
# Writer
`,
    });
    const files = {
      ...base,
      async realPath(path: string) {
        return path === "~/.kimi-code/skills" ? physicalSkills : path;
      },
    };

    const report = await scanSkills(files, { mergeAllAvailableSkills: false });

    const brand = report.paths.find((entry) => entry.group === "user-brand");
    expect(brand?.path).toBe("~/.kimi-code/skills");
    expect(brand?.resolvedPath).toBe(physicalSkills);
    expect(brand?.label).toBe("User Brand · ~/.kimi-code/skills");
    // 展示路径保持逻辑形式的同时，扫描仍能通过逻辑路径读到技能内容。
    expect(report.skills.map((skill) => skill.name)).toEqual(["writer"]);
    expect(report.skills[0]?.sourcePathId).toBe("user-brand-kimi");
  });

  it("loads enabled plugin skill roots in extra scope with plugin identity", async () => {
    const files = createMemorySkillFs({
      "/plugins/demo/skills/review/SKILL.md": `---
name: plugin-review
description: Plugin reviewer
---
# Review
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      pluginSkillRoots: [{ pluginId: "demo", path: "/plugins/demo/skills" }],
    });

    const path = report.paths.find((entry) => entry.group === "plugin");
    expect(path).toMatchObject({ pluginId: "demo", selected: true });
    expect(report.skills.find((skill) => skill.name === "plugin-review")?.sourceGroup).toBe("plugin");
  });

  it("gives explicit extra Skills priority over same-name plugin Skills", async () => {
    const files = createMemorySkillFs({
      "/extra/review/SKILL.md": `---
name: shared-review
description: Extra reviewer
---
# Extra
`,
      "/plugins/demo/review/SKILL.md": `---
name: shared-review
description: Plugin reviewer
---
# Plugin
`,
    });
    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      extraSkillDirs: ["/extra"],
      pluginSkillRoots: [{ pluginId: "demo", path: "/plugins/demo" }],
    });
    expect(report.skills.find((skill) => skill.sourceGroup === "extra")?.effective).toBe(true);
    expect(report.skills.find((skill) => skill.sourceGroup === "plugin")?.effective).toBe(false);
  });

  it("recursively discovers categorized Skills and gated dotted sub-skills", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/category/deploy/SKILL.md": `---
name: deploy
description: Deploy workflow
---
# Deploy
`,
      "~/.kimi-code/skills/parent/SKILL.md": `---
name: parent
description: Parent workflow
has-sub-skill: true
---
# Parent
`,
      "~/.kimi-code/skills/parent/review/SKILL.md": `---
name: review
description: Child review
---
# Review
`,
      "~/.kimi-code/skills/no-children/SKILL.md": `---
name: no-children
description: No child loading
---
# Parent
`,
      "~/.kimi-code/skills/no-children/hidden/SKILL.md": `---
name: hidden
description: Hidden child
---
# Hidden
`,
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills.map((skill) => skill.name)).toEqual(expect.arrayContaining([
      "deploy",
      "parent",
      "parent.review",
      "no-children",
    ]));
    expect(report.skills.map((skill) => skill.name)).not.toContain("hidden");
    expect(report.skills.find((skill) => skill.name === "parent.review")?.metadata.isSubSkill).toBe(true);
  });

  it("does not enable sub-skills from a string-valued has-sub-skill flag", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/parent/SKILL.md": `---
name: parent
description: Parent
has-sub-skill: "true"
---
`,
      "~/.kimi-code/skills/parent/child/SKILL.md": `---
name: child
description: Child
---
`,
    });
    const report = await scanSkills(files, { mergeAllAvailableSkills: true });
    expect(report.skills.map((skill) => skill.name)).toEqual(["parent"]);
  });

  it("walks upward from the active working directory to the nearest Git project", async () => {
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
      "/repo/one/.git/HEAD": "ref: refs/heads/main",
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      projectWorkingDirectory: "/repo/one/packages/app",
    });

    expect(report.paths.filter((entry) => entry.group === "project").map((entry) => entry.path))
      .toEqual(["/repo/one/.kimi-code/skills", "/repo/one/.agents/skills"]);
    expect(report.skills.map((skill) => skill.name).sort()).toEqual(["one", "user-skill"]);
  });

  it("normalizes Windows working directories before locating the nearest Git root", async () => {
    const files = createMemorySkillFs({
      "C:/repo/.git/HEAD": "ref: refs/heads/main",
      "C:/repo/.kimi-code/skills/windows/SKILL.md": `---
name: windows
description: Windows project skill
---
# Windows
`,
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      projectWorkingDirectory: "C:\\repo\\packages\\app",
    });

    expect(report.paths.find((entry) => entry.id === "project-C:-repo-kimi")?.selected).toBe(true);
    expect(report.skills.map((skill) => skill.name)).toContain("windows");
  });

  it("falls back to the working directory when no Git ancestor exists", async () => {
    const files = createMemorySkillFs({
      "/workspace/no-git/.kimi-code/skills/local/SKILL.md": `---
name: local
description: Local project skill
---
# Local
`,
    });
    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      projectWorkingDirectory: "/workspace/no-git",
    });
    expect(report.skills.map((skill) => skill.name)).toContain("local");
  });

  it("reads user skills from a custom KIMI_CODE_HOME without a workspace registry", async () => {
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
      "/repo/custom/.git/HEAD": "ref: refs/heads/main",
    });

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      envHome: "/custom/kimi-home",
      projectWorkingDirectory: "/repo/custom/packages/app",
    });

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
description: Flow helper
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

  it("does not override an explicit prompt type merely because the body contains a diagram", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/diagram/SKILL.md": `---
name: diagram
description: Diagram prompt
type: prompt
---

\`\`\`mermaid
graph TD
A --> B
\`\`\`
`,
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills[0]?.metadata.type).toBe("prompt");
  });

  it("does not infer flow type from diagrams when frontmatter omits type", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/diagram/SKILL.md": `---
name: diagram
description: Diagram prompt
---

\`\`\`mermaid
graph TD
A --> B
\`\`\`
`,
    });
    const report = await scanSkills(files, { mergeAllAvailableSkills: true });
    expect(report.skills[0]?.metadata.type).toBe("prompt");
  });

  it("accepts reference type but rejects case-shifted type values", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/reference/SKILL.md": `---
name: reference
description: Reference material
type: reference
---
`,
      "~/.kimi-code/skills/uppercase/SKILL.md": `---
name: uppercase
description: Invalid uppercase type
type: PROMPT
---
`,
      "~/.kimi-code/skills/non-string/SKILL.md": `---
name: non-string
description: Invalid non-string type
type: 123
---
`,
    });
    const report = await scanSkills(files, { mergeAllAvailableSkills: true });
    expect(report.skills.find((skill) => skill.name === "reference")).toMatchObject({
      valid: true,
      metadata: { type: "reference" },
    });
    expect(report.skills.find((skill) => skill.name === "uppercase")?.valid).toBe(false);
    expect(report.skills.find((skill) => skill.name === "non-string")?.valid).toBe(false);
  });

  it("does not coerce disable-model-invocation strings to booleans", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/strict/SKILL.md": `---
name: strict
description: Strict boolean
disable-model-invocation: "true"
---
`,
    });
    const report = await scanSkills(files, { mergeAllAvailableSkills: true });
    expect(report.skills[0]?.metadata.disableModelInvocation).toBe(false);
  });

  it("parses official invocation metadata and aliases", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/release/SKILL.md": `---
name: release
description: Prepare a release
type: inline
when-to-use: When the user asks for a release
disable_model_invocation: true
arguments:
  - version
  - channel
---
# Release
`,
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });
    const metadata = report.skills[0]?.metadata;

    expect(metadata).toMatchObject({
      type: "inline",
      whenToUse: "When the user asks for a release",
      disableModelInvocation: true,
      arguments: ["version", "channel"],
    });
  });

  it("accepts trimmed frontmatter fences and a closing fence at EOF", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/fenced/SKILL.md": "  ---  \nname: fenced\ndescription: Trimmed fences\n  ---  ",
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });
    const skill = report.skills.find((entry) => entry.name === "fenced");
    expect(skill).toMatchObject({ valid: true, frontmatter: true });
  });

  it("keeps scanning healthy roots when another Skill root cannot be read", async () => {
    const base = createMemorySkillFs({
      "~/.kimi-code/skills/healthy/SKILL.md": `---
name: healthy
description: Healthy skill
---
`,
      "/broken/placeholder.txt": "x",
    });
    const files = {
      ...base,
      async listDir(path: string) {
        if (path === "/broken") throw new Error("permission denied");
        return base.listDir(path);
      },
    };

    const report = await scanSkills(files, {
      mergeAllAvailableSkills: true,
      extraSkillDirs: ["/broken"],
    });

    expect(report.skills.map((skill) => skill.name)).toContain("healthy");
    expect(report.paths.find((entry) => entry.path === "/broken")?.reason).toContain("permission denied");
  });

  it("parses inline YAML argument arrays", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/inline/SKILL.md": `---
name: inline
description: Inline arguments
arguments: [target, "release channel"]
---
# Inline
`,
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills[0]?.metadata.arguments).toEqual(["target", "release channel"]);
  });

  it("filters non-string YAML arguments without invalidating the Skill", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/invalid-args/SKILL.md": `---
name: invalid-args
description: Invalid arguments
arguments: [target, { nested: value }]
---
# Invalid
`,
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills[0].valid).toBe(true);
    expect(report.skills[0].diagnostics).toEqual([]);
    expect(report.skills[0].metadata.arguments).toEqual(["target"]);
  });

  it("allows a valid flat Skill when a same-name directory has no valid SKILL.md", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/reviewer.md": `---
description: Flat reviewer
---
# Flat Reviewer
`,
      "~/.kimi-code/skills/reviewer/README.md": "not a skill",
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills.map((skill) => skill.name)).toEqual(["reviewer"]);
    expect(report.skills[0]?.skillFilePath).toBe("~/.kimi-code/skills/reviewer.md");
  });

  it("keeps invalid directory skills visible as diagnostics instead of inventing metadata", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/broken/SKILL.md": `---
type: unsupported
---
# Broken
`,
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills[0]?.valid).toBe(false);
    expect(report.skills[0]?.effective).toBe(false);
    expect(report.skills[0]?.diagnostics).toHaveLength(3);
    expect(report.summary.errors).toBe(1);
  });

  it("does not silently activate a flat fallback when a same-name directory Skill is invalid", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/reviewer/SKILL.md": `---
type: unsupported
---
# Broken directory reviewer
`,
      "~/.kimi-code/skills/reviewer.md": `---
description: Flat fallback
---
# Flat Reviewer
`,
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills).toHaveLength(1);
    expect(report.skills[0].skillFilePath).toContain("reviewer/SKILL.md");
    expect(report.skills[0].valid).toBe(false);
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

  it("loads lowercase .md files and keeps directory shadow checks case-sensitive", async () => {
    const files = createMemorySkillFs({
      "~/.kimi-code/skills/release-notes.md": `---
description: Flat release flow
type: flow
---
# Release
`,
      "~/.kimi-code/skills/Reviewer.md": `---
description: Flat reviewer
type: inline
---
# Flat Reviewer
`,
      "~/.kimi-code/skills/reviewer/SKILL.md": `---
name: reviewer
description: Directory reviewer
type: prompt
---
# Directory Reviewer
`,
      "~/.kimi-code/skills/ignored.MD": "# Uppercase extension is not a flat Skill",
    });

    const report = await scanSkills(files, { mergeAllAvailableSkills: true });

    expect(report.skills.map((skill) => skill.name).sort()).toEqual(["Reviewer", "release-notes", "reviewer"]);
    expect(report.skills.find((skill) => skill.name === "release-notes")?.metadata.type).toBe("flow");
    expect(report.skills.find((skill) => skill.name === "reviewer")?.metadata.description).toBe("Directory reviewer");
    expect(report.skills.find((skill) => skill.name === "Reviewer")?.effective).toBe(false);
    expect(report.skills.map((skill) => skill.name)).not.toContain("ignored");
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
