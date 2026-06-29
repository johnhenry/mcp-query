import { useMemo, useState } from "react";
import { useTool, useServerState } from "mcp-query/react";
import { SERVER, useNav } from "../nav.js";
import { SchemaForm } from "@app-shared";
import { budget, recordCall, ANALYSIS_LIMIT } from "../lib/rateBudget.js";
import { unwrapResult, firstString, isObj } from "../lib/format.js";
import { AnalysisPoller } from "../components/AnalysisPoller.js";
import { ErrorState, Empty, Pill } from "../components/States.js";

type Kind = "creator" | "post";

export function AnalyzeScreen({
  kind: initialKind,
  platform,
  username,
}: {
  kind?: Kind;
  platform?: string;
  username?: string;
}) {
  const { go } = useNav();
  const server = useServerState(SERVER);
  const [kind, setKind] = useState<Kind>(initialKind ?? "creator");

  // analyze_creator(platform, username) ; analyze_post(post_url)
  const tool = kind === "creator" ? "analyze_creator" : "analyze_post";
  const [invoke, state] = useTool(tool, { server: SERVER });

  const [tick, setTick] = useState(0);
  const b = useMemo(() => budget(), [tick]);
  const outOfBudget = b.remaining <= 0;

  // After launch, get the job_id to poll get_analysis_status(job_id).
  const launched = state.data ? unwrapResult(state.data) : undefined;
  const jobArgs = useMemo(() => deriveJobArgs(launched), [launched]);

  async function run(values: Record<string, unknown>) {
    if (outOfBudget) return;
    try {
      recordCall();
      setTick((t) => t + 1);
      await invoke(values);
      setTick((t) => t + 1);
    } catch {
      /* surfaced via state.error */
    }
  }

  // Seed the form from the tool's runtime inputSchema, then prefill known fields.
  const schema = state.inputSchema as
    | { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
    | undefined;
  const prefill =
    kind === "creator"
      ? { platform: platform ?? "", username: username ?? "" }
      : undefined;

  return (
    <section className="screen">
      <div className="screen-head">
        <button type="button" className="btn ghost" onClick={() => go({ screen: "search" })}>
          ← Search
        </button>
        <h2>Analyze</h2>
        <Pill tone={outOfBudget ? "bad" : b.remaining <= 2 ? "warn" : "good"}>
          {b.remaining}/{ANALYSIS_LIMIT} analyses left this hour
        </Pill>
      </div>

      <div className="seg">
        <button type="button" className={kind === "creator" ? "active" : ""} onClick={() => setKind("creator")}>
          Creator
        </button>
        <button type="button" className={kind === "post" ? "active" : ""} onClick={() => setKind("post")}>
          Post
        </button>
      </div>

      <div className="panel">
        <h3 className="panel-title">Run {tool}</h3>
        {!server.isReady && <Empty>Connecting to SocialGPT…</Empty>}
        {server.isReady && outOfBudget && (
          <div className="state state-warn" role="alert">
            <strong>Rate-limit budget exhausted.</strong>
            <p className="muted">
              You’ve used all {ANALYSIS_LIMIT} analysis calls this hour. Budget resets in about{" "}
              {Math.ceil(b.resetInMs / 60000)} min.
            </p>
          </div>
        )}
        {server.isReady && !outOfBudget && (
          <>
            {/* `key` resets the form when switching tool/prefill. */}
            <SchemaForm
              key={`${tool}:${platform}:${username}`}
              schema={mergePrefill(schema, prefill)}
              submitLabel={state.isPending ? "Running…" : `Run ${tool}`}
              onSubmit={run}
            />
            <p className="muted small">
              Analysis is rate-limited to {ANALYSIS_LIMIT} calls/hour. Each run spends one from your budget.
            </p>
          </>
        )}
        {state.error && <ErrorState error={state.error} />}
        {state.progress && (
          <p className="muted">
            progress: {state.progress.progress}
            {state.progress.total ? ` / ${state.progress.total}` : ""}
          </p>
        )}
      </div>

      {jobArgs && (
        <div className="panel">
          <h3 className="panel-title">Results</h3>
          <AnalysisPoller statusTool="get_analysis_status" args={jobArgs} />
        </div>
      )}
    </section>
  );
}

/** Pull a job_id out of the launch result so we can poll get_analysis_status(job_id). */
function deriveJobArgs(launched: unknown): { job_id: string } | undefined {
  if (!isObj(launched)) return undefined;
  const jobId = firstString(launched, ["job_id", "jobId", "analysis_id", "analysisId", "id", "task_id"]);
  return jobId ? { job_id: jobId } : undefined;
}

/** SchemaForm has no prefill prop; bake defaults into the schema's enum/placeholder isn't
 *  enough, so we narrow the schema to the prefilled keys' descriptions to hint the user. */
function mergePrefill(
  schema:
    | { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
    | undefined,
  prefill?: Record<string, string>,
) {
  if (!schema || !prefill) return schema;
  const properties = { ...(schema.properties ?? {}) };
  for (const [k, v] of Object.entries(prefill)) {
    if (v && properties[k]) {
      properties[k] = { ...properties[k], description: `${properties[k]?.description ?? ""} (suggested: ${v})`.trim() };
    }
  }
  return { ...schema, properties };
}
