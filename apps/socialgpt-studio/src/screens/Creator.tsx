import type { ReactNode } from "react";
import { useToolResult, useServerState } from "mcp-query/react";
import { SERVER, useNav } from "../nav.js";
import { asList, asSeries, displayName, firstString, unwrapResult, isObj, videoRef } from "../lib/format.js";
import { Loading, ErrorState, Empty } from "../components/States.js";
import { LineChart } from "../components/LineChart.js";
import { JsonView } from "@app-shared";

export function CreatorScreen({
  platform,
  username,
  accountId,
  name,
}: {
  platform: string;
  username: string;
  accountId?: string;
  name?: string;
}) {
  const { go } = useNav();
  const server = useServerState(SERVER);
  const ready = server.isReady && !!platform && !!username;

  // SocialGPT keys creators by (platform, username) and account-series by account_id+platform.
  const creatorArgs = { platform, username };
  const acctArgs = accountId ? { account_id: accountId, platform } : { platform };

  // All read-only, cached, no auto-refetch.
  const profile = useToolResult("get_creator", creatorArgs, { server: SERVER, skip: !ready });
  const metrics = useToolResult("get_account_metrics", acctArgs, { server: SERVER, skip: !ready });
  const followers = useToolResult("get_follower_history", acctArgs, { server: SERVER, skip: !ready });
  const growth = useToolResult("get_growth_summary", acctArgs, { server: SERVER, skip: !ready });
  const videos = useToolResult("list_creator_videos", creatorArgs, { server: SERVER, skip: !ready });

  const profileObj = profile.data ? unwrapResult(profile.data) : undefined;
  const title = (isObj(profileObj) && displayName(profileObj)) || name || `${username}`;

  const followerSeries = asSeries(followers.data);
  const growthSeries = asSeries(growth.data);
  const videoRows = asList(videos.data);
  const metricsObj = metrics.data ? unwrapResult(metrics.data) : undefined;

  if (!server.isReady) return <Loading label="Connecting…" />;

  return (
    <section className="screen">
      <div className="screen-head">
        <button type="button" className="btn ghost" onClick={() => go({ screen: "search" })}>
          ← Search
        </button>
        <h2>
          {title} <span className="muted small">{platform} · @{username}</span>
        </h2>
        <button
          type="button"
          className="btn primary"
          onClick={() => go({ screen: "analyze", kind: "creator", platform, username })}
        >
          Analyze creator →
        </button>
      </div>

      <div className="columns">
        <div className="col">
          <Panel title="Profile" q={profile}>
            {isObj(profileObj) ? <ProfileCard rec={profileObj} /> : <JsonView value={profileObj} />}
          </Panel>

          <Panel title="Account metrics" q={metrics}>
            {isObj(metricsObj) ? <Metrics rec={metricsObj} /> : <JsonView value={metricsObj} />}
          </Panel>
        </div>

        <div className="col">
          <Panel title="Follower history" q={followers}>
            <LineChart data={followerSeries} title="Followers over time" />
          </Panel>

          <Panel title="Growth summary" q={growth}>
            {growthSeries.length > 1 ? (
              <LineChart data={growthSeries} title="Growth" />
            ) : (
              <JsonView value={growth.data ? unwrapResult(growth.data) : undefined} />
            )}
          </Panel>
        </div>
      </div>

      <Panel title={`Videos${videoRows.length ? ` (${videoRows.length})` : ""}`} q={videos}>
        {videoRows.length === 0 ? (
          <Empty>No videos found.</Empty>
        ) : (
          <ul className="card-grid">
            {videoRows.map((v, i) => {
              const ref = videoRef(v);
              const vtitle = firstString(v, ["title", "caption", "name"]) ?? ref?.postId ?? `video ${i}`;
              const views = firstString(v, ["views", "view_count", "plays"]);
              return (
                <li key={i}>
                  <button
                    type="button"
                    className="card"
                    disabled={!ref}
                    onClick={() => ref && go({ screen: "video", platform: ref.platform, postId: ref.postId, title: ref.title })}
                  >
                    <div className="card-title">{vtitle}</div>
                    {views && <div className="card-meta">{views} views</div>}
                    <div className="card-cta">{ref ? "View video →" : "no post id"}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </section>
  );
}

interface QueryLike {
  isLoading: boolean;
  error?: unknown;
  refetch: () => void;
}

function Panel({ title, q, children }: { title: string; q: QueryLike; children: ReactNode }) {
  return (
    <div className="panel">
      <h3 className="panel-title">{title}</h3>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : children}
    </div>
  );
}

function ProfileCard({ rec }: { rec: Record<string, unknown> }) {
  const bio = firstString(rec, ["bio", "description", "about"]);
  const url = firstString(rec, ["profile_link", "url", "link", "profile_url"]);
  const pic = firstString(rec, ["profile_picture_url", "avatar", "image"]);
  const platform = firstString(rec, ["platform", "network"]);
  const verified = rec.is_verified === true;
  return (
    <div className="profile">
      {pic && <img className="avatar" src={pic} alt="" width={56} height={56} />}
      {bio && <p>{bio}</p>}
      <div className="kv-row">
        {platform && <span className="kv"><b>Platform</b> {platform}</span>}
        {verified && <span className="kv"><b>Verified</b> ✓</span>}
        {url && (
          <span className="kv">
            <b>Link</b>{" "}
            <a href={url} target="_blank" rel="noreferrer">
              profile ↗
            </a>
          </span>
        )}
      </div>
    </div>
  );
}

function Metrics({ rec }: { rec: Record<string, unknown> }) {
  const entries = Object.entries(rec).filter(([, v]) => typeof v === "number" || typeof v === "string");
  if (entries.length === 0) return <JsonView value={rec} />;
  return (
    <dl className="metrics">
      {entries.slice(0, 12).map(([k, v]) => (
        <div className="metric" key={k}>
          <dt>{k.replace(/_/g, " ")}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
