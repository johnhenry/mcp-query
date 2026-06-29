// Pure helpers for the analysis polling flow and for normalizing SocialGPT tool
// results. Kept free of React so they can be unit-tested directly.

export type AnalysisPhase = "idle" | "pending" | "done" | "error";

export interface AnalysisState {
  phase: AnalysisPhase;
  /** 0..1 if the server reports progress, else undefined. */
  progress?: number;
  /** Human-readable status label from the server, when present. */
  label?: string;
  /** The final analysis payload once phase === "done". */
  result?: unknown;
  error?: string;
}

const PENDING = new Set(["pending", "queued", "running", "processing", "in_progress", "started"]);
const DONE = new Set(["done", "complete", "completed", "succeeded", "success", "finished", "ready"]);
const FAILED = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

/** Pull a status string out of an arbitrary tool result shape. */
export function extractStatus(raw: unknown): string | undefined {
  const obj = unwrap(raw);
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const candidate = o.status ?? o.state ?? o.phase;
  return typeof candidate === "string" ? candidate.toLowerCase() : undefined;
}

/** Pull a 0..1 progress number out of a result shape, if any. */
export function extractProgress(raw: unknown): number | undefined {
  const obj = unwrap(raw);
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const p = o.progress ?? o.percent ?? o.percentage;
  if (typeof p !== "number") return undefined;
  return p > 1 ? Math.min(p / 100, 1) : Math.max(0, Math.min(p, 1));
}

/**
 * The analysis polling state machine: given the latest poll result (or an error),
 * derive the next AnalysisState. `pending` keeps polling; `done`/`error` stop it.
 * If a result has no recognizable status field but does carry a payload, we treat it
 * as done (some analysis endpoints return the analysis directly once ready).
 */
export function reduceAnalysis(raw: unknown, error?: unknown): AnalysisState {
  if (error) {
    return { phase: "error", error: errMessage(error) };
  }
  if (raw === undefined || raw === null) {
    return { phase: "pending" };
  }
  const status = extractStatus(raw);
  const progress = extractProgress(raw);
  const label = status;
  if (status && FAILED.has(status)) {
    return { phase: "error", error: label ?? "analysis failed", label };
  }
  if (status && PENDING.has(status)) {
    return { phase: "pending", progress, label };
  }
  if (status && DONE.has(status)) {
    return { phase: "done", progress: 1, label, result: raw };
  }
  // No recognizable status — if there is a substantive payload, consider it done.
  if (hasPayload(raw)) {
    return { phase: "done", progress: 1, label, result: raw };
  }
  return { phase: "pending", progress, label };
}

/** Has the analysis settled (no more polling needed)? */
export function isSettled(state: AnalysisState): boolean {
  return state.phase === "done" || state.phase === "error";
}

function hasPayload(raw: unknown): boolean {
  const obj = unwrap(raw);
  if (obj === undefined || obj === null) return false;
  if (typeof obj === "string") return obj.trim().length > 0;
  if (Array.isArray(obj)) return obj.length > 0;
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const keys = Object.keys(o);
    // A bare {status:...} doesn't count; an analysis/summary/result field does.
    if (o.analysis ?? o.summary ?? o.result ?? o.report ?? o.insights) return true;
    return keys.some((k) => k !== "status" && k !== "state" && k !== "phase");
  }
  return false;
}

/** MCP CallToolResult often wraps the real data in {content:[{type:"text",text}]} or
 *  structuredContent. Unwrap to the underlying value for status inspection. */
function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.structuredContent !== undefined) return o.structuredContent;
    if (Array.isArray(o.content)) {
      const textBlock = (o.content as Array<Record<string, unknown>>).find(
        (b) => b?.type === "text" && typeof b.text === "string",
      );
      if (textBlock) {
        try {
          return JSON.parse(textBlock.text as string);
        } catch {
          return textBlock.text;
        }
      }
    }
  }
  return raw;
}

function errMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
