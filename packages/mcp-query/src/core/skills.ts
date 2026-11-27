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
//   - `resources/directory/read` (when the server advertises `directoryRead`);
//   - `CallContext.meta` forwarded as `_meta` on every skills request: the SDK's
//     `SkillsClient` accepts no `_meta`, so a per-call Proxy over the SDK `Client`
//     injects it into the params of `request()` / `readResource()`;
//   - an opt-in "load this skill" approval through the InteractionBroker, bound to
//     the manifest's digest set (see `SkillApprovalConfig`);
//   - verified files in the configured L2 `cacheStore`, re-verified against the
//     manifest digest on every read-back (a shared store is never trusted).
//
// Not in this module: mcp-gate pass-through (#82) and the CLI verbs (#87).

import type { MCPCache } from "./cache.js";
import type { CacheStore } from "./cacheStore.js";
import type { CallContext } from "./client.js";
import { cacheScope, cacheTtl, type ServerConnection } from "./connection.js";
import type { InteractionBroker } from "./interactions.js";
import { serializeKey, type CacheKey } from "./keys.js";
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

/** One direct child of a skill directory (`resources/directory/read`). NOT verified: discovery only. */
export interface SkillDirectoryEntry {
  uri: string;
  name?: string;
  /** `inode/directory` for a sub-directory. */
  mimeType?: string;
  size?: number;
  description?: string;
  [key: string]: unknown;
}

/** The result of `client.readSkillDirectory()`, tagged with the server it came from. */
export interface SkillDirectory {
  server: string;
  /** The directory that was read. */
  uri: string;
  resources: SkillDirectoryEntry[];
}

/**
 * Opt-in approval of "load this skill" (`MCPClientConfig.skillApproval`). Needs
 * `MCPClientConfig.interactions`. The first read of any file of a skill asks the broker
 * (`broker.gate("confirm", server, { action: "skill-load", ... })`); the approval is
 * remembered per (partition, server, skill, manifest digest set), so a manifest that
 * changes asks again. `"dynamic"` skills have no digest set to bind to and ask on every read.
 * Denied (or timed out) => an `MCPError` and nothing is read or cached.
 */
export interface SkillApprovalConfig {
  /** Bound the human wait (ms); on expiry the load is denied. Default: wait forever. */
  timeoutMs?: number;
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
  readDirectory?(uri: string, options?: { signal?: AbortSignal }): Promise<{
    resources: SkillDirectoryEntry[];
    ttlMs?: number;
    cacheScope?: "public" | "private";
  }>;
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
  /** The request `_meta` for a call (context meta + the modern-era log level); MCPClient's `withMeta`. */
  meta?(conn: ServerConnection, context?: CallContext): Record<string, unknown> | undefined;
  /** Opt-in "load this skill" approval; needs the broker. */
  approval?: { broker: InteractionBroker; config: SkillApprovalConfig };
  /** Optional L2 store: verified skill files are read-through / written-through (digest re-checked on read). */
  cacheStore?: CacheStore;
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
      const sc = await this.skillsClient(conn, opts.context);
      const res = await sc.get(uri, { signal: opts.signal });
      const skill: Skill = { ...res.skill, server };
      this.write(key, skill, server, res, opts);
      return skill;
    });
  }

  /**
   * Read one file of `skill` (default: its `SKILL.md`), verified by the SDK
   * against the skill's manifest. Verified bytes are cached by manifest digest
   * (L1, and the L2 `cacheStore` when one is configured); `"dynamic"` skills are
   * never cached and come back `verified: false`. With `skillApproval` on, the
   * first read of a skill (per manifest) is gated by the InteractionBroker.
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
    await this.approve(skill, ref, opts);
    if (key && !opts.force) {
      const snap = this.host.cache.getSnapshot(key);
      if (snap?.status === "success") return snap.data as SkillFile;
    }
    const load = async (): Promise<SkillFile> => {
      if (key && entry && !opts.force) {
        const fromL2 = await this.l2Read(key, skill, entry, ref);
        if (fromL2) {
          this.host.cache.write(key, fromL2, { staleTime: Infinity, tags: [] });
          return fromL2;
        }
      }
      const sc = await this.skillsClient(conn, opts.context);
      const { server: _s, ...sdkEntry } = skill;
      let file: Omit<SkillFile, "server">;
      try {
        file = await sc.read(sdkEntry, ref, { signal: opts.signal });
      } catch (err) {
        throw await this.fail(err, server);
      }
      const out: SkillFile = { ...file, server };
      // Only verified bytes are ever cached, and only under their digest.
      if (key && out.verified) {
        this.host.cache.write(key, out, { staleTime: Infinity, tags: [] });
        if (entry) void this.l2Write(key, skill, entry, out, ref);
      }
      return out;
    };
    return key ? this.dedupe(key, load, true) : load();
  }

  /**
   * `resources/directory/read`: the direct children of a skill directory (cached per the
   * server's `ttlMs`/`cacheScope`). Needs the `directoryRead` capability. Entries are NOT
   * verified — discovery only; read files through `readFile` so they are checked against the manifest.
   */
  async readDirectory(uri: string, server: string, opts: SkillOpts = {}): Promise<SkillDirectory> {
    const conn = await this.ready(server);
    if (!directoryReadAdvertised(conn)) {
      throw new MCPError(
        "protocol",
        `server "${server}" does not advertise directoryRead for the skills extension (${SKILLS_EXT}); resources/directory/read is unavailable — use the skill's manifest (getSkill) instead`,
        server,
        undefined,
        { requires: "directoryRead" },
        uri,
      );
    }
    const key: CacheKey = { kind: "skillDir", server, uri, partition: opts.context?.partition };
    const hit = this.fresh<SkillDirectory>(key, opts);
    if (hit) return hit;
    return this.dedupe(key, async () => {
      const sc = await this.skillsClient(conn, opts.context);
      if (!sc.readDirectory) throw sdkMissing(new Error("the installed SDK's SkillsClient has no readDirectory()"));
      const res = await sc.readDirectory(uri, { signal: opts.signal });
      const dir: SkillDirectory = { server, uri, resources: res.resources };
      this.write(key, dir, server, res, opts);
      return dir;
    });
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
      const sc = await this.skillsClient(conn, opts.context);
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

  private async skillsClient(conn: ServerConnection, context?: CallContext): Promise<SdkSkillsClient> {
    const sdk = await (this.host.loader ?? loadSkillsSdk)().catch((e: unknown) => {
      throw e instanceof MCPError ? e : sdkMissing(e); // a custom loader's raw failure gets the same clear message
    });
    const raw = conn.sdk as object;
    // The SDK's SkillsClient takes no `_meta`; with caller meta, build a one-shot client over a
    // meta-injecting view of the SDK Client (cheap: the constructor only stores its arguments).
    const meta = this.host.meta?.(conn, context);
    if (meta && Object.keys(meta).length > 0) return new sdk.SkillsClient(withRequestMeta(raw, meta));
    let sc = this.clients.get(raw);
    if (!sc) {
      sc = new sdk.SkillsClient(raw);
      this.clients.set(raw, sc);
    }
    return sc;
  }

  // ── approval ───────────────────────────────────────────────────────────────

  /** Approved (partition, server, skill, manifest digest set) tuples. */
  private readonly approved = new Set<string>();
  private readonly approving = new Map<string, Promise<void>>();

  private async approve(skill: Skill, ref: string | undefined, opts: SkillOpts): Promise<void> {
    const cfg = this.host.approval;
    if (!cfg) return;
    const manifest = skill.resources === "dynamic" ? undefined : skill.resources;
    const fingerprint = manifest ? await manifestFingerprint(manifest) : undefined;
    // A dynamic skill has no digest set to bind an approval to, so it asks on every read.
    const id = fingerprint ? `${opts.context?.partition ?? ""}\0${skill.server}\0${skill.uri}\0${fingerprint}` : undefined;
    if (id && this.approved.has(id)) return;
    const pending = id ? this.approving.get(id) : undefined;
    if (pending) return pending;
    const run = (async () => {
      const payload = {
        action: "skill-load",
        server: skill.server,
        skill: { uri: skill.uri, name: skill.frontmatter?.name, description: skill.frontmatter?.description },
        file: ref ?? skill.uri,
        manifest: manifest
          ? { digest: fingerprint, files: manifest.length, bytes: manifest.reduce((n, r) => n + r.size, 0), entries: manifest }
          : "dynamic",
        verified: manifest !== undefined,
        partition: opts.context?.partition,
      };
      const { verdict, decision } = await cfg.broker.gate("confirm", skill.server, payload, {
        autoApprove: { action: "approve" },
        autoDeny: { action: "deny", reason: "policy" },
        timeoutMs: cfg.config.timeoutMs,
      });
      if (verdict === "auto-deny" || verdict === "denied") {
        const why = decision?.reason ? ` (${decision.reason})` : "";
        throw new MCPError(
          "protocol",
          `loading skill "${skill.frontmatter?.name ?? skill.uri}" from "${skill.server}" was not approved${why}`,
          skill.server,
          -32001,
          { skillApproval: { outcome: "denied", uri: skill.uri, reason: decision?.reason } },
          skill.uri,
        );
      }
      if (id) this.approved.add(id);
    })();
    if (!id) return run;
    this.approving.set(id, run);
    try {
      await run;
    } finally {
      this.approving.delete(id);
    }
  }

  // ── L2 (shared cacheStore) for verified files ──────────────────────────────

  /** The catalog's sharing scope for `skill` (from the cached skills/get or skills/list entry), if known. */
  private catalogScope(skill: Skill, partition: string | undefined): "public" | "private" | undefined {
    const c = this.host.cache;
    return (
      c.getSnapshot({ kind: "skill", server: skill.server, uri: skill.uri, partition })?.scope ??
      c.getSnapshot({ kind: "skillList", server: skill.server, partition })?.scope
    );
  }

  private async l2Read(key: CacheKey, skill: Skill, entry: SkillManifestEntry, ref: string | undefined): Promise<SkillFile | undefined> {
    const store = this.host.cacheStore;
    if (!store) return undefined;
    try {
      const stored = (await store.get(serializeKey(key)))?.data as StoredSkillFile | undefined;
      if (!stored || stored.v !== 1 || typeof stored.bytes !== "string") return undefined;
      const bytes = fromBase64(stored.bytes);
      // A shared store is never trusted: the bytes must still match the manifest this
      // client holds, exactly as the SDK checks a fresh read.
      if (bytes.byteLength !== entry.size || (await sha256Digest(bytes)) !== entry.digest) return undefined;
      const own = isOwnSkillMd(skill, entry.uri);
      const text = stored.hasText ? new TextDecoder().decode(bytes) : undefined;
      const out: SkillFile = { server: skill.server, uri: typeof stored.uri === "string" ? stored.uri : entry.uri, bytes, verified: true };
      if (stored.mimeType !== undefined) out.mimeType = stored.mimeType;
      if (text !== undefined) out.text = text;
      if (own) {
        // The entry's frontmatter was verified equal to SKILL.md's; the body is a suffix of the verified bytes.
        if (text === undefined || !Number.isInteger(stored.bodyStart) || stored.bodyStart! < 0 || stored.bodyStart! > text.length) return undefined;
        out.frontmatter = skill.frontmatter;
        out.body = text.slice(stored.bodyStart);
      }
      return out;
    } catch {
      return undefined; // L2 trouble (or no WebCrypto) is a miss, never an error
    }
  }

  private async l2Write(key: CacheKey, skill: Skill, entry: SkillManifestEntry, file: SkillFile, _ref: string | undefined): Promise<void> {
    const store = this.host.cacheStore;
    if (!store) return;
    // SEP-2549: an unpartitioned entry reaches a shared store only when the catalog said public.
    const scope = this.catalogScope(skill, key.partition);
    if (!key.partition && scope !== "public") return;
    try {
      const own = isOwnSkillMd(skill, entry.uri);
      let bodyStart: number | undefined;
      if (own) {
        if (file.text === undefined || file.body === undefined || !file.text.endsWith(file.body)) return; // cannot be rebuilt from bytes alone
        bodyStart = file.text.length - file.body.length;
      }
      const data: StoredSkillFile = {
        v: 1,
        uri: file.uri,
        ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
        bytes: toBase64(file.bytes),
        hasText: file.text !== undefined,
        ...(bodyStart !== undefined ? { bodyStart } : {}),
      };
      await store.set(serializeKey(key), { data, tags: [], updatedAt: Date.now(), scope });
    } catch {
      // best effort
    }
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

/** What an L2 store holds for a verified file: the bytes (base64) and what cannot be re-derived from them. */
interface StoredSkillFile {
  v: 1;
  uri: string;
  mimeType?: string;
  bytes: string;
  hasText: boolean;
  /** Own SKILL.md only: where the markdown body starts in `text`. */
  bodyStart?: number;
}

/**
 * A view of the SDK `Client` that adds `meta` to the `_meta` of every `request()` and
 * `readResource()` params. The SDK's SkillsClient reaches the wire only through those
 * (plus `_readResource`/`_walkPages`, which call back into them), and takes no `_meta` itself.
 */
function withRequestMeta<T extends object>(raw: T, meta: Record<string, unknown>): T {
  const inject = <P>(params: P): P =>
    ({ ...(params as object), _meta: { ...((params as { _meta?: object } | undefined)?._meta ?? {}), ...meta } }) as P;
  const target = raw as Record<string | symbol, unknown>;
  return new Proxy(raw, {
    get(_t, prop) {
      if (prop === "request") {
        return (req: { params?: unknown }, ...rest: unknown[]) =>
          (target.request as (...a: unknown[]) => unknown).call(raw, { ...req, params: inject(req.params ?? {}) }, ...rest);
      }
      if (prop === "readResource" || prop === "_readResource") {
        return (params: unknown, ...rest: unknown[]) => (target[prop] as (...a: unknown[]) => unknown).call(raw, inject(params), ...rest);
      }
      const v = target[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(raw) : v;
    },
  });
}

/** The server advertised `directoryRead: true` in its skills extension capability. */
function directoryReadAdvertised(conn: ServerConnection): boolean {
  const ext = conn.capabilities.extensions?.[SKILLS_EXT] as { directoryRead?: unknown } | undefined;
  return ext?.directoryRead === true;
}

const textEncoder = new TextEncoder();

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as never);
  return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stable id for a manifest's digest set (order independent). */
async function manifestFingerprint(manifest: readonly SkillManifestEntry[]): Promise<string> {
  const lines = manifest.map((r) => `${r.uri}\0${r.digest}\0${r.size}`).sort();
  return sha256Digest(textEncoder.encode(lines.join("\n")));
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isOwnSkillMd(skill: Skill, entryUri: string): boolean {
  return entryUri.split("#")[0] === skill.uri.split("#")[0];
}

/**
 * The cache key a verified read of `ref` (default `SKILL.md`) of `skill` lands under, or
 * undefined for `"dynamic"` skills and refs the manifest does not list. Used by the
 * TanStack bridge to follow the entry.
 */
export function skillFileCacheKey(skill: Skill, ref?: string, partition?: string): CacheKey | undefined {
  const entry = manifestEntryFor(skill, ref);
  return entry ? { kind: "skillFile", server: skill.server, uri: entry.uri, digest: entry.digest, partition } : undefined;
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
