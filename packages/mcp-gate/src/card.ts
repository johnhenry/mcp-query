// A Server Card (SEP-2127) for the gate's OWN endpoint.
//
// Wire format: modelcontextprotocol/experimental-ext-server-card `schema.ts` (the same schema
// `@johnhenry/mcp-query/discovery` validates against). Location: the SEP reserves
// `<streamable-http-url>/server-card` as the recommended place, so `createGateCardHandler`
// answers GET there.
//
// OWNER DECISION: the card describes the gate itself (identity, its transport endpoint, the
// protocol versions it speaks) and NOTHING about what it fronts. Upstream names are included
// only when `card.listUpstreams` is set, and then only names: never URLs, commands, headers,
// policy or counts of anything else. A card is public by design (SEP security notes: no
// credentials, no internal topology).
//
// No runtime dependency on the discovery module (so the gate does not need a newer
// `@johnhenry/mcp-query` than it already requires): the shape is built by hand and the tests
// validate it against `ServerCardSchema`.

import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import type { GateConfig } from "./config.js";

const CARD_SCHEMA_URI = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
const CARD_MEDIA_TYPE = "application/mcp-server-card+json";
const CARD_PATH_SUFFIX = "/server-card";
/** `_meta` key the opt-in upstream listing lives under (reverse-DNS namespaced, as the SEP asks). */
export const GATE_CARD_META_KEY = "me.johnhenry/mcp-gate";

/** Options for the gate's card. Everything here is published; put nothing secret in it. */
export interface GateCardConfig {
  /** Public Streamable HTTP URL of the gate (`https://…`). The card is served at `<url>/server-card`. */
  url: string;
  /** Reverse-DNS card name with exactly one slash, e.g. `com.example/gate`. */
  name: string;
  /** The gate deployment's version string (yours, not the package's). */
  version: string;
  /** One line, max 100 chars. Default: "MCP gateway". */
  description?: string;
  title?: string;
  websiteUrl?: string;
  /**
   * Protocol revisions the endpoint accepts. Default: what the installed `@modelcontextprotocol/server`
   * supports. A card is advisory; a live `server/discover` wins on disagreement.
   */
  supportedProtocolVersions?: string[];
  /**
   * Also publish the NAMES of the upstreams the gate fronts (under `_meta["me.johnhenry/mcp-gate"].upstreams`).
   * Default false: the card then says nothing about upstreams. URLs and commands are never published.
   */
  listUpstreams?: boolean;
}

/** The card document (a subset of the SEP-2127 schema; extra members are tolerated by readers). */
export interface GateServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title?: string;
  websiteUrl?: string;
  remotes: Array<{ type: "streamable-http"; url: string; supportedProtocolVersions: string[] }>;
  _meta?: Record<string, unknown>;
}

function bad(msg: string): never {
  throw new Error(`invalid gate card: ${msg}`);
}

/**
 * Build the gate's Server Card from its config. `overrides` replaces/extends `config.card`
 * (handy when the public URL is only known at serve time). Throws on a card that would not
 * validate against the schema (bad name, non-http(s) URL, over-long description).
 */
export function gateServerCard(config: Pick<GateConfig, "upstreams" | "card">, overrides: Partial<GateCardConfig> = {}): GateServerCard {
  const c = { ...config.card, ...overrides } as Partial<GateCardConfig>;
  if (!c.url) bad(`"card.url" (the gate's public Streamable HTTP URL) is required`);
  if (!c.name) bad(`"card.name" (reverse-DNS, e.g. com.example/gate) is required`);
  if (c.version === undefined) bad(`"card.version" is required`);
  if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(c.name) || c.name.length < 3 || c.name.length > 200) bad(`"card.name" must be reverse-DNS with exactly one slash, e.g. com.example/gate (got ${JSON.stringify(c.name)})`);
  if (c.version.length > 255) bad(`"card.version" is longer than 255 characters`);
  let u: URL;
  try {
    u = new URL(c.url);
  } catch {
    bad(`"card.url" is not a valid URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") bad(`"card.url" must be http(s)`);
  if (u.username || u.password) bad(`"card.url" must not embed credentials`);
  u.hash = "";
  u.search = "";
  const description = c.description ?? "MCP gateway";
  if (description.length < 1 || description.length > 100) bad(`"card.description" must be 1-100 characters`);
  if (c.title !== undefined && (c.title.length < 1 || c.title.length > 100)) bad(`"card.title" must be 1-100 characters`);
  const versions = c.supportedProtocolVersions ?? [...SUPPORTED_PROTOCOL_VERSIONS];

  const card: GateServerCard = {
    $schema: CARD_SCHEMA_URI,
    name: c.name,
    version: c.version,
    description,
    ...(c.title !== undefined ? { title: c.title } : {}),
    ...(c.websiteUrl !== undefined ? { websiteUrl: c.websiteUrl } : {}),
    remotes: [{ type: "streamable-http", url: u.href, supportedProtocolVersions: versions }],
  };
  if (c.listUpstreams === true) card._meta = { [GATE_CARD_META_KEY]: { upstreams: Object.keys(config.upstreams) } };
  return card;
}

/** Where the card for a given endpoint URL is served (`<url>/server-card`). */
export function gateCardUrl(endpointUrl: string): string {
  const u = new URL(endpointUrl);
  u.search = "";
  u.hash = "";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${CARD_PATH_SUFFIX}`;
  return u.href;
}

/**
 * A web-standard request handler for the card. Returns a `Response` for requests to
 * `<endpoint path>/server-card` and `undefined` for everything else, so it composes in front
 * of your MCP handler:
 *
 *     const card = createGateCardHandler(config);
 *     const respond = (req: Request) => card(req) ?? mcpHandler(req);
 *
 * Only the path is compared (a reverse proxy may rewrite the host). GET/HEAD return the card
 * (`application/mcp-server-card+json`, `Access-Control-Allow-Origin: *` as the SEP allows for public
 * metadata, cacheable); OPTIONS answers the CORS preflight; other methods get 405.
 */
export function createGateCardHandler(config: Pick<GateConfig, "upstreams" | "card">, overrides: Partial<GateCardConfig> = {}): (req: Request) => Response | undefined {
  const card = gateServerCard(config, overrides);
  const cardPath = new URL(gateCardUrl(card.remotes[0]!.url)).pathname;
  const body = JSON.stringify(card);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "accept, if-none-match" };
  return (req) => {
    if (new URL(req.url).pathname.replace(/\/+$/, "") !== cardPath) return undefined;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { ...cors, allow: "GET, HEAD, OPTIONS" } });
    return new Response(req.method === "HEAD" ? null : body, {
      status: 200,
      headers: { ...cors, "content-type": CARD_MEDIA_TYPE, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
    });
  };
}
