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

/** Find a numeric time-series for charting (e.g. follower history). Returns {label,value}[]. */
export function asSeries(raw: unknown): Array<{ label: string; value: number }> {
  const v = unwrapResult(raw);
  let rows: unknown[] = [];
  if (Array.isArray(v)) rows = v;
  else if (isObj(v)) {
    for (const key of ["history", "points", "series", "data", "followers", "growth"]) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) {
        rows = inner;
        break;
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
    const value = firstNumber(r, ["count", "followers", "follower_count", "value", "total", "y"]);
    if (value === undefined) continue;
    const label = firstString(r, ["date", "day", "timestamp", "label", "time", "x"]) ?? String(out.length);
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

/** The SocialGPT identity fields for an account/creator record. */
export interface CreatorRef {
  platform: string;
  username: string;
  accountId?: string;
  name?: string;
}

/** Pull (platform, username, account_id, display name) out of an account/creator record. */
export function creatorRef(rec: Record<string, unknown>): CreatorRef | undefined {
  const platform = firstString(rec, ["platform", "network", "site"]);
  const username = firstString(rec, ["username", "handle", "user", "slug"]);
  if (!platform || !username) return undefined;
  return {
    platform,
    username,
    accountId: firstString(rec, ["account_id", "accountId", "id"]),
    name: firstString(rec, ["display_name", "displayName", "name", "title"]),
  };
}

/** Pull (platform, post_id) out of a video record. */
export function videoRef(rec: Record<string, unknown>): { platform: string; postId: string; title?: string } | undefined {
  const platform = firstString(rec, ["platform", "network"]);
  const postId = firstString(rec, ["post_id", "postId", "id", "video_id", "videoId"]);
  if (!platform || !postId) return undefined;
  return { platform, postId, title: firstString(rec, ["title", "caption", "name", "description"]) };
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function firstNumber(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
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
