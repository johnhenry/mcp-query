// Polls an analysis-status tool with useToolResult(refetchInterval) until the
// analysis-polling state machine reports settled (done/error), then stops polling.
// This is the one place we DO use refetchInterval — and only while pending.

import { useMemo } from "react";
import { useToolResult } from "mcp-query/react";
import { SERVER } from "../nav.js";
import { reduceAnalysis, isSettled, type AnalysisState } from "../lib/analysis.js";
import { Loading, ErrorState } from "./States.js";
import { ResultView } from "@app-shared";

export interface AnalysisPollerProps {
  /** Tool used to poll status, e.g. "get_analysis_status" or "get_video_analysis". */
  statusTool: string;
  /** Args for the status tool (the analysis/job/video id). */
  args: Record<string, unknown>;
  /** Poll cadence while pending (ms). */
  interval?: number;
}

export function AnalysisPoller({ statusTool, args, interval = 3000 }: AnalysisPollerProps) {
  // First pass with no interval, to compute state; we re-derive interval below.
  const probe = useToolResult(statusTool, args, { server: SERVER });
  const state: AnalysisState = useMemo(
    () => reduceAnalysis(probe.data, probe.error),
    [probe.data, probe.error],
  );

  // Once settled, stop polling by passing refetchInterval=undefined.
  const settled = isSettled(state);
  // Re-subscribe with the right interval. useToolResult dedupes by (tool,args), so this
  // shares the cache entry with `probe` — only the interval timer differs.
  useToolResult(statusTool, args, {
    server: SERVER,
    refetchInterval: settled ? undefined : interval,
  });

  return <AnalysisStateView state={state} onRetry={probe.refetch} polling={!settled} />;
}

export function AnalysisStateView({
  state,
  onRetry,
  polling,
}: {
  state: AnalysisState;
  onRetry?: () => void;
  polling?: boolean;
}) {
  if (state.phase === "error") {
    return <ErrorState error={state.error ?? "analysis failed"} onRetry={onRetry} />;
  }
  if (state.phase === "pending" || state.phase === "idle") {
    const pct = state.progress !== undefined ? Math.round(state.progress * 100) : undefined;
    return (
      <div className="analysis-pending">
        <Loading label={`Analysis ${state.label ?? "in progress"}${polling ? "…" : ""}`} />
        {pct !== undefined && (
          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
            <span className="progress-label">{pct}%</span>
          </div>
        )}
        <p className="muted">Polling for results — this can take a moment.</p>
      </div>
    );
  }
  // done
  return (
    <div className="analysis-done">
      <div className="analysis-badge">✓ Analysis complete</div>
      <ResultView value={state.result} />
    </div>
  );
}
