import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import type { AppState, Locale, Profile } from "@shared/types";

import { t } from "./i18n";
import { DialogShell } from "./dialogs";

interface QuickProfileSwitcherProps {
  state: AppState;
  locale: Locale;
  onActivate: (profileName: string) => void;
  onClose: () => void;
}

export function QuickProfileSwitcher({ state, locale, onActivate, onClose }: QuickProfileSwitcherProps): JSX.Element {
  const entries = Object.entries(state.profiles);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = entries.findIndex(([name]) => name === state.activeProfile);
    return idx >= 0 ? idx : 0;
  });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    if (typeof item?.scrollIntoView === "function") {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      switch (event.key) {
        case "ArrowDown":
          if (entries.length === 0) return;
          event.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, entries.length - 1));
          break;
        case "ArrowUp":
          if (entries.length === 0) return;
          event.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          event.preventDefault();
          if (entries[selectedIndex]) onActivate(entries[selectedIndex][0]);
          break;
      }
    },
    [entries, selectedIndex, onActivate, onClose],
  );

  return (
    <DialogShell
      backdropClassName="command-palette-backdrop"
      dialogClassName="command-palette"
      ariaLabel={t(locale, "quickSwitchTitle")}
      onClose={onClose}
      onKeyDown={handleKeyDown}
    >
        <div className="command-palette-input-row">
          <h2 className="command-palette-title">{t(locale, "quickSwitchTitle")}</h2>
          <button type="button" className="command-palette-close" onClick={onClose} aria-label={t(locale, "close")}>
            <X size={14} />
          </button>
        </div>
        <div className="command-palette-results" ref={listRef} role="listbox" aria-activedescendant={entries[selectedIndex] ? `quick-profile-option-${selectedIndex}` : undefined}>
          {entries.map(([name, profile], index) => (
            <button
              key={name}
              id={`quick-profile-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              data-dialog-initial-focus={index === selectedIndex ? "true" : undefined}
              className={index === selectedIndex ? "command-palette-item selected" : "command-palette-item"}
              onClick={() => onActivate(name)}
            >
              <span className="command-palette-item-name">{name}</span>
              <ProfileBadges profile={profile} isActive={name === state.activeProfile} locale={locale} />
            </button>
          ))}
        </div>
    </DialogShell>
  );
}

function ProfileBadges({ profile, isActive, locale }: { profile: Profile; isActive: boolean; locale: Locale }): JSX.Element {
  const mode = profile.default_permission_mode || "manual";
  return (
    <span className="command-palette-item-subtitle">
      {isActive ? <span className="badge badge-active">{t(locale, "quickSwitchActive")}</span> : null}
      <span>{profile.default_model}</span>
      {mode !== "manual" ? <span className="badge">{mode === "yolo" ? "Y" : "A"}</span> : null}
      {profile.thinking_enabled === false ? <span className="badge">T×</span> : null}
    </span>
  );
}
