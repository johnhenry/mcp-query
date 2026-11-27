// Server Card + AI Catalog discovery. Results are UNTRUSTED display data: nothing here
// registers a server or opens a connection, and a card's claims are advisory (compare them
// against the live connection with `compareCardToLive`).

import {
  AI_CATALOG_MEDIA_TYPE,
  AI_CATALOG_WELL_KNOWN_PATH,
  AiCatalogEntryShape,
  AiCatalogSchema,
  SERVER_CARD_ENTRY_TYPE,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_PATH_SUFFIX,
  SUPPORTED_CATALOG_MAJOR_MAX,
  ServerCardSchema,
  type ServerCard,
  type ServerCardRemote,
} from "./schemas.js";
import { sameEndpoint } from "./endpoint.js";
import { DiscoveryError, assertFetchableUrl, isLoopbackHost, safeFetchJson, type SafeFetchOptions } from "./safeFetch.js";

export type DiscoveryOptions = SafeFetchOptions;

// ── display safety ──────────────────────────────────────────────────────────────

/**
 * Make an untrusted string safe to print in a terminal: strips ANSI/OSC escape sequences and
 * other control characters (incl. bidi overrides) and caps the length. Card text is
 * attacker-controlled; this is what the CLI renders through.
 */
export function sanitizeForDisplay(s: unknown, max = 300): string {
  const str = typeof s === "string" ? s : String(s ?? "");
  const cleaned = str
    // OSC (ESC ] … BEL|ST) and CSI (ESC [ … final) sequences, then any lone ESC
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

// ── cards ───────────────────────────────────────────────────────────────────────

export interface FetchedServerCard {
  card: ServerCard;
  /** Final URL the card was read from (after same-origin redirects). */
  url: string;
  etag?: string;
}

/**
 * Fetch and validate a Server Card. Sends `Accept: application/mcp-server-card+json`
 * (the spec's SHOULD) and also tolerates `application/json`.
 */
export async function fetchServerCard(url: string, opts: DiscoveryOptions = {}): Promise<FetchedServerCard> {
  const res = await safeFetchJson(url, [SERVER_CARD_MEDIA_TYPE, "application/json"], opts);
  const card = parseServerCard(res.json, res.url);
  return { card, url: res.url, ...(res.etag ? { etag: res.etag } : {}) };
}

/** Validate an already-parsed document (e.g. an inline catalog `data` member). */
export function parseServerCard(doc: unknown, url?: string): ServerCard {
  const parsed = ServerCardSchema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") || "(root)" : "(root)";
    throw new DiscoveryError("invalid_document", `not a valid Server Card: ${where}: ${issue?.message ?? "invalid"}`, url);
  }
  return parsed.data;
}

/** The location MCP reserves for a card: `<streamable-http-url>/server-card`. */
export function recommendedCardUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.search = "";
  u.hash = "";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${SERVER_CARD_PATH_SUFFIX}`;
  return u.href;
}

// ── remotes ─────────────────────────────────────────────────────────────────────

export interface ResolvedRemote {
  type: ServerCardRemote["type"];
  /** Concrete URL, or undefined when unresolved variables remain. */
  url?: string;
  /** Names of `{variables}` that are required/unfilled. */
  missing: string[];
  /** Header definitions the card lists (names + whether secret/required); values are never filled in. */
  headers: Array<{ name: string; isRequired: boolean; isSecret: boolean; description?: string }>;
  supportedProtocolVersions?: string[];
  remote: ServerCardRemote;
}

/** Substitute `{name}` placeholders from `values`, then the variable's `default`. */
export function resolveRemote(remote: ServerCardRemote, values: Record<string, string> = {}): ResolvedRemote {
  const vars = remote.variables ?? {};
  const missing = new Set<string>();
  const url = remote.url.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, name: string) => {
    const v = values[name] ?? vars[name]?.value ?? vars[name]?.default;
    if (v === undefined) {
      missing.add(name);
      return whole;
    }
    const choices = vars[name]?.choices;
    if (choices && !choices.includes(v)) throw new DiscoveryError("invalid_document", `value for "${name}" is not one of the card's choices`);
    return v; // the substituted result is validated as a URL below
  });
  const out: ResolvedRemote = {
    type: remote.type,
    missing: [...missing],
    headers: (remote.headers ?? []).map((h) => ({
      name: h.name,
      isRequired: h.isRequired ?? false,
      isSecret: h.isSecret ?? false,
      ...(h.description ? { description: h.description } : {}),
    })),
    remote,
    ...(remote.supportedProtocolVersions ? { supportedProtocolVersions: remote.supportedProtocolVersions } : {}),
  };
  if (!missing.size) {
    // Validate the substituted result is a plain https URL (substitution could produce junk).
    try {
      new URL(url);
      out.url = url;
    } catch {
      throw new DiscoveryError("invalid_document", `remote URL is not valid after substitution: ${sanitizeForDisplay(url, 120)}`);
    }
  }
  return out;
}

/** Prefer the first `streamable-http` remote, else the first `sse` one. */
export function selectRemote(card: ServerCard): ServerCardRemote | undefined {
  const remotes = card.remotes ?? [];
  return remotes.find((r) => r.type === "streamable-http") ?? remotes[0];
}

/**
 * The URL a client may actually connect to for this remote, enforcing the same transport
 * rule as fetches (https; loopback http only behind the option). Throws on a refused URL.
 */
export function connectableRemoteUrl(resolved: ResolvedRemote, opts: Pick<DiscoveryOptions, "allowInsecureLocalhost"> = {}): string {
  if (!resolved.url) throw new DiscoveryError("invalid_document", `remote needs values for: ${resolved.missing.join(", ")}`);
  return assertFetchableUrl(resolved.url, opts.allowInsecureLocalhost).href;
}

// ── domain discovery ────────────────────────────────────────────────────────────

export interface DiscoveredEntry {
  /** Catalog `identifier` (opaque; typically `urn:air:<publisher>:mcp:<name>`). */
  identifier: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  /** Where the card came from. */
  source: "url" | "data";
  cardUrl?: string;
  /** Present when the card was fetched/read and validated. */
  card?: ServerCard;
  /** Present when the card could not be fetched or validated. */
  error?: { code: string; message: string };
  /** True when `cardUrl` is on the catalog's own origin (cross-origin cards are legal but worth surfacing). */
  sameOrigin?: boolean;
}

export interface DomainDiscovery {
  catalogUrl: string;
  specVersion: string;
  hostName?: string;
  entries: DiscoveredEntry[];
  /** Entries that were not MCP Server Cards or were malformed, with the reason. */
  skipped: Array<{ identifier?: string; reason: string }>;
}

export interface DiscoverFromDomainOptions extends DiscoveryOptions {
  /** Fetch each entry's card (default true). When false, entries carry only their `cardUrl`. */
  resolveCards?: boolean;
  /** Cap on entries processed (default 25), bounding the number of card fetches a catalog can trigger. */
  maxEntries?: number;
}

/** Normalise `example.com` / `example.com:8443` (no scheme, path, userinfo) to a host[:port]. */
export function normalizeDomain(domain: string): string {
  const d = domain.trim();
  if (!d || /[\s/\\@?#]/.test(d) || d.includes("://")) {
    throw new DiscoveryError("invalid_url", `expected a bare domain like "example.com", got: ${sanitizeForDisplay(domain, 80)}`);
  }
  let u: URL;
  try {
    u = new URL(`https://${d}`);
  } catch {
    throw new DiscoveryError("invalid_url", `not a valid domain: ${sanitizeForDisplay(domain, 80)}`);
  }
  return u.host;
}

/**
 * Fetch `https://<domain>/.well-known/ai-catalog.json`, then (by default) fetch each
 * `application/mcp-server-card+json` entry's card. Cards may live on other origins (the
 * spec allows it); each fetch applies the same safety rules independently.
 */
export async function discoverFromDomain(domain: string, opts: DiscoverFromDomainOptions = {}): Promise<DomainDiscovery> {
  const host = normalizeDomain(domain);
  const hostname = new URL(`https://${host}`).hostname;
  const scheme = opts.allowInsecureLocalhost && isLoopbackHost(hostname) ? "http" : "https";
  const catalogUrl = `${scheme}://${host}${AI_CATALOG_WELL_KNOWN_PATH}`;
  return discoverFromCatalogUrl(catalogUrl, opts);
}

/** Same as {@link discoverFromDomain} for a catalog served at an arbitrary URL. */
export async function discoverFromCatalogUrl(catalogUrl: string, opts: DiscoverFromDomainOptions = {}): Promise<DomainDiscovery> {
  // The catalog spec says application/json is acceptable when the document has a valid specVersion.
  const res = await safeFetchJson(catalogUrl, [AI_CATALOG_MEDIA_TYPE, "application/json"], opts);
  const catalog = AiCatalogSchema.safeParse(res.json);
  if (!catalog.success) {
    throw new DiscoveryError("invalid_document", "not an AI Catalog (needs specVersion and entries)", res.url);
  }
  const major = Number(catalog.data.specVersion.split(".")[0]);
  if (major > SUPPORTED_CATALOG_MAJOR_MAX) {
    throw new DiscoveryError("unsupported_version", `AI Catalog specVersion ${sanitizeForDisplay(catalog.data.specVersion, 20)} is newer than supported (major ≤ ${SUPPORTED_CATALOG_MAJOR_MAX})`, res.url);
  }

  const maxEntries = opts.maxEntries ?? 25;
  const base = new URL(res.url);
  const out: DomainDiscovery = {
    catalogUrl: res.url,
    specVersion: catalog.data.specVersion,
    ...(catalog.data.host?.displayName ? { hostName: catalog.data.host.displayName } : {}),
    entries: [],
    skipped: [],
  };

  const wanted: Array<ReturnType<typeof AiCatalogEntryShape.parse>> = [];
  for (const raw of catalog.data.entries) {
    const e = AiCatalogEntryShape.safeParse(raw);
    if (!e.success) {
      out.skipped.push({ reason: "malformed catalog entry" });
      continue;
    }
    if (e.data.type !== SERVER_CARD_ENTRY_TYPE) {
      out.skipped.push({ identifier: e.data.identifier, reason: `type ${sanitizeForDisplay(e.data.type, 60)} is not an MCP Server Card` });
      continue;
    }
    const hasUrl = e.data.url !== undefined;
    const hasData = e.data.data !== undefined;
    if (hasUrl === hasData) {
      out.skipped.push({ identifier: e.data.identifier, reason: "entry must carry exactly one of url or data" });
      continue;
    }
    if (wanted.length >= maxEntries) {
      out.skipped.push({ identifier: e.data.identifier, reason: `beyond maxEntries (${maxEntries})` });
      continue;
    }
    wanted.push(e.data);
  }

  for (const e of wanted) {
    const entry: DiscoveredEntry = {
      identifier: e.identifier,
      source: e.url !== undefined ? "url" : "data",
      ...(e.displayName ? { displayName: e.displayName } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.tags ? { tags: e.tags } : {}),
    };
    try {
      if (e.url !== undefined) {
        const cardUrl = new URL(e.url, base).href;
        entry.cardUrl = cardUrl;
        entry.sameOrigin = new URL(cardUrl).origin === base.origin;
        if (opts.resolveCards !== false) entry.card = (await fetchServerCard(cardUrl, opts)).card;
      } else {
        entry.card = parseServerCard(e.data, res.url);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      entry.error =
        err instanceof DiscoveryError
          ? { code: err.code, message: sanitizeForDisplay(err.message, 200) }
          : { code: "error", message: sanitizeForDisplay(err instanceof Error ? err.message : String(err), 200) };
    }
    out.entries.push(entry);
  }
  return out;
}

// ── card vs live ────────────────────────────────────────────────────────────────

export interface LiveServerFacts {
  /** `serverInfo` from `initialize` / the discover result `_meta`. */
  serverInfo?: { name?: string; version?: string };
  /** The version the connection actually negotiated. */
  negotiatedVersion?: string;
  /** `supportedVersions` from a live `server/discover` result (modern era). */
  supportedVersions?: string[];
  /** The URL that was connected to; selects the matching `remotes[]` entry. */
  connectedUrl?: string;
}

export interface CardFinding {
  field: "name" | "version" | "supportedProtocolVersions" | "negotiatedVersion" | "remote";
  card?: string;
  live?: string;
  /** `differs`: the card contradicts what the live server reported. `note`: nothing to compare. */
  kind: "differs" | "note";
  message: string;
}

/**
 * Compare a card's advisory claims with what the live connection reported. Per the SEP the
 * live `server/discover` values win; this only reports, it never changes anything.
 */
export function compareCardToLive(card: ServerCard, live: LiveServerFacts): CardFinding[] {
  const findings: CardFinding[] = [];
  const liveName = live.serverInfo?.name;
  if (liveName !== undefined) {
    const cardShort = card.name.split("/").pop();
    if (liveName !== card.name && liveName !== cardShort) {
      findings.push({ field: "name", card: card.name, live: liveName, kind: "differs", message: `card name "${card.name}" vs live serverInfo.name "${liveName}"` });
    }
  }
  const liveVersion = live.serverInfo?.version;
  if (liveVersion !== undefined && liveVersion !== card.version) {
    findings.push({ field: "version", card: card.version, live: liveVersion, kind: "differs", message: `card version ${card.version} vs live ${liveVersion}` });
  }

  const remotes = card.remotes ?? [];
  const remote = (live.connectedUrl && remotes.find((r) => sameEndpoint(r.url, live.connectedUrl!))) || selectRemote(card);
  if (live.connectedUrl && remotes.length && !remotes.some((r) => sameEndpoint(r.url, live.connectedUrl!))) {
    findings.push({ field: "remote", live: live.connectedUrl, kind: "differs", message: "connected URL does not match any remote in the card" });
  }
  const cardVersions = remote?.supportedProtocolVersions;
  if (cardVersions && live.negotiatedVersion !== undefined && !cardVersions.includes(live.negotiatedVersion)) {
    findings.push({
      field: "negotiatedVersion",
      card: cardVersions.join(", "),
      live: live.negotiatedVersion,
      kind: "differs",
      message: `live server negotiated ${live.negotiatedVersion}, which the card does not list`,
    });
  }
  if (cardVersions && live.supportedVersions) {
    const onlyCard = cardVersions.filter((v) => !live.supportedVersions!.includes(v));
    const onlyLive = live.supportedVersions.filter((v) => !cardVersions.includes(v));
    if (onlyCard.length || onlyLive.length) {
      findings.push({
        field: "supportedProtocolVersions",
        card: cardVersions.join(", "),
        live: live.supportedVersions.join(", "),
        kind: "differs",
        message: [onlyCard.length ? `card lists ${onlyCard.join(", ")} (not offered live)` : "", onlyLive.length ? `live offers ${onlyLive.join(", ")} (not in card)` : ""].filter(Boolean).join("; "),
      });
    }
  } else if (cardVersions && !live.supportedVersions) {
    findings.push({ field: "supportedProtocolVersions", kind: "note", message: "live server reported no supportedVersions (legacy handshake); only the negotiated version could be compared" });
  }
  return findings;
}
