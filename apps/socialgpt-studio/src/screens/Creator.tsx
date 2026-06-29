import { useMemo, type ReactNode } from "react";
import { useToolResult, useServerState } from "mcp-query/react";
import { SERVER, useNav } from "../nav.js";
import {
  asList,
  asSeries,
  displayName,
  firstString,
  unwrapResult,
  isObj,
  videoRef,
  creatorRef,
  viewCount,
  latestSeriesPoint,
  mergeFill,
} from "../lib/format.js";
import { Loading, ErrorState, Empty } from "../components/States.js";
import { LineChart } from "../components/LineChart.js";
import { ExternalLink } from "../components/ExternalLink.js";
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

  // `get_creator` returns a sparse record (display_name/avatar/follower_count often null, and no
  // profile link), while `list_accounts` carries the rich identity. Look the account up (cached)
  // and use it to backfill the profile and the account_id the series tools need.
  const accountsQ = useToolResult("list_accounts", {}, { server: SERVER, skip: !ready });
  const matchedAccount = useMemo(() => {
    return asList(accountsQ.data).find((a) => {
      const r = creatorRef(a);
      return r && r.platform === platform && r.username.toLowerCase() === username.toLowerCase();
    });
  }, [accountsQ.data, platform, username]);
  const effectiveAccountId = accountId ?? (matchedAccount ? firstString(matchedAccount, ["account_id", "accountId"]) : undefined);
  const acctArgs = effectiveAccountId ? { account_id: effectiveAccountId, platform } : { platform };

  // All read-only, cached, no auto-refetch.
  const profile = useToolResult("get_creator", creatorArgs, { server: SERVER, skip: !ready });
  const metrics = useToolResult("get_account_metrics", acctArgs, { server: SERVER, skip: !ready || !effectiveAccountId });
  const followers = useToolResult("get_follower_history", acctArgs, { server: SERVER, skip: !ready || !effectiveAccountId });
  const growth = useToolResult("get_growth_summary", acctArgs, { server: SERVER, skip: !ready || !effectiveAccountId });
  const videos = useToolResult("list_creator_videos", creatorArgs, { server: SERVER, skip: !ready });

  const rawProfile = profile.data ? unwrapResult(profile.data) : undefined;
  // Backfill null/missing fields from the account record (account fields fill, get_creator wins).
  const profileObj = mergeFill(matchedAccount ?? {}, isObj(rawProfile) ? rawProfile : {});
  const title = displayName(profileObj) || name || `${username}`;

  const followerSeries = asSeries(followers.data, ["follower_count", "followers", "count"]);
  const growthSeries = asSeries(growth.data, ["follower_count", "growth", "net_growth", "delta", "value"]);
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
            <ProfileCard rec={profileObj} platform={platform} username={username} />
          </Panel>

          <Panel title="Account metrics" q={metrics}>
            {!effectiveAccountId ? (
              <Empty>Connect this account to see metrics.</Empty>
            ) : isObj(metricsObj) ? (
              <Metrics rec={metricsObj} />
            ) : (
              <Empty>No metrics yet.</Empty>
            )}
          </Panel>
        </div>

        <div className="col">
          <Panel title="Follower history" q={followers}>
            {followerSeries.length > 1 ? (
              <LineChart data={followerSeries} title="Followers over time" />
            ) : (
              <Empty>{effectiveAccountId ? "Not enough history yet." : "Connect this account to track followers."}</Empty>
            )}
          </Panel>

          <Panel title="Growth summary" q={growth}>
            {!effectiveAccountId ? (
              <Empty>Connect this account to see growth.</Empty>
            ) : growthSeries.length > 1 ? (
              <LineChart data={growthSeries} title="Growth" />
            ) : (
              <GrowthSummary raw={growth.data} />
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
              const vtitle = firstString(v, ["title", "caption", "name", "text"]) || (ref ? `post ${ref.postId}` : `video ${i}`);
              const views = viewCount(v);
              const thumb = firstString(v, ["thumbnail_url", "thumbnail", "cover_url"]);
              return (
                <li key={i}>
                  <button
                    type="button"
                    className="card"
                    disabled={!ref}
                    onClick={() => ref && go({ screen: "video", platform: ref.platform, postId: ref.postId, title: ref.title })}
                  >
                    {thumb && <img className="card-thumb" src={thumb} alt="" loading="lazy" />}
                    <div className="card-title">{vtitle}</div>
                    {views && <div className="card-meta">{views} views</div>}
                    <div className="card-cta">{ref ? "View post →" : "no post id"}</div>
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

/** Build a public profile URL from platform + handle when the record carries no explicit link. */
function profileUrl(platform: string, username: string, rec: Record<string, unknown>): string | undefined {
  const explicit = firstString(rec, ["profile_link", "url", "link", "profile_url"]);
  if (explicit) return explicit;
  const u = username.replace(/^@/, "");
  switch (platform.toLowerCase()) {
    case "instagram":
      return `https://www.instagram.com/${u}`;
    case "tiktok":
      return `https://www.tiktok.com/@${u}`;
    case "youtube":
      return `https://www.youtube.com/@${u}`;
    default:
      return undefined;
  }
}

function ProfileCard({ rec, platform, username }: { rec: Record<string, unknown>; platform: string; username: string }) {
  const bio = firstString(rec, ["bio", "description", "about"]);
  const url = profileUrl(platform, username, rec);
  const pic = firstString(rec, ["profile_picture_url", "avatar", "image"]);
  const followers = firstString(rec, ["follower_count", "followers"]);
  const verified = rec.is_verified === true;
  return (
    <div className="profile">
      <div className="profile-head">
        {pic && <img className="avatar" src={pic} alt="" width={56} height={56} loading="lazy" />}
        <div>
          <div className="profile-handle">@{username.replace(/^@/, "")} {verified && <span title="verified">✓</span>}</div>
          <div className="muted small">{platform}{followers ? ` · ${followers} followers` : ""}</div>
        </div>
      </div>
      {bio && <p>{bio}</p>}
      {url && (
        <p>
          <ExternalLink href={url} className="btn ghost">
            Open profile ↗
          </ExternalLink>
        </p>
      )}
    </div>
  );
}

/** Render get_growth_summary's `{ summary: { <platform>: { metric: { current, change, pct_change } } } }`. */
function GrowthSummary({ raw }: { raw: unknown }) {
  const v = raw ? unwrapResult(raw) : undefined;
  const summary = isObj(v) && isObj(v.summary) ? (v.summary as Record<string, unknown>) : undefined;
  const perPlatform = summary ? Object.values(summary).find(isObj) : undefined;
  const rows = isObj(perPlatform) ? Object.entries(perPlatform).filter(([, m]) => isObj(m)) : [];
  if (rows.length === 0) return <Empty>No growth data yet.</Empty>;
  return (
    <dl className="metrics">
      {rows.map(([k, m]) => {
        const mm = m as Record<string, unknown>;
        const change = Number(mm.change ?? 0);
        const pct = mm.pct_change != null ? Number(mm.pct_change) : undefined;
        return (
          <div className="metric" key={k}>
            <dt>{k.replace(/_/g, " ")}</dt>
            <dd>
              {String(mm.current ?? "—")}
              {Number.isFinite(change) && change !== 0 && (
                <span className={`delta ${change > 0 ? "up" : "down"}`}>
                  {" "}
                  {change > 0 ? "▲" : "▼"}
                  {Math.abs(change)}
                  {pct !== undefined && Number.isFinite(pct) ? ` (${pct}%)` : ""}
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Metrics({ rec }: { rec: Record<string, unknown> }) {
  // get_account_metrics returns config + a `series` (latest point is the useful snapshot).
  const point = latestSeriesPoint(rec);
  const source = point ?? rec;
  const entries = Object.entries(source).filter(
    ([k, v]) =>
      (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) &&
      !/^(window_days|post_limit|granularity)$/i.test(k) &&
      !/_id$|^id$|timestamp|bucket/i.test(k),
  );
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
