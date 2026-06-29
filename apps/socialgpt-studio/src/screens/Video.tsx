import { useMemo } from "react";
import { useToolResult, useServerState } from "mcp-query/react";
import { SERVER, useNav } from "../nav.js";
import { unwrapResult, firstString, isObj } from "../lib/format.js";
import { reduceAnalysis } from "../lib/analysis.js";
import { Loading, ErrorState, Empty } from "../components/States.js";
import { AnalysisStateView } from "../components/AnalysisPoller.js";
import { JsonView } from "@app-shared";

export function VideoScreen({ platform, postId, title }: { platform: string; postId: string; title?: string }) {
  const { go } = useNav();
  const server = useServerState(SERVER);
  const ready = server.isReady && !!platform && !!postId;
  const args = { platform, post_id: postId };

  const video = useToolResult("get_video", args, { server: SERVER, skip: !ready });

  // The video analysis follows the pending→retry poll pattern; poll only while unsettled.
  const analysis = useToolResult("get_video_analysis", args, { server: SERVER, skip: !ready });
  const state = useMemo(() => reduceAnalysis(analysis.data, analysis.error), [analysis.data, analysis.error]);
  const settled = state.phase === "done" || state.phase === "error";

  useToolResult("get_video_analysis", args, {
    server: SERVER,
    skip: !ready || settled,
    refetchInterval: settled ? undefined : 3000,
  });

  const videoObj = video.data ? unwrapResult(video.data) : undefined;
  const heading = (isObj(videoObj) && firstString(videoObj, ["title", "caption", "name"])) || title || postId;

  if (!server.isReady) return <Loading label="Connecting…" />;

  return (
    <section className="screen">
      <div className="screen-head">
        <button type="button" className="btn ghost" onClick={() => go({ screen: "search" })}>
          ← Search
        </button>
        <h2>
          {heading} <span className="muted small">{platform}</span>
        </h2>
      </div>

      <div className="panel">
        <h3 className="panel-title">Video</h3>
        {video.isLoading ? (
          <Loading />
        ) : video.error ? (
          <ErrorState error={video.error} onRetry={video.refetch} />
        ) : isObj(videoObj) ? (
          <VideoMeta rec={videoObj} />
        ) : (
          <Empty>No video data.</Empty>
        )}
      </div>

      <div className="panel">
        <h3 className="panel-title">Video analysis</h3>
        {analysis.isLoading && state.phase === "idle" ? (
          <Loading label="Loading analysis…" />
        ) : (
          <AnalysisStateView state={state} onRetry={analysis.refetch} polling={!settled} />
        )}
      </div>
    </section>
  );
}

function VideoMeta({ rec }: { rec: Record<string, unknown> }) {
  const desc = firstString(rec, ["description", "caption", "summary"]);
  const url = firstString(rec, ["url", "link", "video_url", "post_url", "permalink"]);
  const stats = Object.entries(rec).filter(
    ([k, v]) => typeof v === "number" && /view|like|comment|share|play|duration|engagement/i.test(k),
  );
  return (
    <div>
      {desc && <p>{desc}</p>}
      {stats.length > 0 && (
        <dl className="metrics">
          {stats.map(([k, v]) => (
            <div className="metric" key={k}>
              <dt>{k.replace(/_/g, " ")}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {url && (
        <p>
          <a href={url} target="_blank" rel="noreferrer" className="btn ghost">
            Open post ↗
          </a>
        </p>
      )}
      <details className="raw">
        <summary>Raw</summary>
        <JsonView value={rec} />
      </details>
    </div>
  );
}
