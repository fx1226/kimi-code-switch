import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Locale } from "@shared/types";
import { msg } from "./messages";

export function Dialog({
  title,
  locale,
  children,
  footer,
  onClose,
  busy = false,
  returnFocus,
}: {
  title: string;
  locale: Locale;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  returnFocus?: HTMLElement | null;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    const previous = returnFocus ?? (document.activeElement as HTMLElement | null);
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="w-dialog"
      aria-labelledby="w-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) closeRef.current();
      }}
    >
      <header className="w-dialog-header">
        <h2 id="w-dialog-title">{title}</h2>
        <button
          className="w-button w-button-quiet w-icon-button"
          aria-label={msg(locale, "close")}
          onClick={onClose}
          disabled={busy}
        >
          <X size={17} />
        </button>
      </header>
      <div className="w-dialog-body">{children}</div>
      {footer ? <footer className="w-dialog-footer">{footer}</footer> : null}
    </dialog>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
  label: string;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="w-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(element) => {
            refs.current[index] = element;
          }}
          id={`web-tab-${tab.id}`}
          type="button"
          className="w-tab"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`web-panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            let next: number | undefined;
            if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
            if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = tabs.length - 1;
            if (next !== undefined) {
              event.preventDefault();
              onChange(tabs[next]!.id);
              refs.current[next]?.focus();
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="w-empty">
      <p>{children}</p>
      {action}
    </div>
  );
}
