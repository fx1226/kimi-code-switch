import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SkillEntry, SkillsScanReport } from "@shared/skillsStore";

import { SkillsWorkspace } from "./skillsWorkspace";

function skill(index: number): SkillEntry {
  return {
    id: `skill-${index}`,
    name: `Skill ${index}`,
    sourcePathId: "user",
    directoryName: `skill-${index}`,
    directoryPath: `/skills/skill-${index}`,
    skillFilePath: `/skills/skill-${index}/SKILL.md`,
    sourceLabel: "User",
    sourceGroup: "user",
    priority: index,
    enabled: true,
    effective: true,
    frontmatter: true,
    metadata: {
      name: `Skill ${index}`,
      description: `Description ${index}`,
      license: "",
      compatibility: "",
      type: "skill",
      whenToUse: "",
      disableModelInvocation: false,
      arguments: [],
      metadata: {},
      hasSubSkill: false,
    },
    content: "# Skill",
    lineCount: 1,
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
    valid: true,
    diagnostics: [],
  };
}

describe("SkillsWorkspace", () => {
  it("keeps every matching skill reachable through natural scrolling rather than pagination", () => {
    const skills = Array.from({ length: 14 }, (_, index) => skill(index + 1));
    const { getAllByRole, getByRole, queryByRole } = render(
      <SkillsWorkspace
        locale="en-US"
        report={{} as SkillsScanReport}
        selectedPath={null}
        visibleSkills={skills}
        selectedSkill={null}
        viewMode="grid"
        onViewModeChange={vi.fn()}
        onSelectSkill={vi.fn()}
        isLoading={false}
      />,
    );

    expect(getAllByRole("listitem")).toHaveLength(14);
    expect(queryByRole("button", { name: /previous page/i })).toBeNull();
    expect(queryByRole("button", { name: /next page/i })).toBeNull();

    fireEvent.change(getByRole("searchbox"), { target: { value: "Skill 14" } });
    expect(getAllByRole("listitem")).toHaveLength(1);
  });
});
