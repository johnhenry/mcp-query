// Discovery verbs: `add --from-card`, `add --from-domain`, and `card`. Thin CLI layer over
// `@johnhenry/mcp-query/discovery`. Everything read from a card or catalog is UNTRUSTED and
// is printed through `sanitizeForDisplay`; nothing is registered except by an explicit
// `add` naming exactly one card, and non-interactive runs never prompt.

import type { Client } from "@modelcontextprotocol/client";
import {
  DiscoveryError,
  compareCardToLive,
  connectableRemoteUrl,
  discoverFromDomain,
  fetchServerCard,
  recommendedCardUrl,
  resolveRemote,
  sanitizeForDisplay as clean,
  selectRemote,
  type CardFinding,
  type DiscoveredEntry,
  type DiscoveryOptions,
  type ServerCard,
} from "../../mcp-query/src/discovery/index.js";
import { addServer, getServer, resolveServer, connectClient, type RegistryEntry, type Scope } from "../../mcp-contract/src/index.js";
import { formatResult } from "./format.js";

export interface DiscoveryFlags {
  name?: string;
  fromCard?: string;
  fromDomain?: string;
  pick?: string;
  /** `K=V,K2=V2` values for the card's `{variables}`. */
  vars?: string;
  headers?: Record<string, string>;
  scope?: Scope;
  config?: string;
  description?: string;
  json?: boolean;
  force?: boolean;
  allowInsecureLocalhost?: boolean;
  fetch?: typeof fetch;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

function fetchOpts(f: DiscoveryFlags): DiscoveryOptions {
  return { ...(f.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}), ...(f.fetch ? { fetch: f.fetch } : {}) };
}

function parseVars(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",").filter(Boolean)) {
    const i = part.indexOf("=");
    if (i < 1) throw new Error(`--var expects K=V[,K2=V2], got "${clean(part, 40)}"`);
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function shortName(card: ServerCard): string {
  return card.name.split("/").pop() ?? card.name;
}

function assertRegistryName(name: string): void {
  if (!SAFE_NAME.test(name) || RESERVED.has(name)) throw new Error(`"${clean(name, 60)}" is not a usable server name (letters, digits, . _ -; must start alphanumeric)`);
}

function summary(card: ServerCard, where: string): string {
  const lines = [
    `Server Card from ${where} (untrusted: shown as published, not verified)`,
    `  name         ${clean(card.name)}`,
    `  title        ${clean(card.title ?? "")}`.trimEnd(),
    `  version      ${clean(card.version)}`,
    `  description  ${clean(card.description)}`,
  ];
  if (card.websiteUrl) lines.push(`  website      ${clean(card.websiteUrl)}`);
  if (card.repository) lines.push(`  repository   ${clean(card.repository.url)}`);
  for (const r of card.remotes ?? []) {
    lines.push(`  remote       ${r.type} ${clean(r.url)}${r.supportedProtocolVersions ? `  [${r.supportedProtocolVersions.map((v) => clean(v, 20)).join(", ")}]` : ""}`);
  }
  return lines.filter((l) => l.trim()).join("\n");
}

/** Build the registry entry for a card. Card-provided headers are never written (only listed). */
export function entryFromCard(card: ServerCard, f: DiscoveryFlags): { entry: RegistryEntry; notes: string[] } {
  const remote = selectRemote(card);
  if (!remote) throw new Error(`card "${clean(card.name)}" lists no remotes, so there is nothing to connect to`);
  const resolved = resolveRemote(remote, parseVars(f.vars));
  if (resolved.missing.length) {
    throw new Error(`the card's URL needs values for: ${resolved.missing.map((m) => clean(m, 40)).join(", ")} — pass them with --var ${resolved.missing[0]}=<value>`);
  }
  const url = connectableRemoteUrl(resolved, { allowInsecureLocalhost: f.allowInsecureLocalhost });
  const entry: RegistryEntry = { type: remote.type === "sse" ? "sse" : "http", url, description: f.description ?? clean(card.description, 100) };
  if (f.headers && Object.keys(f.headers).length) entry.headers = f.headers;
  const notes: string[] = [];
  for (const h of resolved.headers) {
    if (h.isRequired && !(f.headers && h.name in f.headers)) {
      notes.push(`the card lists a required header "${clean(h.name, 60)}"${h.isSecret ? " (secret)" : ""}; add it with --header "${clean(h.name, 60)}: <value>" or re-run add`);
    }
  }
  return { entry, notes };
}

function register(name: string, card: ServerCard, f: DiscoveryFlags, where: string): void {
  assertRegistryName(name);
  const { entry, notes } = entryFromCard(card, f);
  if (getServer(name, { config: f.config }) && !f.force) {
    throw new Error(`"${name}" is already registered — choose another name or pass --force to overwrite`);
  }
  console.log(summary(card, where));
  const path = addServer(name, entry, f.scope ?? "home", { config: f.config });
  console.log(`added "${name}" → ${path}  (${entry.type} ${entry.url})`);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`next: mcp-query card ${name}   # compare the card with the live server`);
}

/** `mcp-query add <name> --from-card <url>` */
export async function addFromCard(f: DiscoveryFlags): Promise<void> {
  if (!f.name) throw new Error("usage: mcp-query add <name> --from-card <url>");
  const { card, url } = await fetchServerCard(f.fromCard!, fetchOpts(f));
  register(f.name, card, f, url);
}

function entryRow(e: DiscoveredEntry): Record<string, string> {
  return {
    id: clean(e.identifier, 80),
    name: e.card ? clean(e.card.name, 60) : "",
    version: e.card ? clean(e.card.version, 20) : "",
    remote: e.card ? clean(selectRemote(e.card)?.url ?? "(none)", 70) : e.error ? `error: ${e.error.code}` : "",
    origin: e.sameOrigin === false ? "other origin" : e.source === "data" ? "inline" : "",
  };
}

/** `mcp-query add [<name>] --from-domain <domain> [--pick <id>]` — never prompts. */
export async function addFromDomain(f: DiscoveryFlags): Promise<void> {
  const d = await discoverFromDomain(f.fromDomain!, fetchOpts(f));
  const usable = d.entries.filter((e) => e.card);
  const selector = f.pick ?? f.name;
  const match = selector
    ? usable.filter((e) => e.identifier === selector || e.card!.name === selector || shortName(e.card!) === selector)
    : [];

  if (match.length !== 1) {
    if (f.json) console.log(JSON.stringify({ catalog: d.catalogUrl, entries: d.entries.map(entryRow), skipped: d.skipped }, null, 2));
    else {
      console.log(`${usable.length} MCP server${usable.length === 1 ? "" : "s"} advertised at ${clean(d.catalogUrl)} (untrusted listing):`);
      if (d.entries.length) console.log(formatResult(d.entries.map(entryRow), "human"));
      for (const s of d.skipped) console.log(`  skipped ${s.identifier ? clean(s.identifier, 60) : "(entry)"}: ${clean(s.reason, 100)}`);
    }
    if (!selector) throw new Error("nothing was added — choose one with --pick <id> (an identifier or card name) or give a <name> that matches an entry");
    throw new Error(match.length ? `"${clean(selector, 60)}" matches ${match.length} entries — use the full --pick <identifier>` : `"${clean(selector, 60)}" matches no entry — nothing was added`);
  }

  const e = match[0]!;
  const name = f.name ?? shortName(e.card!);
  register(name, e.card!, f, e.cardUrl ?? `${d.catalogUrl} (inline)`);
}

// ── card ────────────────────────────────────────────────────────────────────────

export interface CardDeps {
  /** Test seam: connect to the live server for `ref`. */
  connectLive?: (ref: string) => Promise<{ client: Client; close: () => Promise<void> }>;
}

export interface CardFlags extends DiscoveryFlags {
  ref?: string;
  noLive?: boolean;
  strict?: boolean;
}

/** `mcp-query card <server|url> [--from-card <url>] [--no-live] [--strict] [--json]` */
export async function showCard(f: CardFlags, deps: CardDeps = {}): Promise<void> {
  let cardUrl = f.fromCard;
  let connectedUrl: string | undefined;
  if (f.ref) {
    const opts = resolveServer(f.ref, { config: f.config });
    connectedUrl = opts.url;
    if (!cardUrl) {
      if (!opts.url) throw new Error(`"${f.ref}" is a stdio server; Server Cards describe remote servers — pass --from-card <url>`);
      cardUrl = recommendedCardUrl(opts.url);
    }
  }
  if (!cardUrl) throw new Error("usage: mcp-query card <server|url> [--from-card <url>] [--no-live] [--strict] [--json]");

  const { card, url } = await fetchServerCard(cardUrl, fetchOpts(f));

  let findings: CardFinding[] = [];
  let liveError: string | undefined;
  let live: Record<string, unknown> | undefined;
  if (f.ref && !f.noLive) {
    try {
      const conn = await (deps.connectLive ?? ((r: string) => connectClient(resolveServer(r, { config: f.config }))))(f.ref);
      try {
        const info = conn.client.getServerVersion();
        const supported = (conn.client.getDiscoverResult?.() as { supportedVersions?: string[] } | undefined)?.supportedVersions;
        const negotiated = conn.client.getNegotiatedProtocolVersion();
        live = { serverInfo: info, negotiatedVersion: negotiated, supportedVersions: supported };
        findings = compareCardToLive(card, {
          serverInfo: info,
          ...(negotiated ? { negotiatedVersion: negotiated } : {}),
          ...(supported ? { supportedVersions: supported } : {}),
          ...(connectedUrl ? { connectedUrl } : {}),
        });
      } finally {
        await conn.close();
      }
    } catch (err) {
      liveError = clean(err instanceof Error ? err.message : String(err), 200);
    }
  }
  const differs = findings.filter((x) => x.kind === "differs");

  if (f.json) {
    console.log(JSON.stringify({ cardUrl: url, card, live: live ?? null, liveError: liveError ?? null, findings }, null, 2));
  } else {
    console.log(summary(card, url));
    if (!f.ref) console.log("\nno live server given — pass a registered name or URL to compare");
    else if (f.noLive) console.log("\nlive comparison skipped (--no-live)");
    else if (liveError) console.log(`\ncould not reach the live server to compare: ${liveError}`);
    else if (!findings.length) console.log("\nlive server agrees with the card (name, version, protocol versions)");
    else {
      console.log("\nlive server vs card (the live values are authoritative):");
      for (const x of findings) console.log(`  ${x.kind === "differs" ? "DIFFERS" : "note   "}  ${clean(x.message, 200)}`);
    }
  }
  if (f.strict && differs.length) throw new Error(`${differs.length} disagreement${differs.length === 1 ? "" : "s"} between the card and the live server`);
}

export { DiscoveryError };
