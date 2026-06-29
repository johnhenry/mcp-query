// Pure formatting / extraction helpers shared across screens. SocialGPT tool results
// come back as MCP CallToolResults — usually {content:[{type:"text",text:"<json>"}]} or
// {structuredContent:...}. These helpers normalize that into plain JS for rendering.

/** Unwrap an MCP tool result into its underlying JSON value. */
export function unwrapResult(raw: unknown): unknown {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.structuredContent !== undefined) return o.structuredContent;
    if (Array.isArray(o.content)) {
      const text = (o.content as Array<Record<string, unknown>>)
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      if (text) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
  }
  return raw;
}

/** Find the first array-of-objects inside an arbitrary result (the "list" payload). */
export function asList(raw: unknown): Array<Record<string, unknown>> {
  const v = unwrapResult(raw);
  if (Array.isArray(v)) return v.filter(isObj);
  if (isObj(v)) {
    // Common envelope keys used by list_* / search tools.
    for (const key of ["results", "items", "videos", "creators", "accounts", "data", "list"]) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner.filter(isObj);
    }
  }
  return [];
}

/**
 * Find a numeric time-series for charting (e.g. follower history). Returns {label,value}[].
 *
 * SocialGPT's history/metrics tools return `{ series: { <platform>: Row[] }, … }` — the rows
 * are nested under a platform key, not a top-level array — so we unwrap that envelope first.
 * Pass `valueKeys` to chart a specific metric (e.g. follower_count vs views).
 */
export function asSeries(
  raw: unknown,
  valueKeys: string[] = ["follower_count", "count", "followers", "value", "total", "y"],
): Array<{ label: string; value: number }> {
  const v = unwrapResult(raw);
  let rows: unknown[] = [];
  if (Array.isArray(v)) rows = v;
  else if (isObj(v)) {
    for (const key of ["series", "history", "points", "data", "followers", "growth", "timeline"]) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) {
        rows = inner;
        break;
      }
      // `series` (and friends) may be an object keyed by platform → concat each platform's rows.
      if (isObj(inner)) {
        const arrs = Object.values(inner).filter(Array.isArray) as unknown[][];
        if (arrs.length) {
          rows = arrs.flat();
          break;
        }
      }
    }
  }
  const out: Array<{ label: string; value: number }> = [];
  for (const row of rows) {
    if (typeof row === "number") {
      out.push({ label: String(out.length), value: row });
      continue;
    }
    if (!isObj(row)) continue;
    const r = row as Record<string, unknown>;
    const value = firstNumber(r, valueKeys);
    if (value === undefined) continue;
    const label = firstString(r, ["bucket", "date", "day", "timestamp", "label", "time", "x"]) ?? String(out.length);
    out.push({ label, value });
  }
  return out;
}

/** Pick a display name from a creator/account record. */
export function displayName(rec: Record<string, unknown>): string {
  return (
    firstString(rec, ["name", "display_name", "displayName", "username", "handle", "title", "id"]) ??
    "(unnamed)"
  );
}

/** Pick a stable id from a record (for nav / keys). */
export function recordId(rec: Record<string, unknown>): string | undefined {
  return firstString(rec, ["id", "creator_id", "creatorId", "account_id", "accountId", "username", "handle", "url"]);
}

/**
 * Merge a record with its nested `metadata` so identity fields (platform, post_id,
 * creator_username) are reachable whether a tool returns them top-level (video records from
 * list_creator_videos / get_video) or nested under `metadata` (content rows from `search`).
 * Top-level keys win.
 */
export function flat(rec: Record<string, unknown>): Record<string, unknown> {
  return isObj(rec.metadata) ? { ...(rec.metadata as Record<string, unknown>), ...rec } : rec;
}

/** The metrics sub-record SocialGPT nests under `metrics` (falls back to the record itself). */
export function metricsOf(rec: Record<string, unknown>): Record<string, unknown> {
  return isObj(rec.metrics) ? (rec.metrics as Record<string, unknown>) : rec;
}

/** A human view-count string for a video/post (metrics are nested under `metrics`). */
export function viewCount(rec: Record<string, unknown>): string | undefined {
  return firstString(metricsOf(rec), ["views", "view_count", "plays", "play_count"]);
}

/** The SocialGPT identity fields for an account/creator record. */
export interface CreatorRef {
  platform: string;
  username: string;
  accountId?: string;
  name?: string;
}

/** Pull (platform, username, account_id, display name) out of an account/creator record. */
export function creatorRef(rec: Record<string, unknown>): CreatorRef | undefined {
  const f = flat(rec);
  const platform = firstString(f, ["platform", "network", "site"]);
  const username = firstString(f, ["username", "handle", "user", "slug", "creator_username"]);
  if (!platform || !username) return undefined;
  return {
    platform,
    username,
    accountId: firstString(f, ["account_id", "accountId", "creator_id", "creatorId"]),
    name: firstString(f, ["display_name", "displayName", "name", "title"]),
  };
}

/** A video/post reference, including the creator handle. */
export interface VideoRef {
  platform: string;
  postId: string;
  title?: string;
  username?: string;
}

/** Pull (platform, post_id, creator handle) out of a video/post record (top-level or nested). */
export function videoRef(rec: Record<string, unknown>): VideoRef | undefined {
  const f = flat(rec);
  const platform = firstString(f, ["platform", "network"]);
  // Prefer the explicit post_id; the composite `id` ("socialgpt-post:tiktok:123") is a last resort.
  let postId = firstString(f, ["post_id", "postId", "video_id", "videoId"]);
  if (!postId) {
    const composite = firstString(f, ["id"]);
    if (composite) postId = composite.includes(":") ? composite.split(":").pop() : composite;
  }
  if (!platform || !postId) return undefined;
  return {
    platform,
    postId,
    title: firstString(f, ["title", "caption", "name", "description", "text"]),
    username: firstString(f, ["creator_username", "username", "handle", "author", "owner"]),
  };
}

/** Overlay `over` onto `base`, but skip null/undefined values in `over` (so real base values
 *  aren't clobbered by a sparse record's nulls — e.g. get_creator's null avatar over a real one). */
export function mergeFill(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** The most recent row of a `{ series: Row[] | { <platform>: Row[] } }` metrics envelope. */
export function latestSeriesPoint(raw: unknown): Record<string, unknown> | undefined {
  const v = unwrapResult(raw);
  if (!isObj(v)) return undefined;
  const series = (v as Record<string, unknown>).series;
  let arr: unknown[] | undefined;
  if (Array.isArray(series)) arr = series;
  else if (isObj(series)) arr = (Object.values(series).filter(Array.isArray) as unknown[][]).flat();
  const last = arr && arr.length ? arr[arr.length - 1] : undefined;
  return isObj(last) ? last : undefined;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function firstNumber(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    // Some SocialGPT metrics arrive as numeric strings (e.g. like_count: "81").
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export function firstString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}
