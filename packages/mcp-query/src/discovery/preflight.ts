// Opt-in connection preflight: read a Server Card and report the protocol versions it lists, so a
// connection can pick its handshake without a failed probe. The card is advisory (SEP-2127): this
// never throws, and the live connection stays authoritative (see `ServerConnection`).

// Deliberately dependency-free (no zod): this is reachable from the core connection, and the
// browser bundle must not pull the schema library in for an opt-in feature. It reads only
// `remotes[].{type,url,supportedProtocolVersions}`; full validation is `fetchServerCard`'s job.

import { sameEndpoint } from "./endpoint.js";
import { safeFetchJson, type SafeFetchOptions } from "./safeFetch.js";

export interface CardPreflightOptions extends Pick<SafeFetchOptions, "fetch" | "allowInsecureLocalhost" | "maxBytes" | "maxRedirects"> {
  /** Where the card lives (usually `<streamable-http-url>/server-card`; see `recommendedCardUrl`). */
  cardUrl: string;
  /** The URL this connection will use, to pick the matching `remotes[]` entry. Default: the card's first streamable-http remote. */
  serverUrl?: string;
  /** Budget for the whole fetch in ms. Default 3000: a preflight must not slow a connect down much. */
  timeoutMs?: number;
}

/** The protocol versions a card lists for the connection's remote, or `undefined` on any failure or when none are listed. */
export async function cardProtocolVersions(opts: CardPreflightOptions): Promise<string[] | undefined> {
  try {
    const res = await safeFetchJson(
      opts.cardUrl,
      ["application/mcp-server-card+json", "application/json"],
      {
        timeoutMs: opts.timeoutMs ?? 3000,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
        ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
        ...(opts.maxRedirects !== undefined ? { maxRedirects: opts.maxRedirects } : {}),
      },
    );
    const remotes = ((res.json as { remotes?: unknown })?.remotes ?? []) as Array<{ type?: unknown; url?: unknown; supportedProtocolVersions?: unknown }>;
    if (!Array.isArray(remotes)) return undefined;
    const usable = remotes.filter((r) => r && typeof r === "object" && typeof r.url === "string");
    const remote = (opts.serverUrl && usable.find((r) => sameEndpoint(r.url as string, opts.serverUrl!))) || usable.find((r) => r.type === "streamable-http") || usable[0];
    const list = remote?.supportedProtocolVersions;
    const versions = Array.isArray(list) ? list.filter((v): v is string => typeof v === "string" && v.length > 0) : undefined;
    return versions?.length ? versions : undefined;
  } catch {
    return undefined; // advisory only: any failure just means "no preflight"
  }
}
