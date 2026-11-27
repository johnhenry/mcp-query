// The contract model: a versioned snapshot of an MCP server's capability surface
// (tools + their input/output schemas + annotations, resources, templates, prompts,
// and — since format v2 — server capabilities, extensions, protocol versions, tool
// title/icons/_meta, cache hints, skills and event types), plus capture-from-a-live-server
// and a breaking-change classifier built on schema.ts.
//
// Format v2 fields are optional: `undefined` means "not captured" (a v1 file, or the server
// does not expose it), which the drift classifier treats as "nothing to compare".

import type { Client } from "@modelcontextprotocol/client";
import { diffSchema, type JSONSchema, type SchemaChange } from "./schema.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** An `Icon` (SEP-973) exactly as the server sent it. */
export interface ContractIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export interface ContractTool {
  name: string;
  /** Human-readable display name (SEP-973). */
  title?: string;
  description?: string;
  icons?: ContractIcon[];
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}
export interface ContractResource {
  uri: string;
  name?: string;
  mimeType?: string;
}
export interface ContractTemplate {
  uriTemplate: string;
  name?: string;
}
export interface ContractPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; required?: boolean }>;
}

/** SEP-2549 cache hints as observed on a list/discover result (absent field = server omitted it). */
export interface CacheHint {
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

/** Which cacheable results were fetched at capture time, with the hints each carried. */
export interface ContractCacheHints {
  discover?: CacheHint;
  tools?: CacheHint;
  resources?: CacheHint;
  templates?: CacheHint;
  prompts?: CacheHint;
}

export interface ContractProtocol {
  /** `modern` = negotiated via `server/discover` (2026-07-28+), `legacy` = `initialize`. */
  era?: "modern" | "legacy";
  /** The version this capture negotiated. */
  negotiated?: string;
  /** Every version the server advertised in `server/discover` (modern era only). */
  supported?: string[];
}

export interface ContractSkillFile {
  uri: string;
  digest?: string;
  size?: number;
}

/** Skills extension (`io.modelcontextprotocol/skills`) entry: identity + file manifest digests. */
export interface ContractSkill {
  uri: string;
  name?: string;
  description?: string;
  /** The skill's file manifest, or `"dynamic"` for generated content. */
  files?: ContractSkillFile[] | "dynamic";
}

/** Events extension (`io.modelcontextprotocol/events`) event type. */
export interface ContractEvent {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  payloadSchema?: JSONSchema;
  delivery?: string[];
}

export type ContractExtensionSettings = Record<string, unknown>;

/** One transport endpoint a Server Card (SEP-2127) lists. */
export interface ContractCardRemote {
  type: string;
  url: string;
  supportedProtocolVersions?: string[];
}

/**
 * The slice of a remote server's published Server Card worth pinning: identity and where/how to
 * connect. Never tools or capabilities (a card has none). Optional and caller-supplied: capture
 * does not fetch anything itself (see {@link cardForContract}).
 */
export interface ContractCard {
  /** Where the card was read from. Informational: not compared. */
  url?: string;
  name: string;
  remotes: ContractCardRemote[];
}

export interface Contract {
  /** Contract format version. v1 files are upgraded on load (see {@link upgradeContract}). */
  version: 2;
  server?: { name?: string; version?: string; title?: string };
  /** Negotiated protocol era/version and the versions the server supports. */
  protocol?: ContractProtocol;
  /** Server capabilities, minus `extensions` (which live in {@link Contract.extensions}). */
  capabilities?: Record<string, unknown>;
  /** `capabilities.extensions`: extension id → its settings object (`revision` included when sent). */
  extensions?: Record<string, ContractExtensionSettings>;
  /** SEP-2549 hints per cacheable result. */
  cacheHints?: ContractCacheHints;
  tools: ContractTool[];
  resources: ContractResource[];
  templates: ContractTemplate[];
  prompts: ContractPrompt[];
  /** Present only when the skills extension is advertised and `skills/list` answered. */
  skills?: ContractSkill[];
  /** Present only when the events extension is advertised and `events/list` answered. */
  events?: ContractEvent[];
  /** The server's Server Card (SEP-2127), when the capture was given one (`captureContract(client, { card })`). */
  card?: ContractCard;
}

/** The v1 on-disk shape (read-only: v1 files are upgraded, never written). */
export interface ContractV1 {
  version: 1;
  server?: { name?: string; version?: string };
  tools: ContractTool[];
  resources: ContractResource[];
  templates: ContractTemplate[];
  prompts: ContractPrompt[];
}

/**
 * Server-side capabilities in the Deprecated state (SEP-2577; lifecycle per SEP-2596, earliest removal:
 * first revision released on or after 2027-07-28). Shared by mcp-lint and mcp-docs.
 */
export const DEPRECATED_CAPABILITIES: ReadonlyArray<{ key: string; sep: string; migration: string }> = [
  { key: "logging", sep: "SEP-2577", migration: "log to stderr on stdio transports and use OpenTelemetry for observability" },
  { key: "sampling", sep: "SEP-2577", migration: "integrate directly with LLM provider APIs" },
  { key: "roots", sep: "SEP-2577", migration: "pass directories or files via tool parameters, resource URIs, or server configuration" },
];

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/**
 * Parse an on-disk contract of any supported format version into the current model.
 * v1 → v2 only bumps the version: the v2-only fields stay `undefined` ("not captured"), so
 * diffing a v1 pin against a live v2 capture never reports them as additions.
 */
export function upgradeContract(raw: unknown): Contract {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("contract: expected a JSON object");
  const c = raw as Partial<Contract | ContractV1> & { version?: unknown };
  // A missing `version` is read as v1 (hand-written pins and pre-versioning files never had one).
  if (c.version !== undefined && c.version !== 1 && c.version !== 2) {
    throw new Error(`contract: unsupported format version ${JSON.stringify(c.version)} (this build reads 1 and 2)`);
  }
  return {
    ...(c as object),
    version: 2,
    tools: c.tools ?? [],
    resources: c.resources ?? [],
    templates: c.templates ?? [],
    prompts: c.prompts ?? [],
  } as Contract;
}

// ── capture ──────────────────────────────────────────────────────────────────

/** Read the wire-only SEP-2549 hints (hidden from the SDK's public types, passed through by its loose schemas). */
function readHints(result: unknown): CacheHint {
  const r = (result ?? {}) as { ttlMs?: unknown; cacheScope?: unknown };
  const hint: CacheHint = {};
  if (typeof r.ttlMs === "number" && Number.isFinite(r.ttlMs)) hint.ttlMs = r.ttlMs;
  if (r.cacheScope === "public" || r.cacheScope === "private") hint.cacheScope = r.cacheScope;
  return hint;
}

/** Pass-through Standard Schema, so extension methods can be requested without a schema library. */
const PASS_THROUGH = { "~standard": { version: 1, vendor: "mcp-contract", validate: (value: unknown) => ({ value }) } };

/**
 * Page through an extension list method (`skills/list`, `events/list`) with a raw request.
 * Returns `undefined` when the client can't issue raw requests (older/newer SDK shapes) or the
 * call fails for any reason — capture must never break because an extension misbehaves.
 */
async function rawList(client: Client, method: string, key: string): Promise<unknown[] | undefined> {
  const c = client as unknown as { request?: (req: { method: string; params?: unknown }, schema: unknown, opts?: unknown) => Promise<unknown> };
  if (typeof c.request !== "function") return undefined;
  try {
    const out: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = (await c.request({ method, params: cursor ? { cursor } : {} }, PASS_THROUGH, { timeout: 10_000 })) as Record<string, unknown> | undefined;
      const items = page?.[key];
      if (!Array.isArray(items)) return out.length ? out : undefined;
      out.push(...items);
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor);
    return out;
  } catch {
    return undefined;
  }
}

const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

function toSkill(raw: unknown): ContractSkill | undefined {
  const r = raw as { uri?: unknown; frontmatter?: { name?: unknown; description?: unknown }; resources?: unknown } | null;
  if (!r || typeof r.uri !== "string") return undefined;
  const skill: ContractSkill = { uri: r.uri };
  const name = str(r.frontmatter?.name);
  const description = str(r.frontmatter?.description);
  if (name !== undefined) skill.name = name;
  if (description !== undefined) skill.description = description;
  if (r.resources === "dynamic") skill.files = "dynamic";
  else if (Array.isArray(r.resources)) {
    skill.files = r.resources
      .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null && typeof (f as { uri?: unknown }).uri === "string")
      .map((f) => ({ uri: f.uri as string, ...(str(f.digest) ? { digest: f.digest as string } : {}), ...(typeof f.size === "number" ? { size: f.size } : {}) }))
      .sort((a, b) => a.uri.localeCompare(b.uri));
  }
  return skill;
}

function toEvent(raw: unknown): ContractEvent | undefined {
  const r = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; payloadSchema?: unknown; delivery?: unknown } | null;
  if (!r || typeof r.name !== "string") return undefined;
  const ev: ContractEvent = { name: r.name };
  if (str(r.description) !== undefined) ev.description = r.description as string;
  if (r.inputSchema !== undefined) ev.inputSchema = r.inputSchema as JSONSchema;
  if (r.payloadSchema !== undefined) ev.payloadSchema = r.payloadSchema as JSONSchema;
  if (Array.isArray(r.delivery)) ev.delivery = r.delivery.filter((d): d is string => typeof d === "string").sort();
  return ev;
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/** Capture the full capability surface of a *connected* SDK client into a contract. */
export async function captureContract(client: Client, opts: { card?: ContractCard } = {}): Promise<Contract> {
  const caps = client.getServerCapabilities() ?? {};
  const info = client.getServerVersion();
  // Optional getters, read defensively so capture keeps working across SDK 2.x minors.
  const sdk = client as unknown as {
    getDiscoverResult?: () => { supportedVersions?: unknown } | undefined;
    getProtocolEra?: () => string | undefined;
    getNegotiatedProtocolVersion?: () => string | undefined;
  };
  const discover = sdk.getDiscoverResult?.();
  const cacheHints: ContractCacheHints = {};
  if (discover) cacheHints.discover = readHints(discover);

  const tools: ContractTool[] = [];
  if (caps.tools) {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      if (!cursor) cacheHints.tools = readHints(page); // first page; the spec requires the same scope on every page
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as JSONSchema | undefined,
          outputSchema: t.outputSchema as JSONSchema | undefined,
          annotations: t.annotations as ToolAnnotations | undefined,
          ...(t.title !== undefined ? { title: t.title } : {}),
          ...(t.icons?.length ? { icons: t.icons as ContractIcon[] } : {}),
          ...(t._meta && Object.keys(t._meta).length ? { _meta: t._meta } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  const resources: ContractResource[] = [];
  const templates: ContractTemplate[] = [];
  if (caps.resources) {
    const r = await client.listResources().catch(() => undefined);
    if (r) {
      cacheHints.resources = readHints(r);
      for (const x of r.resources) resources.push({ uri: x.uri, name: x.name, mimeType: x.mimeType });
    }
    const t = await client.listResourceTemplates().catch(() => undefined);
    if (t) {
      cacheHints.templates = readHints(t);
      for (const x of t.resourceTemplates) templates.push({ uriTemplate: x.uriTemplate, name: x.name });
    }
  }

  const prompts: ContractPrompt[] = [];
  if (caps.prompts) {
    const p = await client.listPrompts().catch(() => undefined);
    if (p) {
      cacheHints.prompts = readHints(p);
      for (const x of p.prompts) {
        prompts.push({
          name: x.name,
          description: x.description,
          arguments: x.arguments?.map((a) => ({ name: a.name, required: a.required })),
        });
      }
    }
  }

  // Server capabilities: `extensions` are split out so they can be classified on their own.
  const { extensions: rawExtensions, ...otherCaps } = caps as Record<string, unknown> & { extensions?: Record<string, ContractExtensionSettings> };
  const extensions = sortKeys(rawExtensions ?? {});

  // Skills / events are extension methods outside the SDK's typed surface: ask only when the
  // server advertised the extension, via a raw request, and tolerate any failure.
  const skills = extensions[SKILLS_EXTENSION] ? (await rawList(client, "skills/list", "skills"))?.map(toSkill).filter((x): x is ContractSkill => !!x) : undefined;
  const events = extensions[EVENTS_EXTENSION] ? (await rawList(client, "events/list", "events"))?.map(toEvent).filter((x): x is ContractEvent => !!x) : undefined;

  const era = sdk.getProtocolEra?.();
  const supported = Array.isArray(discover?.supportedVersions) ? (discover.supportedVersions as unknown[]).filter((v): v is string => typeof v === "string") : undefined;
  const protocol: ContractProtocol = {
    ...(era === "modern" || era === "legacy" ? { era } : {}),
    ...(sdk.getNegotiatedProtocolVersion?.() ? { negotiated: sdk.getNegotiatedProtocolVersion?.() } : {}),
    ...(supported ? { supported: [...supported].sort() } : {}),
  };

  // Stable ordering so contracts are diff-friendly in version control.
  const byName = <T extends { name?: string; uri?: string; uriTemplate?: string }>(a: T, b: T) =>
    String(a.name ?? a.uri ?? a.uriTemplate).localeCompare(String(b.name ?? b.uri ?? b.uriTemplate));

  return {
    version: 2,
    server: info ? { name: info.name, version: info.version, ...(info.title ? { title: info.title } : {}) } : undefined,
    ...(Object.keys(protocol).length ? { protocol } : {}),
    capabilities: sortKeys(otherCaps),
    extensions,
    cacheHints,
    tools: tools.sort(byName),
    resources: resources.sort(byName),
    templates: templates.sort(byName),
    prompts: prompts.sort(byName),
    ...(skills ? { skills: skills.sort(byName) } : {}),
    ...(events ? { events: events.sort(byName) } : {}),
    ...(opts.card ? { card: opts.card } : {}),
  };
}

/**
 * Reduce a parsed Server Card (e.g. from `fetchServerCard` in `@johnhenry/mcp-query/discovery`) to the
 * part a contract pins. Duck-typed on purpose so this package does not depend on the discovery module.
 */
export function cardForContract(card: { name: string; remotes?: Array<{ type: string; url: string; supportedProtocolVersions?: string[] }> }, url?: string): ContractCard {
  return {
    ...(url ? { url } : {}),
    name: card.name,
    remotes: (card.remotes ?? []).map((r) => ({
      type: r.type,
      url: r.url,
      ...(r.supportedProtocolVersions ? { supportedProtocolVersions: [...r.supportedProtocolVersions].sort() } : {}),
    })),
  };
}

export type ChangeCategory = "tool" | "resource" | "template" | "prompt" | "capability" | "extension" | "protocol" | "skill" | "event" | "card";

/**
 * - `breaking`: a consumer written against the pinned contract can stop working.
 * - `compatible`: additive or cosmetic.
 * - `drift`: content changed under a stable interface (a skill's file digest) — not an interface
 *   break, but a pinned review/approval no longer describes what the server serves.
 */
export type ChangeLevel = "breaking" | "compatible" | "drift";

export interface ContractChange {
  category: ChangeCategory;
  /** The id this change concerns (tool/prompt name, resource uri, template uri, extension id, …). */
  target: string;
  level: ChangeLevel;
  detail: string;
}

export interface ContractDiff {
  changes: ContractChange[];
  breaking: number;
  compatible: number;
  /** Content drift (skill digests changed). Never fails `verify` on its own. */
  drift: number;
}

export interface DiffOptions {
  /**
   * Consumer-driven scoping: only report changes whose target matches one of these
   * (exact id or `*` glob). Omit to report the whole surface. New additions to the
   * surface (which are always compatible) are reported regardless. Scoping applies to
   * tools, resources, templates and prompts; capability/extension/protocol/skill/event
   * changes are always reported.
   */
  used?: string[];
}

function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

const SCOPED: ReadonlySet<ChangeCategory> = new Set(["tool", "resource", "template", "prompt"]);
type Push = (level: ChangeLevel, detail: string) => void;

/** Classify every change between two contracts (prev = pinned, next = live/candidate). v1 inputs are upgraded. */
export function diffContract(prevIn: Contract | ContractV1, nextIn: Contract | ContractV1, opts: DiffOptions = {}): ContractDiff {
  const prev = upgradeContract(prevIn);
  const next = upgradeContract(nextIn);
  const changes: ContractChange[] = [];
  const used = opts.used?.map(globToRe);
  // Additions/cosmetic changes are always reported (as before); only breaking changes are scoped to what the consumer uses.
  const isUsed = (c: ContractChange) => !used || c.level !== "breaking" || !SCOPED.has(c.category) || used.some((re) => re.test(c.target));

  diffCollection(prev.tools, next.tools, (t) => t.name, "tool", changes, (a, b, push) => {
    annotationChanges(a.annotations, b.annotations).forEach((d) => push("breaking", d));
    diffSchema(a.inputSchema, b.inputSchema, "in").forEach((c) => push(c.level, schemaDetail("input", c)));
    diffSchema(a.outputSchema, b.outputSchema, "out").forEach((c) => push(c.level, schemaDetail("output", c)));
    // Display metadata (v2). Only compared when the pin recorded it; changes never break callers.
    if (a.title !== undefined && a.title !== b.title) push("compatible", `title ${JSON.stringify(a.title)} → ${b.title === undefined ? "(none)" : JSON.stringify(b.title)}`);
    if (a.icons !== undefined && !sameJson(a.icons, b.icons)) push("compatible", "icons changed");
    if (a._meta !== undefined && !sameJson(a._meta, b._meta)) push("compatible", "_meta changed");
  });

  diffCollection(prev.resources, next.resources, (r) => r.uri, "resource", changes, (a, b, push) => {
    if (a.mimeType !== b.mimeType) push("compatible", `mimeType ${a.mimeType ?? "?"} → ${b.mimeType ?? "?"}`);
  });

  diffCollection(prev.templates, next.templates, (t) => t.uriTemplate, "template", changes);

  diffCollection(prev.prompts, next.prompts, (p) => p.name, "prompt", changes, (a, b, push) => {
    const pa = new Map((a.arguments ?? []).map((x) => [x.name, x]));
    const pb = new Map((b.arguments ?? []).map((x) => [x.name, x]));
    for (const [name, arg] of pb) {
      const before = pa.get(name);
      if (!before) push(arg.required ? "breaking" : "compatible", arg.required ? `new required argument "${name}"` : `new optional argument "${name}"`);
      else if (!before.required && arg.required) push("breaking", `argument "${name}" became required`);
    }
  });

  // v2 sections: compared only when the pin captured them (undefined = not captured).
  if (prev.capabilities) diffCapabilities(prev.capabilities, next.capabilities ?? {}, changes);
  if (prev.extensions) diffExtensions(prev.extensions, next.extensions ?? {}, changes);
  if (prev.protocol?.supported && next.protocol?.supported) diffProtocol(prev.protocol.supported, next.protocol.supported, changes);
  if (prev.card && next.card) diffCard(prev.card, next.card, changes);
  if (prev.skills) diffCollection(prev.skills, next.skills ?? [], (k) => k.uri, "skill", changes, diffSkill);
  if (prev.events) diffCollection(prev.events, next.events ?? [], (e) => e.name, "event", changes, diffEvent);

  const scoped = changes.filter(isUsed);
  return {
    changes: scoped,
    breaking: scoped.filter((c) => c.level === "breaking").length,
    compatible: scoped.filter((c) => c.level === "compatible").length,
    drift: scoped.filter((c) => c.level === "drift").length,
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function diffCapabilities(prev: Record<string, unknown>, next: Record<string, unknown>, out: ContractChange[]): void {
  const push = (target: string, level: ChangeLevel, detail: string) => out.push({ category: "capability", target, level, detail });
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
  for (const key of Object.keys(prev)) {
    if (!(key in next)) {
      push(key, "breaking", "capability removed");
      continue;
    }
    // Sub-flags that consumers rely on: `listChanged` / `subscribe` turning off is breaking.
    const a = prev[key];
    const b = next[key];
    if (isObj(a)) {
      for (const flag of ["listChanged", "subscribe"]) {
        if (a[flag] === true && !(isObj(b) && b[flag] === true)) push(`${key}.${flag}`, "breaking", "no longer advertised");
        else if (a[flag] !== true && isObj(b) && b[flag] === true) push(`${key}.${flag}`, "compatible", "now advertised");
      }
    }
  }
  for (const key of Object.keys(next)) if (!(key in prev)) push(key, "compatible", "capability added");
}

function diffExtensions(prev: Record<string, ContractExtensionSettings>, next: Record<string, ContractExtensionSettings>, out: ContractChange[]): void {
  const push = (target: string, level: ChangeLevel, detail: string) => out.push({ category: "extension", target, level, detail });
  const rev = (e: ContractExtensionSettings | undefined) => (e?.revision === undefined ? undefined : String(e.revision));
  for (const [id, a] of Object.entries(prev)) {
    const b = next[id];
    if (!b) {
      push(id, "breaking", "extension removed");
      continue;
    }
    const ra = rev(a);
    const rb = rev(b);
    if (ra !== rb) {
      // A pinned revision that moved or disappeared is breaking; a revision appearing where none was pinned is not.
      push(id, ra === undefined ? "compatible" : "breaking", `revision ${ra ?? "(none)"} → ${rb ?? "(none)"}`);
    }
  }
  for (const id of Object.keys(next)) if (!(id in prev)) push(id, "compatible", "extension added");
}

function diffProtocol(prev: string[], next: string[], out: ContractChange[]): void {
  const have = new Set(next);
  for (const v of prev) if (!have.has(v)) out.push({ category: "protocol", target: v, level: "breaking", detail: "protocol version no longer supported" });
  const had = new Set(prev);
  for (const v of next) if (!had.has(v)) out.push({ category: "protocol", target: v, level: "compatible", detail: "protocol version added" });
}

// A card is advisory, but a pinned one says where consumers connect and what they can speak: a removed
// endpoint or a dropped protocol version breaks them; a changed card name is drift (identity moved).
// Only compared when both sides captured a card.
function diffCard(prev: ContractCard, next: ContractCard, out: ContractChange[]): void {
  const push = (target: string, level: ChangeLevel, detail: string) => out.push({ category: "card", target, level, detail });
  if (prev.name !== next.name) push("name", "drift", `card name ${JSON.stringify(prev.name)} → ${JSON.stringify(next.name)}`);
  const after = new Map(next.remotes.map((r) => [r.url, r]));
  const before = new Map(prev.remotes.map((r) => [r.url, r]));
  for (const [url, a] of before) {
    const b = after.get(url);
    if (!b) {
      push(url, "breaking", "endpoint no longer listed in the card");
      continue;
    }
    if (a.type !== b.type) push(url, "breaking", `transport ${a.type} → ${b.type}`);
    if (a.supportedProtocolVersions && b.supportedProtocolVersions) {
      const have = new Set(b.supportedProtocolVersions);
      for (const v of a.supportedProtocolVersions) if (!have.has(v)) push(url, "breaking", `card no longer lists protocol version ${v}`);
      const had = new Set(a.supportedProtocolVersions);
      for (const v of b.supportedProtocolVersions) if (!had.has(v)) push(url, "compatible", `card now lists protocol version ${v}`);
    } else if (a.supportedProtocolVersions && !b.supportedProtocolVersions) {
      push(url, "breaking", "card no longer lists supportedProtocolVersions");
    }
  }
  for (const url of after.keys()) if (!before.has(url)) push(url, "compatible", "endpoint added to the card");
}

function diffSkill(a: ContractSkill, b: ContractSkill, push: Push): void {
  if (a.files === undefined || b.files === undefined) return;
  if (a.files === "dynamic" || b.files === "dynamic") {
    if (a.files !== b.files) push("drift", `file manifest ${a.files === "dynamic" ? "dynamic" : "static"} → ${b.files === "dynamic" ? "dynamic" : "static"}`);
    return;
  }
  const before = new Map(a.files.map((f) => [f.uri, f.digest]));
  const after = new Map(b.files.map((f) => [f.uri, f.digest]));
  for (const [uri, digest] of before) {
    if (!after.has(uri)) push("drift", `file removed: ${uri}`);
    else if (digest !== after.get(uri)) push("drift", `content changed: ${uri}`);
  }
  for (const uri of after.keys()) if (!before.has(uri)) push("drift", `file added: ${uri}`);
}

function diffEvent(a: ContractEvent, b: ContractEvent, push: Push): void {
  // Subscription arguments are caller-supplied (input, contravariant); the payload is produced (output, covariant),
  // so a payloadSchema that dropped or narrowed what it produces breaks consumers.
  diffSchema(a.inputSchema, b.inputSchema, "in").forEach((c) => push(c.level, schemaDetail("input", c)));
  diffSchema(a.payloadSchema, b.payloadSchema, "out").forEach((c) => push(c.level, schemaDetail("payload", c)));
  if (a.delivery && b.delivery) {
    for (const m of a.delivery) if (!b.delivery.includes(m)) push("breaking", `delivery mode "${m}" removed`);
    for (const m of b.delivery) if (!a.delivery.includes(m)) push("compatible", `delivery mode "${m}" added`);
  }
}

function schemaDetail(which: string, c: SchemaChange): string {
  return `${which} ${c.path || "(root)"}: ${c.detail}`;
}

function annotationChanges(a: ToolAnnotations | undefined, b: ToolAnnotations | undefined): string[] {
  const out: string[] = [];
  // Policy-relevant flips: gaining destructive, or losing read-only, are breaking.
  if (!a?.destructiveHint && b?.destructiveHint) out.push("now flagged destructive");
  if (a?.readOnlyHint && !b?.readOnlyHint) out.push("no longer read-only");
  return out;
}

/** Generic add/remove/changed walk over a keyed collection. */
function diffCollection<T>(
  prev: T[],
  next: T[],
  key: (x: T) => string,
  category: ChangeCategory,
  changes: ContractChange[],
  onBoth?: (a: T, b: T, push: Push) => void,
): void {
  const prevMap = new Map(prev.map((x) => [key(x), x]));
  const nextMap = new Map(next.map((x) => [key(x), x]));
  for (const [k, a] of prevMap) {
    const b = nextMap.get(k);
    if (!b) {
      changes.push({ category, target: k, level: "breaking", detail: "removed" });
      continue;
    }
    onBoth?.(a, b, (level, detail) => changes.push({ category, target: k, level, detail }));
  }
  for (const [k] of nextMap) {
    if (!prevMap.has(k)) changes.push({ category, target: k, level: "compatible", detail: "added" });
  }
}
