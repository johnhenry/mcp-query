// Client-side budget tracker for the analysis tools' "10 calls/hour" rate limit.
// Purely advisory — the server is the source of truth — but it lets the UI surface a
// remaining-budget meter and warn before the user burns calls. Backed by localStorage
// so the budget survives reloads within the hour window.

export const ANALYSIS_LIMIT = 10;
export const WINDOW_MS = 60 * 60 * 1000; // 1 hour

const KEY = "socialgpt-studio:analysis-calls";

function load(): number[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function save(times: number[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(times));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Timestamps of analysis calls still inside the rolling 1h window. */
export function recentCalls(now = Date.now()): number[] {
  return load().filter((t) => now - t < WINDOW_MS);
}

/** Record an analysis call now. */
export function recordCall(now = Date.now()): void {
  const times = recentCalls(now);
  times.push(now);
  save(times);
}

export interface BudgetSnapshot {
  used: number;
  remaining: number;
  limit: number;
  /** ms until the oldest call ages out (when at the limit), else 0. */
  resetInMs: number;
}

export function budget(now = Date.now()): BudgetSnapshot {
  const times = recentCalls(now);
  const used = times.length;
  const remaining = Math.max(0, ANALYSIS_LIMIT - used);
  const oldest = times.length ? Math.min(...times) : now;
  const resetInMs = remaining === 0 ? Math.max(0, WINDOW_MS - (now - oldest)) : 0;
  return { used, remaining, limit: ANALYSIS_LIMIT, resetInMs };
}

/** For tests / display: clear the recorded budget. */
export function resetBudget(): void {
  save([]);
}
