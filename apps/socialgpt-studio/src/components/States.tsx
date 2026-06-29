// Tiny presentational primitives for loading / error / empty states, reused everywhere.

import type { ReactNode } from "react";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return (
    <div className="state state-error" role="alert">
      <strong>Something went wrong</strong>
      <pre className="state-error-msg">{message}</pre>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
