import { useRef } from "react";
import type { ReactNode } from "react";

export interface TabListItem<Id extends string> {
  id: Id;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function TabList<Id extends string>(props: {
  label: string;
  activeId: Id;
  items: Array<TabListItem<Id>>;
  onChange: (id: Id) => void;
  className?: string;
  tabClassName?: string;
  panelIdPrefix?: string;
}): JSX.Element {
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const panelIdPrefix = props.panelIdPrefix ?? "tab-panel";

  const moveTo = (currentIndex: number, targetIndex: number): void => {
    const next = props.items[targetIndex];
    if (!next || next.disabled) return;
    props.onChange(next.id);
    requestAnimationFrame(() => tabsRef.current[targetIndex]?.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
    const enabledIndices = props.items
      .map((item, index) => item.disabled ? -1 : index)
      .filter((index) => index >= 0);
    const activePosition = enabledIndices.indexOf(currentIndex);
    if (activePosition < 0 || enabledIndices.length === 0) return;
    let targetPosition: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      targetPosition = (activePosition + 1) % enabledIndices.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      targetPosition = (activePosition + enabledIndices.length - 1) % enabledIndices.length;
    } else if (event.key === "Home") {
      targetPosition = 0;
    } else if (event.key === "End") {
      targetPosition = enabledIndices.length - 1;
    }
    if (targetPosition === null) return;
    event.preventDefault();
    moveTo(currentIndex, enabledIndices[targetPosition]!);
  };

  return (
    <div className={props.className} role="tablist" aria-label={props.label}>
      {props.items.map((item, index) => {
        const isActive = item.id === props.activeId;
        const tabId = `${panelIdPrefix}-tab-${item.id}`;
        return (
          <button
            key={item.id}
            ref={(element) => { tabsRef.current[index] = element; }}
            id={tabId}
            className={`${props.tabClassName ?? ""}${isActive ? " active" : ""}`.trim()}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`${panelIdPrefix}-panel-${item.id}`}
            tabIndex={isActive ? 0 : -1}
            disabled={item.disabled}
            onClick={() => props.onChange(item.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {item.icon ? <span className="tab-list-icon" aria-hidden="true">{item.icon}</span> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
