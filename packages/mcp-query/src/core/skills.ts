// Skills over MCP (`io.modelcontextprotocol/skills`, SEP-2640) — the host side.
//
// Thin, cached, reactive layer over the official SDK's `SkillsClient`
// (`@modelcontextprotocol/client/ext/skills`, SDK >= 2.4.0). Verification of
// every skill file (size, sha256 digest, SKILL.md frontmatter vs. the listed
// entry) is the SDK's — nothing here re-implements it. This module adds:
//
//   - a lazy, dynamic import of the SDK subpath (the peer range is ^2.0.0 and the
//     subpath only exists from 2.4.0, so older SDKs get a clear MCPError);
//   - caching under mcp-query's SEP-2549 ttl/scope handling, per server and per
//     `client.scope()` partition; skill files are keyed by their manifest DIGEST
//     so a changed manifest can never serve stale bytes;
//   - invalidation on resources list_changed (wired by MCPClient);
//   - every skill carries the `server` it came from — skill content is
//     instructions to a model, so treat it like a tool description.
//
// Not in this module (tracked in the issue): InteractionBroker approval of
// "load this skill", the tanstack `skillsQueryOptions`, mcp-gate pass-through.

import type { MCPCache } from "./cache.js";
import type { CallContext } from "./client.js";
import { cacheScope, cacheTtl, type ServerConnection } from "./connection.js";
import type { CacheKey } from "./keys.js";
import { serverTag, type Tag } from "./tags.js";
import { SKILLS_EXT, SKILLS_MIN_SDK } from "./skillsExt.js";
import { MCPError } from "./types.js";

export { SKILLS_EXT, SKILLS_MIN_SDK };

/** Tag carried by every cached skills catalog entry for `server`; invalidated by resources list_changed. */
export const skillsTag = (server: string): Tag => `skills:${server}`;

// ── public types ─────────────────────────────────────────────────────────────

/** A skill's `SKILL.md` frontmatter, verbatim from the server. */
export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

/** One file in a skill's manifest. */
export interface SkillManifestEntry {
  uri: string;
  /** `sha256:` + 64 lowercase hex characters. */
  digest: string;
  size: number;
}

/**
 * One skill entry, tagged with the server that published it. `resources` is the
 * manifest every file is verified against, or `"dynamic"` (files are NOT verified).
 */
export interface Skill extends SkillEntry {
  /** The server this skill came from — keep it attached wherever the skill goes. */
  server: string;
}

/** A skill entry exactly as the SDK / wire carries it (no `server`). */
export interface SkillEntry {
  uri: string;
  frontmatter: SkillFrontmatter;
  resources: SkillManifestEntry[] | "dynamic";
  [key: string]: unknown;
}

/** A skill file as read and verified by the SDK. */
export interface SkillFile {
  server: string;
  uri: string;
  mimeType?: string;
  /** Exactly the bytes the manifest digest covers. */
  bytes: Uint8Array;
  text?: string;
  /** Size and digest were checked. `false` only for `"dynamic"` skills. */
  verified: boolean;
  /** The skill's own `SKILL.md` only: parsed frontmatter, equal to the entry's. */
  frontmatter?: Record<string, unknown>;
  /** The skill's own `SKILL.md` only: the markdown after the frontmatter. */
  body?: string;
}

/** Why the SDK refused a skill file. Mirrors `SkillVerificationReason`. */
export type SkillVerificationReason = "unlisted" | "size" | "digest" | "frontmatter";

/** `MCPError.data` of a verification failure. */
export interface SkillVerificationData {
  skillVerification: { reason: SkillVerificationReason; uri: string; differences: readonly string[] };
}

export interface SkillOpts {
  /** Override the freshness window (ms); default is the server's `ttlMs`, else the cache default. */
  staleTime?: number;
  /** Bypass the cache and re-fetch. */
  force?: boolean;
  signal?: AbortSignal;
  /** `partition` namespaces the cache (use `client.scope({ partition })`). */
  context?: CallContext;
}

export interface ListSkillsOpts extends SkillOpts {
  /** With no `server`: called when one server's listing fails (that server is skipped). */
  onError?: (server: string, error: MCPError) => void;
}

/** The `MCPError.data.skillVerification.reason` of an error, if it is a verification failure. */
export function skillVerificationReason(err: unknown): SkillVerificationReason | undefined {
  return (err as { data?: Partial<SkillVerificationData> } | undefined)?.data?.skillVerification?.reason;
}

// ── the lazily loaded SDK module (structural types; the subpath may be absent) ─

interface SdkSkillsClient {
  list(params?: { cursor?: string }, options?: { signal?: AbortSignal }): Promise<{
    skills: SkillEntry[];
    ttlMs?: number;
    cacheScope?: "public" | "private";
  }>;
  get(uri: string, options?: { signal?: AbortSignal }): Promise<{
    skill: SkillEntry;
    ttlMs?: number;
    cacheScope?: "public" | "private";
  }>;
  read(skill: SkillEntry, ref?: string, options?: { signal?: AbortSignal }): Promise<Omit<SkillFile, "server">>;
}

/** The slice of `@modelcontextprotocol/client/ext/skills` this module uses. */
export interface SkillsSdk {
  SkillsClient: new (client: unknown, options?: Record<string, unknown>) => SdkSkillsClient;
  SkillVerificationError?: new (...args: never[]) => Error & {
    reason: SkillVerificationReason;
    uri: string;
    differences: readonly string[];
  };
}

/** A loader for the SDK's skills module (see `MCPClientConfig.skillsSdk`). */
export type SkillsSdkLoader = () => Promise<SkillsSdk>;

const SDK_SPECIFIER = "@modelcontextprotocol/client/ext/skills";
let defaultSdk: Promise<SkillsSdk> | undefined;

/**
 * Default loader: a runtime `import()` of the SDK subpath through a variable
 * specifier, so bundlers and type-checkers never require it to exist (older
 * SDKs keep working untouched). Bundled browser apps should pass
 * `skillsSdk: () => import("@modelcontextprotocol/client/ext/skills")` in the
 * client config instead — a bundler can resolve that literal import.
 */
export function loadSkillsSdk(): Promise<SkillsSdk> {
  defaultSdk ??= import(/* @vite-ignore */ /* webpackIgnore: true */ SDK_SPECIFIER).then(
    (m) => m as SkillsSdk,
    (cause: unknown) => {
      defaultSdk = undefined; // let a later call retry (e.g. after an install)
      throw sdkMissing(cause);
    },
  );
  return defaultSdk;
}

function sdkMissing(cause: unknown): MCPError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new MCPError(
    "protocol",
    `Skills over MCP needs @modelcontextprotocol/client >= ${SKILLS_MIN_SDK} (it provides "${SDK_SPECIFIER}"); ` +
      `the installed SDK does not expose it. Upgrade @modelcontextprotocol/client (and /server) to ${SKILLS_MIN_SDK} or newer. ` +
      `Underlying error: ${detail}`,
    undefined,
    undefined,
    { requires: `@modelcontextprotocol/client@>=${SKILLS_MIN_SDK}`, cause: detail },
  );
}

/** True when the installed SDK ships `ext/skills` (resolves the default loader). */
export async function skillsSdkAvailable(loader: SkillsSdkLoader = loadSkillsSdk): Promise<boolean> {
  try {
    await loader();
    return true;
  } catch {
    return false;
  }
}

// ── the controller ───────────────────────────────────────────────────────────

/** What the controller needs from MCPClient (closures over its private members). */
export interface SkillsHost {
  cache: MCPCache;
  connection(server: string): ServerConnection | undefined;
  connections(): ServerConnection[];
  /** Wake a possibly lazy server. */
  wake(server: string): Promise<void>;
  /** MCPClient's SDK-error → MCPError mapping. */
  toError(err: unknown, server: string): MCPError;
  loader?: SkillsSdkLoader;
}

type Cacheable = { ttlMs?: number; cacheScope?: "public" | "private" };

export class SkillsController {
  /** One SDK SkillsClient per live SDK Client (a reconnect builds a new Client). */
  private readonly clients = new WeakMap<object, SdkSkillsClient>();

  constructor(private readonly host: SkillsHost) {}

  /** `skills/list` for one server (cached), or the tagged union across every skills-capable server. */
  async list(server?: string, opts: ListSkillsOpts = {}): Promise<Skill[]> {
    if (server !== undefined) return this.listOne(server, opts);
    const targets = this.host.connections().filter((c) => c.supports("skills"));
    const settled = await Promise.allSettled(targets.map((c) => this.listOne(c.name, opts)));
    const out: Skill[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") out.push(...r.value);
      else opts.onError?.(targets[i]!.name, this.host.toError(r.reason, targets[i]!.name));
    });
    return out;
  }

  /** `skills/get` by `SKILL.md` URI (listed or not), cached. */
  async get(uri: string, server: string, opts: SkillOpts = {}): Promise<Skill> {
    const conn = await this.ready(server);
    const key: CacheKey = { kind: "skill", server, uri, partition: opts.context?.partition };
    const hit = this.fresh<Skill>(key, opts);
    if (hit) return hit;
    return this.dedupe(key, async () => {
      const sc = await this.skillsClient(conn);
      const res = await sc.get(uri, { signal: opts.signal });
      const skill: Skill = { ...res.skill, server };
      this.write(key, skill, server, res, opts);
      return skill;
    });
  }

  /**
   * Read one file of `skill` (default: its `SKILL.md`), verified by the SDK
   * against the skill's manifest. Verified bytes are cached by manifest digest;
   * `"dynamic"` skills are never cached and come back `verified: false`.
   */
  async readFile(skill: Skill, ref?: string, opts: SkillOpts = {}): Promise<SkillFile> {
    const server = skill.server;
    if (typeof server !== "string" || !server) {
      throw new MCPError("protocol", "readSkillFile: the skill has no `server` — pass an entry from listSkills()/getSkill()");
    }
    const conn = await this.ready(server);
    const entry = manifestEntryFor(skill, ref);
    const key: CacheKey | undefined = entry
      ? { kind: "skillFile", server, uri: entry.uri, digest: entry.digest, partition: opts.context?.partition }
      : undefined;
    if (key && !opts.force) {
      const snap = this.host.cache.getSnapshot(key);
      if (snap?.status === "success") return snap.data as SkillFile;
    }
    const load = async (): Promise<SkillFile> => {
      const sc = await this.skillsClient(conn);
      const { server: _s, ...sdkEntry } = skill;
      let file: Omit<SkillFile, "server">;
      try {
        file = await sc.read(sdkEntry, ref, { signal: opts.signal });
      } catch (err) {
        throw await this.fail(err, server);
      }
      const out: SkillFile = { ...file, server };
      // Only verified bytes are ever cached, and only under their digest.
      if (key && out.verified) this.host.cache.write(key, out, { staleTime: Infinity, tags: [] });
      return out;
    };
    return key ? this.dedupe(key, load, true) : load();
  }

  /** Mark every cached skills catalog entry of `server` stale (resources list_changed). */
  invalidate(server: string): void {
    this.host.cache.invalidateTags([skillsTag(server)], false);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async listOne(server: string, opts: ListSkillsOpts): Promise<Skill[]> {
    const conn = await this.ready(server);
    const key: CacheKey = { kind: "skillList", server, partition: opts.context?.partition };
    const hit = this.fresh<Skill[]>(key, opts);
    if (hit) return hit;
    return this.dedupe(key, async () => {
      const sc = await this.skillsClient(conn);
      const listing = await sc.list(undefined, { signal: opts.signal });
      const skills: Skill[] = listing.skills.map((s) => ({ ...s, server }));
      this.write(key, skills, server, listing, opts);
      return skills;
    });
  }

  private async ready(server: string): Promise<ServerConnection> {
    await this.host.wake(server);
    const conn = this.host.connection(server);
    if (!conn) {
      const known = this.host.connections().map((c) => c.name).join(", ") || "(none)";
      throw new MCPError("protocol", `unknown server "${server}"; configured: ${known}`, server);
    }
    if (!conn.supports("skills")) {
      throw new MCPError("protocol", `server "${server}" does not advertise the skills extension (${SKILLS_EXT})`, server);
    }
    return conn;
  }

  private async skillsClient(conn: ServerConnection): Promise<SdkSkillsClient> {
    const sdk = await (this.host.loader ?? loadSkillsSdk)().catch((e: unknown) => {
      throw e instanceof MCPError ? e : sdkMissing(e); // a custom loader's raw failure gets the same clear message
    });
    const raw = conn.sdk as object;
    let sc = this.clients.get(raw);
    if (!sc) {
      sc = new sdk.SkillsClient(raw);
      this.clients.set(raw, sc);
    }
    return sc;
  }

  private fresh<T>(key: CacheKey, opts: SkillOpts): T | undefined {
    if (opts.force) return undefined;
    const snap = this.host.cache.getSnapshot(key);
    if (snap?.status === "success" && !this.host.cache.isStale(key)) return snap.data as T;
    return undefined;
  }

  private write(key: CacheKey, data: unknown, server: string, res: Cacheable, opts: SkillOpts): void {
    this.host.cache.write(key, data, {
      staleTime: opts.staleTime ?? cacheTtl(res),
      tags: [serverTag(server), skillsTag(server)],
      scope: cacheScope(res),
    });
  }

  /** Share one in-flight request per key; failures land on the entry (like every other read). */
  private dedupe<T>(key: CacheKey, run: () => Promise<T>, silent = false): Promise<T> {
    const existing = this.host.cache.inflight(key) as Promise<T> | undefined;
    if (existing) return existing;
    const server = key.server;
    if (!silent) this.host.cache.setFetching(key);
    const p = (async () => {
      try {
        return await run();
      } catch (err) {
        const mapped = err instanceof MCPError ? err : await this.fail(err, server);
        if (!silent) this.host.cache.setError(key, mapped);
        throw mapped;
      } finally {
        this.host.cache.setInflight(key, undefined);
      }
    })();
    this.host.cache.setInflight(key, p);
    return p;
  }

  /** Preserve the SDK's verification reason on the MCPError; everything else goes through the client's mapping. */
  private async fail(err: unknown, server: string): Promise<MCPError> {
    if (err instanceof MCPError) return err;
    const v = err as { name?: string; reason?: unknown; uri?: unknown; differences?: unknown; message?: string };
    if (v?.name === "SkillVerificationError" && typeof v.reason === "string") {
      const out = new MCPError(
        "protocol",
        v.message ?? "skill verification failed",
        server,
        undefined,
        {
          skillVerification: {
            reason: v.reason as SkillVerificationReason,
            uri: String(v.uri ?? ""),
            differences: Array.isArray(v.differences) ? (v.differences as string[]) : [],
          },
        } satisfies SkillVerificationData,
        typeof v.uri === "string" ? v.uri : undefined,
      );
      if (err instanceof Error && err.stack) out.stack = err.stack;
      return out;
    }
    return this.host.toError(err, server);
  }
}

/**
 * The manifest entry `ref` names (default: the skill's own SKILL.md), when it
 * can be resolved without ambiguity; undefined for dynamic skills and for refs
 * the manifest does not list (the SDK then rejects them as `unlisted`).
 */
function manifestEntryFor(skill: Skill, ref?: string): SkillManifestEntry | undefined {
  if (skill.resources === "dynamic") return undefined;
  const bare = (ref ?? skill.uri).split("#")[0]!;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(bare) ? bare : resolveAgainstSkillRoot(skill.uri, bare);
  return skill.resources.find((r) => r.uri === absolute);
}

function resolveAgainstSkillRoot(skillMdUri: string, rel: string): string {
  const slash = skillMdUri.lastIndexOf("/");
  const root = slash >= 0 ? skillMdUri.slice(0, slash + 1) : skillMdUri;
  return root + rel.replace(/^\.\//, "");
}
