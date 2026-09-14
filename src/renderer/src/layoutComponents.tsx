import { useRef, useState } from "react";
import { Copy, Inbox, Star } from "lucide-react";

import type { Locale } from "@shared/types";

import { t } from "./i18n";

export function ResourceWorkspace(props: {
  listTitle: string;
  listItems: string[];
  itemLabel?: (item: string) => string;
  renderItemLabel?: (item: string) => JSX.Element | string;
  itemTitle?: (item: string) => string;
  dirtyItems?: Set<string>;
  dirtyLabel?: string;
  selectedItem: string;
  highlightedItem?: string;
  onSelect: (item: string) => void;
  copyLabel?: string;
  onCopy?: (item: string) => void;
  addLabel: string;
  onAdd?: () => void;
  addButtonContent?: JSX.Element;
  addButtonTitle?: string;
  addButtonClassName?: string;
  addButtonDisabled?: boolean;
  itemClassName?: (item: string) => string | null;
  renderItemAction?: (item: string) => JSX.Element | null;
  headerActions?: JSX.Element | null;
  listBanner?: JSX.Element | null;
  searchPlaceholder?: string;
  hideList?: boolean;
  reverse?: boolean;
  children: JSX.Element;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const itemButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = normalizedQuery
    ? props.listItems.filter((item) => {
        const label = props.itemLabel?.(item) ?? item;
        const title = props.itemTitle?.(item) ?? "";
        return `${label} ${title}`.toLocaleLowerCase().includes(normalizedQuery);
      })
    : props.listItems;
  const moveSelection = (event: React.KeyboardEvent<HTMLButtonElement>, item: string): void => {
    const currentIndex = visibleItems.indexOf(item);
    if (currentIndex < 0 || visibleItems.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = Math.min(currentIndex + 1, visibleItems.length - 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(currentIndex - 1, 0);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = visibleItems.length - 1;
    if (nextIndex === null || nextIndex === currentIndex) return;
    event.preventDefault();
    const nextItem = visibleItems[nextIndex]!;
    props.onSelect(nextItem);
    requestAnimationFrame(() => itemButtonsRef.current[nextIndex]?.focus());
  };
  return (
    <section
      className={[
        props.reverse ? "split-layout split-layout-reverse" : "split-layout",
        props.hideList ? "split-layout-no-list" : "",
      ].filter(Boolean).join(" ")}
    >
      {props.hideList ? null : (
      <div className="glass-panel list-panel">
        <div className="list-header">
          {props.listTitle ? <div className="section-title">{props.listTitle}</div> : null}
          <div className="list-header-actions">
            {props.headerActions}
            {props.onAdd ? (
              <button
                className={props.addButtonClassName ?? "action-button compact"}
                type="button"
                aria-label={props.addButtonTitle ?? props.addLabel}
                title={props.addButtonTitle ?? props.addLabel}
                disabled={props.addButtonDisabled}
                onClick={props.onAdd}
              >
                {props.addButtonContent ?? props.addLabel}
              </button>
            ) : null}
          </div>
        </div>
        {props.listBanner}
        {props.searchPlaceholder ? (
          <label className="resource-list-search">
            <span className="sr-only">{props.searchPlaceholder}</span>
            <input type="search" value={query} placeholder={props.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
          </label>
        ) : null}
        <div className="list-scroll" role="list" aria-label={props.listTitle || props.addLabel}>
          {visibleItems.map((item, index) => (
            <div
              key={item}
              role="listitem"
              className={[
                "list-row",
                item === props.selectedItem ? "active" : "",
                item === props.highlightedItem ? "current" : "",
                props.itemClassName?.(item) ?? "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <button
                ref={(element) => { itemButtonsRef.current[index] = element; }}
                className="list-item"
                type="button"
                title={props.itemTitle ? props.itemTitle(item) : props.itemLabel ? props.itemLabel(item) : item}
                aria-pressed={item === props.selectedItem}
                aria-current={item === props.highlightedItem ? "true" : undefined}
                onClick={() => {
                  if (item === props.selectedItem) return;
                  props.onSelect(item);
                }}
                onKeyDown={(event) => moveSelection(event, item)}
              >
                {props.renderItemLabel ? props.renderItemLabel(item) : props.itemLabel ? props.itemLabel(item) : item}
              </button>
              <div className="list-row-actions">
                {props.dirtyItems?.has(item) ? (
                  <span className="list-dirty-badge" title={props.dirtyLabel} aria-label={props.dirtyLabel}>
                    <Star size={14} fill="currentColor" />
                  </span>
                ) : null}
                {props.copyLabel && props.onCopy ? (
                  <button
                    className="list-copy-button"
                    type="button"
                    aria-label={`${props.copyLabel} ${item}`}
                    title={props.copyLabel}
                    onClick={() => props.onCopy?.(item)}
                  >
                    <Copy size={15} />
                  </button>
                ) : null}
                {props.renderItemAction?.(item)}
              </div>
            </div>
          ))}
        </div>
      </div>
      )}
      {props.children}
    </section>
  );
}

/** @deprecated Use ResourceWorkspace for new resource-management surfaces. */
export const SplitLayout = ResourceWorkspace;

export function EmptyState(props: { locale: Locale; hasItems?: boolean }): JSX.Element {
  return (
    <section className="glass-panel form-panel empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        <Inbox size={40} />
      </div>
      <div className="section-title">{t(props.locale, props.hasItems ? "emptyState" : "emptyCollection")}</div>
      <p>{t(props.locale, props.hasItems ? "selectItemHint" : "createFirstHint")}</p>
    </section>
  );
}
