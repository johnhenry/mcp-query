// Server Card view (SEP-2127) for the inspector: fetch the card for an HTTP server and compare it with
// what the live connection reports. A card is UNTRUSTED display text (its name, description and URLs are
// chosen by whoever serves it): this module returns plain data; the component only ever uses textContent.
import {
  compareCardToLive,
  fetchServerCard,
  recommendedCardUrl,
  sanitizeForDisplay,
  type CardFinding,
  type LiveServerFacts,
  type ServerCard,
} from "@johnhenry/mcp-query/discovery";

export interface CardView {
  url: string;
  /** Plain display strings, already stripped of control characters. */
  fields: Array<[label: string, value: string]>;
  remotes: Array<{ type: string; url: string; versions: string[] }>;
  findings: CardFinding[];
}

/** Where a card for this server would live, or undefined for a non-HTTP server (stdio has no card). */
export function cardUrlFor(spec: { transport?: string; url?: string } | undefined): string | undefined {
  if (!spec?.url || (spec.transport !== "http" && spec.transport !== undefined)) return undefined;
  try {
    return recommendedCardUrl(spec.url);
  } catch {
    return undefined;
  }
}

/** The facts the live connection reported (the SDK client behind an mcp-query connection). */
export function liveFactsFrom(
  sdk: { getServerVersion?(): { name?: string; version?: string } | undefined; getNegotiatedProtocolVersion?(): string | undefined; getDiscoverResult?(): unknown } | undefined,
  connectedUrl?: string,
): LiveServerFacts {
  const info = sdk?.getServerVersion?.();
  const negotiated = sdk?.getNegotiatedProtocolVersion?.();
  const supported = (sdk?.getDiscoverResult?.() as { supportedVersions?: unknown } | undefined)?.supportedVersions;
  return {
    ...(info ? { serverInfo: info } : {}),
    ...(negotiated ? { negotiatedVersion: negotiated } : {}),
    ...(Array.isArray(supported) ? { supportedVersions: supported.filter((v): v is string => typeof v === "string") } : {}),
    ...(connectedUrl ? { connectedUrl } : {}),
  };
}

const s = (v: unknown, max = 300) => sanitizeForDisplay(v, max);

export function viewCard(card: ServerCard, url: string, live: LiveServerFacts): CardView {
  const fields: CardView["fields"] = [
    ["name", s(card.name, 200)],
    ["version", s(card.version, 100)],
    ["description", s(card.description, 200)],
  ];
  if (card.title) fields.push(["title", s(card.title, 120)]);
  if (card.websiteUrl) fields.push(["website", s(card.websiteUrl, 300)]);
  if (card.repository?.url) fields.push(["repository", s(card.repository.url, 300)]);
  // Icons are listed, never loaded: fetching an attacker-chosen image URL would leak the viewer's IP.
  if (card.icons?.length) fields.push(["icons", card.icons.map((i) => s(i.src, 200)).join(", ")]);
  return {
    url,
    fields,
    remotes: (card.remotes ?? []).map((r) => ({ type: s(r.type, 40), url: s(r.url, 300), versions: (r.supportedProtocolVersions ?? []).map((v) => s(v, 40)) })),
    findings: compareCardToLive(card, live).map((f) => ({ ...f, message: s(f.message, 400) })),
  };
}

/** Fetch a card (hardened fetch, CORS applies in a browser) and compare it with `live`. Throws a DiscoveryError on failure. */
export async function loadCardView(url: string, live: LiveServerFacts, opts: { fetch?: typeof fetch } = {}): Promise<CardView> {
  const { card, url: finalUrl } = await fetchServerCard(url, { allowInsecureLocalhost: true, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return viewCard(card, finalUrl, live);
}
