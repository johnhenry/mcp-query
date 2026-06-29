import { useState } from "react";
import { useToolResult, useServerState } from "mcp-query/react";
import { SERVER, useNav } from "../nav.js";
import {
  asList,
  displayName,
  firstString,
  creatorRef,
  videoRef,
  viewCount,
  unwrapResult,
  isObj,
} from "../lib/format.js";
import { Loading, ErrorState, Empty } from "../components/States.js";

type Mode = "accounts" | "creators" | "videos";

export function SearchScreen() {
  const { go } = useNav();
  const server = useServerState(SERVER);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("accounts");

  // "accounts" lists the tracked accounts you can drill into / analyze (no query needed).
  // "creators" runs `search` (content + creators); "videos" runs `search_videos`.
  const accounts = useToolResult("list_accounts", {}, { server: SERVER, skip: mode !== "accounts" || !server.isReady });
  const searchTool = mode === "videos" ? "search_videos" : "search";
  const searchRes = useToolResult(
    searchTool,
    { query },
    { server: SERVER, skip: mode === "accounts" || !query || !server.isReady },
  );

  const active = mode === "accounts" ? accounts : searchRes;
  const rows = asList(active.data);
  const reason = (() => {
    const u = active.data ? unwrapResult(active.data) : undefined;
    return isObj(u) ? firstString(u, ["reason", "message"]) : undefined;
  })();

  return (
    <section className="screen">
      <div className="search-bar">
        <div className="seg">
          {(["accounts", "creators", "videos"] as Mode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {m === "accounts" ? "Accounts" : m === "creators" ? "Search" : "Videos"}
            </button>
          ))}
        </div>
        {mode !== "accounts" && (
          <form className="search-form" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); }}>
            <input
              type="search"
              placeholder={mode === "videos" ? "Search videos…" : "Search content & creators…"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="search query"
            />
            <button type="submit" className="btn primary" disabled={!draft.trim() || !server.isReady}>
              Search
            </button>
          </form>
        )}
      </div>

      {!server.isReady && <Loading label="Connecting to SocialGPT…" />}

      {server.isReady && mode === "accounts" && accounts.isLoading && <Loading label="Loading accounts…" />}
      {server.isReady && mode === "accounts" && accounts.error && (
        <ErrorState error={accounts.error} onRetry={accounts.refetch} />
      )}

      {server.isReady && mode !== "accounts" && !query && (
        <Empty>
          <p>Search the SocialGPT graph for {mode === "videos" ? "videos" : "content & creators"}.</p>
          <p className="muted">Results are cached and never auto-refresh, to respect rate limits.</p>
        </Empty>
      )}
      {mode !== "accounts" && query && searchRes.isLoading && <Loading label={`Searching ${mode}…`} />}
      {mode !== "accounts" && query && searchRes.error && (
        <ErrorState error={searchRes.error} onRetry={searchRes.refetch} />
      )}

      {!active.isLoading && !active.error && rows.length === 0 && (mode === "accounts" || query) && (
        <Empty>
          {mode === "accounts" ? "No tracked accounts yet." : <>No {mode} found{reason ? ` (${reason})` : ""}.</>}
        </Empty>
      )}

      {rows.length > 0 && (
        <ul className="card-grid">
          {rows.map((rec, i) => (
            <ResultCard key={i} rec={rec} mode={mode} onCreator={(ref) => go({ screen: "creator", ...ref })} onVideo={(v) => go({ screen: "video", platform: v.platform, postId: v.postId, title: v.title })} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResultCard({
  rec,
  mode,
  onCreator,
  onVideo,
}: {
  rec: Record<string, unknown>;
  mode: Mode;
  onCreator: (ref: { platform: string; username: string; accountId?: string; name?: string }) => void;
  onVideo: (v: { platform: string; postId: string; title?: string }) => void;
}) {
  const name = displayName(rec);

  // "accounts" lists tracked creators → drill into the Creator screen.
  if (mode === "accounts") {
    const ref = creatorRef(rec);
    const plat = ref?.platform;
    const verified = rec.is_verified === true;
    const pic = firstString(rec, ["profile_picture_url", "avatar", "image"]);
    return (
      <li>
        <button type="button" className="card" disabled={!ref} onClick={() => ref && onCreator(ref)}>
          <div className="card-row">
            {pic && <img className="card-avatar" src={pic} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
            <div className="card-title">
              {name} {verified && <span title="verified">✓</span>}
            </div>
          </div>
          <div className="card-sub">
            {plat ?? ""}
            {ref?.username ? ` · @${ref.username}` : ""}
          </div>
          <div className="card-cta">{ref ? "View creator →" : "needs platform + username"}</div>
        </button>
      </li>
    );
  }

  // "Search" (content) and "Videos" both return posts → drill into the Video screen.
  const v = videoRef(rec);
  const views = viewCount(rec);
  const thumb = firstString(rec, ["thumbnail_url", "thumbnail", "cover_url"]);
  return (
    <li>
      <button type="button" className="card" disabled={!v} onClick={() => v && onVideo(v)}>
        {thumb && <img className="card-thumb" src={thumb} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
        <div className="card-title">{firstString(rec, ["title", "caption", "name", "text"]) ?? v?.title ?? name}</div>
        <div className="card-sub">
          {v?.platform ?? ""}
          {v?.username ? ` · @${v.username}` : ""}
        </div>
        {views && <div className="card-meta">{views} views</div>}
        <div className="card-cta">{v ? "View post →" : "no post id"}</div>
      </button>
    </li>
  );
}
