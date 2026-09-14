import { useState } from "react";
import { Code2, Eye, LayoutGrid, List, X } from "lucide-react";

import type { SkillEntry, SkillsScanReport } from "@shared/skillsStore";
import type { Locale } from "@shared/types";

import { CodePanel } from "./codePanel";
import { MarkdownView } from "./markdownView";
import { t } from "./i18n";
import { DialogShell } from "./dialogs";

export type SkillsViewMode = "grid" | "list";

export function SkillsWorkspace(props: {
  locale: Locale;
  report: SkillsScanReport | null;
  selectedPath: SkillsScanReport["paths"][number] | null;
  visibleSkills: SkillEntry[];
  selectedSkill: SkillEntry | null;
  viewMode: SkillsViewMode;
  onViewModeChange: (mode: SkillsViewMode) => void;
  onSelectSkill: (skillId: string) => void;
  isLoading: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredSkills = normalizedQuery
    ? props.visibleSkills.filter((skill) => {
        const name = skill.name.toLowerCase();
        const description = skill.metadata.description.toLowerCase();
        return name.includes(normalizedQuery) || description.includes(normalizedQuery);
      })
    : props.visibleSkills;

  const handleCopy = (): void => {
    if (!props.selectedSkill) {
      return;
    }
    void navigator.clipboard.writeText(props.selectedSkill.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  if (props.isLoading && !props.report) {
    return (
      <section className="glass-panel form-panel empty-state">
        <div className="section-title">{t(props.locale, "skills")}</div>
        <p>{t(props.locale, "skillsLoading")}</p>
      </section>
    );
  }

  if (!props.report) {
    return (
      <section className="glass-panel form-panel empty-state">
        <div className="section-title">{t(props.locale, "skills")}</div>
        <p>{t(props.locale, "skillsEmpty")}</p>
      </section>
    );
  }

  return (
    <section className="skills-workspace">
      <section className="glass-panel form-panel skills-overview-panel">
        <div className="skills-detail-header">
          <div className="skills-header-main">
            <div className="section-title">{t(props.locale, "skills")}</div>
            <div className="skills-path-caption">{props.selectedPath?.path ?? t(props.locale, "overviewNone")}</div>
          </div>
          <div className="skills-detail-badges">
            <div className="skills-view-toggle" aria-label={t(props.locale, "skillsViewMode")}>
              <button
                className={props.viewMode === "grid" ? "skills-view-button active" : "skills-view-button"}
                type="button"
                aria-label={t(props.locale, "skillsViewGrid")}
                onClick={() => props.onViewModeChange("grid")}
                aria-pressed={props.viewMode === "grid"}
                title={t(props.locale, "skillsViewGrid")}
              >
                <LayoutGrid size={15} />
              </button>
              <button
                className={props.viewMode === "list" ? "skills-view-button active" : "skills-view-button"}
                type="button"
                aria-label={t(props.locale, "skillsViewList")}
                onClick={() => props.onViewModeChange("list")}
                aria-pressed={props.viewMode === "list"}
                title={t(props.locale, "skillsViewList")}
              >
                <List size={15} />
              </button>
            </div>
          </div>
        </div>

        <label className="skills-search-field">
          <input
            type="search"
            value={searchQuery}
            aria-label={t(props.locale, "skillsSearchPlaceholder")}
            placeholder={t(props.locale, "skillsSearchPlaceholder")}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>

        {props.selectedPath && !isSkillPathLoaded(props.selectedPath) ? (
          <p className="skills-note skills-note-warning">{formatSkillPathNotice(props.locale, props.selectedPath)}</p>
        ) : null}

        {filteredSkills.length ? (
            <div
              className={props.viewMode === "grid" ? "skills-read-grid" : "skills-read-list"}
              role="list"
            >
              {filteredSkills.map((skill) => (
                <div key={skill.id} role="listitem" className="skills-read-list-item">
                  <button
                  className={[
                    props.viewMode === "grid" ? "skills-read-card" : "skills-read-row",
                    skill.id === props.selectedSkill?.id ? "active" : "",
                    skill.enabled ? "is-enabled" : "is-disabled",
                    skill.effective ? "" : "muted",
                  ].filter(Boolean).join(" ")}
                  type="button"
                  onClick={() => props.onSelectSkill(skill.id)}
                >
                  <div className={props.viewMode === "grid" ? "skills-read-card-top" : "skills-read-row-main"}>
                    <div className="skills-read-row-header">
                      <span className="list-current-badge">{skill.metadata.type}</span>
                      <strong>{skill.name}</strong>
                    </div>
                    <p>{skill.metadata.description}</p>
                    {props.viewMode === "list" ? (
                      <div className="skills-read-row-folder">{skill.directoryName}</div>
                    ) : null}
                  </div>
                  {props.viewMode === "grid" ? (
                    <div className="skills-read-card-meta">
                      <div className="skills-read-row-folder">{skill.directoryName}</div>
                    </div>
                  ) : null}
                </button>
                </div>
              ))}
            </div>
        ) : props.visibleSkills.length ? (
          <div className="skills-empty-issues">{t(props.locale, "skillsEmptySearch")}</div>
        ) : (
          <div className="skills-empty-issues">{t(props.locale, "skillsEmptyInDirectory")}</div>
        )}
      </section>
      {props.selectedSkill ? (
        <SkillsDetailDialog
          locale={props.locale}
          skill={props.selectedSkill}
          copied={copied}
          onCopy={handleCopy}
          onClose={() => props.onSelectSkill("")}
        />
      ) : null}
    </section>
  );
}

function SkillsDetailDialog(props: {
  locale: Locale;
  skill: SkillEntry;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}): JSX.Element {
  const [viewSource, setViewSource] = useState(false);
  const detailItems = [
    { label: t(props.locale, "skillsSource"), value: props.skill.sourceLabel },
    { label: t(props.locale, "skillsDirectory"), value: props.skill.directoryPath },
    { label: t(props.locale, "skillsFrontmatter"), value: props.skill.frontmatter ? t(props.locale, "overviewOn") : t(props.locale, "overviewOff") },
    { label: t(props.locale, "skillsLineCount"), value: String(props.skill.lineCount) },
    { label: t(props.locale, "skillsAttachments"), value: formatSkillAssets(props.locale, props.skill) },
    ...(props.skill.overriddenBy
      ? [{ label: t(props.locale, "skillsOverrideTarget"), value: props.skill.overriddenBy }]
      : []),
    ...(props.skill.metadata.license
      ? [{ label: t(props.locale, "skillsLicense"), value: props.skill.metadata.license }]
      : []),
    ...(props.skill.metadata.compatibility
      ? [{ label: t(props.locale, "skillsCompatibility"), value: props.skill.metadata.compatibility }]
      : []),
    ...(Object.keys(props.skill.metadata.metadata).length > 0
      ? [{
          label: t(props.locale, "skillsMetadata"),
          value: Object.entries(props.skill.metadata.metadata).map(([key, value]) => `${key}: ${value}`).join(" · "),
        }]
      : []),
  ];

  return (
    <DialogShell
      backdropClassName="skills-detail-dialog-backdrop"
      dialogClassName="skills-detail-dialog glass-panel"
      ariaLabelledBy="skills-detail-dialog-title"
      onClose={props.onClose}
    >
        <div className="skills-detail-dialog-header">
          <div className="skills-detail-dialog-copy">
            <div className="skills-detail-dialog-title-row">
              <span className="list-current-badge">{props.skill.metadata.type}</span>
              <h3 id="skills-detail-dialog-title">{props.skill.name}</h3>
            </div>
            {props.skill.metadata.description ? (
              <p className="skills-detail-dialog-description">{props.skill.metadata.description}</p>
            ) : null}
          </div>
          <div className="document-viewer-actions">
            <button className="action-button compact icon-only" type="button" aria-label={t(props.locale, "close")} onClick={props.onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="skills-detail-summary-grid">
          {detailItems.map((item) => (
            <div
              key={`${item.label}-${item.value}`}
              className={[
                "skills-kv",
                "skills-kv-compact",
                item.value.includes(" · ") || item.value.includes(": ") ? "skills-kv-multiline" : "",
              ].filter(Boolean).join(" ")}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>

        {(() => {
          const toggleLabel = t(props.locale, viewSource ? "viewRendered" : "viewSource");
          const toggleButton = (
            <button
              className="code-head-copy"
              type="button"
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={() => setViewSource((prev) => !prev)}
            >
              {viewSource ? <Eye size={15} /> : <Code2 size={15} />}
            </button>
          );
          return viewSource ? (
            <CodePanel
              title={props.skill.skillFilePath}
              content={props.skill.content}
              locale={props.locale}
              onCopy={props.onCopy}
              copied={props.copied}
              headerExtra={toggleButton}
            />
          ) : (
            <MarkdownView
              title={props.skill.skillFilePath}
              content={props.skill.content}
              locale={props.locale}
              onCopy={props.onCopy}
              copied={props.copied}
              headerExtra={toggleButton}
            />
          );
        })()}
    </DialogShell>
  );
}

function formatSkillAssets(locale: Locale, skill: SkillEntry): string {
  const labels = [
    skill.hasScripts ? "scripts" : "",
    skill.hasReferences ? "references" : "",
    skill.hasAssets ? "assets" : "",
  ].filter(Boolean);
  return labels.join(" · ") || t(locale, "overviewNone");
}

function isSkillPathLoaded(path: SkillsScanReport["paths"][number]): boolean {
  return path.group !== "builtin" && path.exists && path.selected;
}

function formatSkillPathNotice(locale: Locale, path: SkillsScanReport["paths"][number]): string {
  if (path.group === "builtin") {
    return t(locale, "skillsPathNoticeBuiltin");
  }
  if (!path.exists) {
    return t(locale, "skillsPathNoticeMissing");
  }
  if (!path.selected) {
    return t(locale, "skillsPathNoticeSkipped");
  }
  return "";
}
