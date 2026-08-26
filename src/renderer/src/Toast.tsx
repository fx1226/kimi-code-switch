import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, X, XCircle } from "lucide-react";

import type { Locale } from "@shared/types";
import { t } from "./i18n";
import "./toast.css";

export type ToastType = "success" | "error" | "info";

interface ToastProps {
  message: string;
  type: ToastType;
  duration?: number;
  closeLabel: string;
  copyLabel: string;
  onClose: () => void;
}

export function Toast({ message, type, duration, closeLabel, copyLabel, onClose }: ToastProps): JSX.Element {
  const [isExiting, setIsExiting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const resolvedDuration = duration ?? (type === "error" ? 0 : type === "success" ? 4000 : 6000);

  const handleClose = (): void => {
    setIsExiting(true);
    window.setTimeout(onClose, 200);
  };

  useEffect(() => {
    if (!resolvedDuration || isPaused) return;
    const timer = window.setTimeout(handleClose, resolvedDuration);
    return () => window.clearTimeout(timer);
  }, [resolvedDuration, isPaused]);

  const icons = {
    success: <CheckCircle2 size={22} />,
    error: <XCircle size={22} />,
    info: <AlertCircle size={22} />,
  };

  return (
    <div
      className={`toast toast-${type} ${isExiting ? "toast-exit" : ""}`}
      role={type === "error" ? "alert" : "status"}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={() => setIsPaused(false)}
    >
      <div className="toast-icon" aria-hidden="true">{icons[type]}</div>
      <div className="toast-message">{message}</div>
      {type === "error" ? (
        <button className="toast-copy" type="button" aria-label={copyLabel} title={copyLabel} onClick={() => void navigator.clipboard?.writeText(message)}>
          <Copy size={16} />
        </button>
      ) : null}
      <button className="toast-close" type="button" onClick={handleClose} aria-label={closeLabel} title={closeLabel}>
        <X size={18} />
      </button>
    </div>
  );
}

interface ToastContainerProps {
  locale: Locale;
  toasts: Array<{ id: string; message: string; type: ToastType }>;
  onRemove: (id: string) => void;
}

export function ToastContainer({ locale, toasts, onRemove }: ToastContainerProps): JSX.Element {
  return (
    <div className="toast-container" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          closeLabel={t(locale, "close")}
          copyLabel={t(locale, "copy")}
          onClose={() => onRemove(toast.id)}
        />
      ))}
    </div>
  );
}
