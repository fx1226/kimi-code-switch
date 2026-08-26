import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CheckCheck, Layers3, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { AppearanceMode, Locale, LocalizedText } from "@shared/types";

import { labelForLocale } from "./appOptions";
import { t } from "./i18n";

type OpenPanel = "environment" | "preferences" | null;

export function TopbarControls(props: {
  locale: Locale;
  theme: AppearanceMode;
  localeOptions: Array<{ value: Locale; shortLabel: string; longLabel: string }>;
  themeOptions: Array<{ value: AppearanceMode; icon: LucideIcon; shortLabel: string; label: LocalizedText }>;
  environmentId: string;
  environmentOptions: Array<{ value: string; label: string; description?: string }>;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: AppearanceMode) => void;
  onEnvironmentChange: (environmentId: string) => void;
}): JSX.Element {
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const environmentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const preferencesTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpenPanel(null);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const activeLocale = props.localeOptions.find((option) => option.value === props.locale) ?? props.localeOptions[0];
  const activeTheme = props.themeOptions.find((option) => option.value === props.theme) ?? props.themeOptions[0];
  const activeEnvironment = props.environmentOptions.find((option) => option.value === props.environmentId) ?? props.environmentOptions[0];

  const closePanel = (): void => {
    const trigger = openPanel === "environment" ? environmentTriggerRef.current : preferencesTriggerRef.current;
    setOpenPanel(null);
    window.requestAnimationFrame(() => trigger?.focus());
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
      : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="toolbar-control-group" ref={rootRef} onKeyDown={handleMenuKeyDown}>
      <div className={openPanel === "environment" ? "toolbar-menu is-open toolbar-menu-environment" : "toolbar-menu toolbar-menu-environment"}>
        <button
          ref={environmentTriggerRef}
          className={openPanel === "environment" ? "toolbar-icon-button active toolbar-environment-button" : "toolbar-icon-button toolbar-environment-button"}
          type="button"
          aria-label={t(props.locale, "kimiCodeEnvironment")}
          aria-haspopup="menu"
          aria-expanded={openPanel === "environment"}
          onClick={() => setOpenPanel((current) => current === "environment" ? null : "environment")}
        >
          <span className="toolbar-icon-badge"><Layers3 size={17} /></span>
          <span className="toolbar-icon-copy"><strong>{activeEnvironment?.label ?? props.environmentId}</strong><small>{t(props.locale, "kimiCodeEnvironment")}</small></span>
        </button>
        <div className="toolbar-popover toolbar-popover-wide" role="menu" aria-label={t(props.locale, "kimiCodeEnvironment")} hidden={openPanel !== "environment"}>
          {props.environmentOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === props.environmentId ? "toolbar-option active" : "toolbar-option"}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === props.environmentId}
              onClick={() => {
                if (option.value !== props.environmentId) props.onEnvironmentChange(option.value);
                setOpenPanel(null);
              }}
            >
              <span className="toolbar-option-leading icon"><Layers3 size={15} /></span>
              <span className="toolbar-option-copy"><strong>{option.label}</strong><small>{option.description || option.value}</small></span>
              {option.value === props.environmentId ? <CheckCheck size={16} /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className={openPanel === "preferences" ? "toolbar-menu is-open" : "toolbar-menu"}>
        <button
          ref={preferencesTriggerRef}
          className={openPanel === "preferences" ? "toolbar-icon-button active toolbar-preferences-button" : "toolbar-icon-button toolbar-preferences-button"}
          type="button"
          aria-label={t(props.locale, "preferences")}
          aria-haspopup="menu"
          aria-expanded={openPanel === "preferences"}
          onClick={() => setOpenPanel((current) => current === "preferences" ? null : "preferences")}
        >
          <span className="toolbar-icon-badge"><Settings2 size={17} /></span>
          <span className="toolbar-icon-copy"><strong>{t(props.locale, "preferences")}</strong><small>{activeLocale.longLabel} · {labelForLocale(activeTheme.label, props.locale)}</small></span>
        </button>
        <div className="toolbar-popover toolbar-popover-preferences" role="menu" aria-label={t(props.locale, "preferences")} hidden={openPanel !== "preferences"}>
          <div className="toolbar-popover-section-label">{t(props.locale, "locale")}</div>
          {props.localeOptions.map((option) => (
            <button key={option.value} className={option.value === props.locale ? "toolbar-option active" : "toolbar-option"} type="button" role="menuitemradio" aria-checked={option.value === props.locale} onClick={() => props.onLocaleChange(option.value)}>
              <span className="toolbar-option-leading flag">{option.shortLabel}</span><span className="toolbar-option-copy"><strong>{option.longLabel}</strong><small>{option.value}</small></span>{option.value === props.locale ? <CheckCheck size={16} /> : null}
            </button>
          ))}
          <div className="toolbar-popover-section-label">{t(props.locale, "theme")}</div>
          {props.themeOptions.map((option) => {
            const Icon = option.icon;
            return <button key={option.value} className={option.value === props.theme ? "toolbar-option active" : "toolbar-option"} type="button" role="menuitemradio" aria-checked={option.value === props.theme} onClick={() => props.onThemeChange(option.value)}><span className="toolbar-option-leading icon"><Icon size={15} /></span><span className="toolbar-option-copy"><strong>{labelForLocale(option.label, props.locale)}</strong><small>{option.value}</small></span>{option.value === props.theme ? <CheckCheck size={16} /> : null}</button>;
          })}
        </div>
      </div>
    </div>
  );
}
