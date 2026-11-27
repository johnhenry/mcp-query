// Gateway pass-through of MCP extensions (#82): capability negotiation, the tasks extension
// (`io.modelcontextprotocol/tasks`, SEP-2663), skills (`io.modelcontextprotocol/skills`,
// SEP-2640), MCP Apps (`io.modelcontextprotocol/ui`) and an opt-in generic pass-through for
// extension methods the gateway does not know.
//
// The rules, in one place:
//  - An extension is OFFERED to a consumer only when (a) the consumer declared it (per-request
//    client capabilities on the 2026-07-28 era, `initialize` capabilities on 2025), (b) at least one
//    upstream advertises it, and (c) the gateway's extension policy allows it.
//  - What the consumer declared is what reaches the upstream: on the per-request `_meta`
//    client-capabilities key, never more than the consumer declared and policy allows.
//  - Everything that crosses the gate runs through the MCPClient's interceptor chain
//    (`client.forward` / `listSkills` / ...), so `authorize`, rate-limit, redact and audit apply.
//  - Skill files are NEVER rewritten: a manifest digest covers the bytes, so the gate may allow,
//    deny or hold a whole skill for approval, but it forwards the verified bytes untouched.

import { INVALID_PARAMS, INTERNAL_ERROR, METHOD_NOT_FOUND, CLIENT_CAPABILITIES_META_KEY, ProtocolError, type Server } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { MCPClient, CallAuditEntry, CallContext } from "../core/client.js";
import type { ServerConnection } from "../core/connection.js";
import { SKILLS_EXT } from "../core/skillsExt.js";
import { TASKS_EXT, isTaskShaped } from "../core/tasksExt.js";
import type { Skill, SkillEntry } from "../core/skills.js";
import type { CacheKey } from "../core/keys.js";

/** MCP Apps extension id. */
export const UI_EXT = "io.modelcontextprotocol/ui";
/** The extensions the gateway has first-class handling for. */
export const KNOWN_EXTENSIONS: readonly string[] = [TASKS_EXT, SKILLS_EXT, UI_EXT];
/** `_meta` key naming the upstream a pass-through request is for (and the origin of a skill entry). */
export const SERVER_META_KEY = "io.johnhenry.mcp-query/server";

/** What the gateway does with MCP extensions. Everything is off unless an upstream advertises it AND the consumer declares it. */
export interface GatewayExtensions {
  /** Extension ids the gateway may offer. Default: tasks, skills and MCP Apps (`io.modelcontextprotocol/ui`). */
  allow?: string[];
  /** Extension ids never offered or forwarded (wins over `allow` and `passthrough`). */
  deny?: string[];
  /**
   * Generic pass-through of extension methods the gateway has no handler for (e.g. a future Events
   * extension): `{ "io.modelcontextprotocol/events": { methods: ["events/poll"] } }`. OFF by default.
   * Exactly the listed methods are re-served, through the interceptor chain (so policy, redact and
   * audit see them as `kind: "extension"`), to the one upstream advertising the extension (or the
   * one a request names with `_meta["io.johnhenry.mcp-query/server"]`). Request/response methods only.
   */
  passthrough?: Record<string, { methods: string[] }>;
  /**
   * Secret that signs namespaced task ids. Set it (>= 16 chars) when more than one gateway
   * instance serves a consumer or ids must survive a restart; default: random per gateway.
   */
  tasksSecret?: string | Uint8Array;
  /** Longest the gateway waits for a task it resolves itself for a consumer that did not declare tasks (ms). Default 60000. */
  taskResolveMs?: number;
}

export type Declared = Record<string, object>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when the gateway's extension policy lets `id` be offered or forwarded. */
export function extensionAllowed(ext: GatewayExtensions | undefined, id: string): boolean {
  if (ext?.deny?.includes(id)) return false;
  if (ext?.passthrough && Object.hasOwn(ext.passthrough, id)) return true;
  return (ext?.allow ?? KNOWN_EXTENSIONS).includes(id);
}

/**
 * The extensions a consumer declared on this request: its `initialize` capabilities, the
 * per-request client-capabilities `_meta` key, and the validated 2026-07-28 envelope, merged.
 * Only ids the policy allows are returned (this is also what is sent upstream).
 */
export function declaredExtensions(
  ext: GatewayExtensions | undefined,
  server: Server,
  ctx: { mcpReq?: { envelope?: Record<string, unknown> } } | undefined,
  callerMeta: Record<string, unknown> | undefined,
): Declared {
  const from = (caps: unknown): Record<string, unknown> => {
    const e = isObject(caps) ? caps.extensions : undefined;
    return isObject(e) ? e : {};
  };
  const merged = {
    ...from(server.getClientCapabilities()),
    ...from(callerMeta?.[CLIENT_CAPABILITIES_META_KEY]),
    ...from(ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY]),
  };
  const out: Declared = {};
  for (const [id, v] of Object.entries(merged)) if (extensionAllowed(ext, id)) out[id] = isObject(v) ? v : {};
  return out;
}

/** True when some upstream advertises `id` (MCP Apps: or ships UI metadata, as servers need not advertise it). */
function upstreamHas(client: MCPClient, id: string): ServerConnection[] {
  return client.connections().filter((c) => {
    if (c.capabilities.extensions?.[id]) return true;
    if (id !== UI_EXT) return false;
    return [...c.tools.values()].some((t) => isObject((t._meta as Record<string, unknown> | undefined)?.ui)) || [...c.resources.values()].some((r) => r.uri.startsWith("ui://"));
  });
}

/**
 * The `capabilities.extensions` the gateway advertises: what upstreams advertise AND policy
 * allows, and, once the consumer's declaration is known (`consumer` given), only what it declared.
 */
export function advertisedExtensions(client: MCPClient, ext: GatewayExtensions | undefined, consumer?: Declared): Record<string, object> {
  const out: Record<string, object> = {};
  for (const id of new Set([...KNOWN_EXTENSIONS, ...Object.keys(ext?.passthrough ?? {})])) {
    if (!extensionAllowed(ext, id)) continue;
    if (consumer && !Object.hasOwn(consumer, id)) continue;
    const ups = upstreamHas(client, id);
    if (!ups.length) continue;
    // Known extensions are offered with no settings of their own; a pass-through extension's settings are its (first) upstream's.
    const settings = ext?.passthrough && Object.hasOwn(ext.passthrough, id) ? ups[0]!.capabilities.extensions?.[id] : undefined;
    out[id] = isObject(settings) ? settings : {};
  }
  return out;
}

/**
 * The per-request `_meta` for an upstream hop. Strips the consumer's own client-capabilities key
 * (a consumer's claims are not the gateway's to repeat) and, where it matters, declares to the
 * upstream exactly what the consumer declared and policy allows:
 *  - a modern (2026-07-28) upstream gets the gateway's own capabilities with its extensions replaced
 *    by the consumer's allowed ones (tasks only when the consumer declared it);
 *  - a 2025-era upstream has fixed capabilities from `initialize`, so only a non-empty declaration
 *    is sent, as the per-request key (what the tasks extension specifies).
 * `override` replaces the base capabilities (the MRTR forward/deny modes).
 */
export function upstreamMeta(
  callerMeta: Record<string, unknown> | undefined,
  conn: ServerConnection | undefined,
  declared: Declared,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const { [CLIENT_CAPABILITIES_META_KEY]: _claimed, ...rest } = callerMeta ?? {};
  const has = Object.keys(declared).length > 0;
  let caps: Record<string, unknown> | undefined;
  if (override) caps = { ...override, ...(has ? { extensions: declared } : {}) };
  else if (conn?.era === "modern") {
    const own = conn.clientCapabilities as Record<string, unknown>;
    const { [TASKS_EXT]: _t, ...ownExt } = (isObject(own.extensions) ? own.extensions : {}) as Record<string, unknown>;
    caps = { ...own, extensions: { ...ownExt, ...declared } };
  } else if (has) caps = { extensions: declared };
  if (!caps) return Object.keys(rest).length ? rest : undefined;
  return { ...rest, [CLIENT_CAPABILITIES_META_KEY]: caps };
}

/** The call context for a skill operation: the tenant partition plus the caller's `_meta` (principal etc.). */
export function skillCallContext(meta: Record<string, unknown> | undefined, partition: string | undefined): CallContext {
  const m = cleanMeta(meta);
  return { ...(partition !== undefined ? { partition } : {}), ...(m ? { meta: m } : {}) };
}

/** Strip the consumer's own capability claims before `_meta` goes anywhere upstream. */
export function cleanMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta || !Object.hasOwn(meta, CLIENT_CAPABILITIES_META_KEY)) return meta;
  const { [CLIENT_CAPABILITIES_META_KEY]: _c, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
}

/** MCP Apps metadata on a tool or resource entry: `_meta.ui` and the flat `_meta["ui/resourceUri"]` of the first spec revision. */
export function stripUiMeta<T extends { _meta?: unknown }>(item: T): T {
  const m = item._meta;
  if (!isObject(m) || !("ui" in m || "ui/resourceUri" in m)) return item;
  const { ui: _u, "ui/resourceUri": _f, ...rest } = m;
  const { _meta: _old, ...others } = item;
  return (Object.keys(rest).length ? { ...others, _meta: rest } : others) as T;
}

// ── namespaced, signed task ids ───────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();
/** Binary string of `b`, in chunks (spreading a large array into one call overflows the stack). */
const bin = (b: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return out;
};
const b64u = (b: Uint8Array): string => btoa(bin(b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string): Uint8Array => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

/** What a namespaced task id carries (and what it is bound to). */
export interface TaskRef {
  server: string;
  /** Name of the tool that started the task (what policy is evaluated against). */
  tool: string;
  /** The upstream's own task id. */
  taskId: string;
  /** The tenant partition the task was created under. */
  partition?: string;
  /** `_meta.principal` at creation, when set. */
  principal?: unknown;
}

const ID_PREFIX = "gw1.";
const bindPrincipal = (p: unknown): string | null => (p === undefined || p === null ? null : typeof p === "string" ? p : JSON.stringify(p));

/**
 * Task ids the gateway hands consumers: `gw1.<base64url payload>.<base64url HMAC>`. The payload
 * names the upstream, tool and upstream task id and binds them to the partition and principal
 * that created the task; the HMAC makes it tamper-evident. No server-side state: any gateway
 * instance sharing the secret can route it. A forged, altered, foreign-tenant or unknown id is
 * refused identically ({@link TaskNotFoundError}) so ids reveal nothing.
 */
export class TaskIds {
  private readonly key: Promise<CryptoKey>;
  constructor(secret?: string | Uint8Array) {
    let raw: Uint8Array;
    if (secret === undefined) raw = crypto.getRandomValues(new Uint8Array(32));
    else {
      raw = typeof secret === "string" ? enc.encode(secret) : secret;
      if (raw.length < 16) throw new Error("extensions.tasksSecret must be at least 16 bytes");
    }
    this.key = crypto.subtle.importKey("raw", raw as never, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  async mint(ref: TaskRef): Promise<string> {
    const payload = b64u(enc.encode(JSON.stringify({ s: ref.server, k: ref.tool, t: ref.taskId, p: ref.partition ?? null, u: bindPrincipal(ref.principal) })));
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await this.key, enc.encode(payload) as never));
    return `${ID_PREFIX}${payload}.${b64u(sig)}`;
  }

  /** Open `id` for a caller in `who`'s partition/principal. Throws {@link TaskNotFoundError} for anything but an id minted for exactly that caller. */
  async open(id: string, who: { partition?: string; principal?: unknown }): Promise<TaskRef> {
    if (typeof id !== "string" || !id.startsWith(ID_PREFIX)) throw new TaskNotFoundError();
    const [payload, sig, extra] = id.slice(ID_PREFIX.length).split(".");
    if (!payload || !sig || extra !== undefined) throw new TaskNotFoundError();
    let ok = false;
    try {
      ok = await crypto.subtle.verify("HMAC", await this.key, unb64u(sig) as never, enc.encode(payload) as never);
    } catch {
      ok = false;
    }
    if (!ok) throw new TaskNotFoundError();
    let p: { s?: unknown; k?: unknown; t?: unknown; p?: unknown; u?: unknown };
    try {
      p = JSON.parse(dec.decode(unb64u(payload)));
    } catch {
      throw new TaskNotFoundError();
    }
    if (typeof p.s !== "string" || typeof p.k !== "string" || typeof p.t !== "string") throw new TaskNotFoundError();
    // Authentic, but is it this caller's? Same partition and principal as at creation, or it does not exist.
    if ((p.p ?? null) !== (who.partition ?? null) || (p.u ?? null) !== bindPrincipal(who.principal)) {
      throw new TaskNotFoundError(p.s as string);
    }
    return { server: p.s, tool: p.k, taskId: p.t, ...(typeof p.p === "string" ? { partition: p.p } : {}), ...(who.principal !== undefined ? { principal: who.principal } : {}) };
  }
}

/** A task id that is unknown, forged, or belongs to another tenant. One message for all, on purpose. */
export class TaskNotFoundError extends ProtocolError {
  constructor(
    /** Set when the id was authentic but not the caller's (for the gateway's audit; never sent to the consumer). */
    readonly foreignServer?: string,
  ) {
    super(INVALID_PARAMS, "unknown task");
    this.name = "TaskNotFoundError";
  }
}

// ── installing the handlers ─────────────────────────────────────────────────────

/** What the extension handlers need from the gateway that builds them. */
export interface ExtensionHost {
  client: MCPClient;
  server: Server;
  ext: GatewayExtensions | undefined;
  ids: TaskIds;
  namespace: boolean;
  /** Derives the tenant partition from request `_meta` (same function the gate's tenant isolation uses). */
  partitionOf: (meta: Record<string, unknown> | undefined) => string | undefined;
  /** Answer guard (redact / answer policy) for `tasks/update`. */
  guardAnswers?: (req: {
    kind: "tool" | "prompt" | "task";
    server: string;
    target: string;
    args?: Record<string, unknown>;
    context?: { meta?: Record<string, unknown> };
    inputResponses: Record<string, unknown>;
  }) => { inputResponses: Record<string, unknown>; redactedFields?: string[]; declined?: string[] } | Promise<{ inputResponses: Record<string, unknown>; redactedFields?: string[]; declined?: string[] }>;
  /** Hide a skill from `skills/list` (and refuse it) by upstream server and `SKILL.md` URI. */
  skillFilter?: (server: string, uri: string) => boolean;
  /** Audit sink for refusals that never reach the interceptor chain. */
  audit?: (entry: CallAuditEntry) => void;
}

type HandlerCtx = { mcpReq: { envelope?: Record<string, unknown>; _meta?: Record<string, unknown>; inputResponses?: unknown } };

const taskParams = z.looseObject({ taskId: z.string(), _meta: z.record(z.string(), z.unknown()).optional() });
const looseParams = z.looseObject({ _meta: z.record(z.string(), z.unknown()).optional() });

/** Register the extension request handlers a gateway serves (tasks, skills, allowlisted pass-through). */
export function installExtensionHandlers(h: ExtensionHost): void {
  const { client, server, ext } = h;
  const metaOf = (ctx: HandlerCtx, params: { _meta?: Record<string, unknown> }) => (ctx.mcpReq._meta ?? params._meta) as Record<string, unknown> | undefined;
  const who = (meta: Record<string, unknown> | undefined) => ({ partition: h.partitionOf(meta), principal: meta?.principal });
  const contextOf = (meta: Record<string, unknown> | undefined, declared: Declared, conn: ServerConnection | undefined): CallContext => {
    const partition = h.partitionOf(meta);
    return { ...(partition !== undefined ? { partition } : {}), meta: upstreamMeta(meta, conn, declared) ?? {} };
  };
  /** Skill operations never go upstream with a capability declaration of their own: partition + the caller's meta, for policy and audit. */
  const skillContext = (meta: Record<string, unknown> | undefined): CallContext => skillCallContext(meta, h.partitionOf(meta));
  /** The consumer must have declared the extension (and policy allow it), or the method does not exist for it. */
  const require = (id: string, ctx: HandlerCtx, params: { _meta?: Record<string, unknown> }, method: string): { meta: Record<string, unknown> | undefined; declared: Declared } => {
    const meta = metaOf(ctx, params);
    const declared = declaredExtensions(ext, server, ctx, meta);
    if (!Object.hasOwn(declared, id) || !upstreamHas(client, id).length) throw new ProtocolError(METHOD_NOT_FOUND, `${method} is not available: the ${id} extension is not offered to this client`);
    return { meta, declared };
  };

  // ── tasks ──
  const openTask = async (id: string, meta: Record<string, unknown> | undefined, method: string): Promise<TaskRef> => {
    try {
      return await h.ids.open(id, who(meta));
    } catch (e) {
      if (e instanceof TaskNotFoundError && e.foreignServer !== undefined) {
        // Authentic id, wrong caller: refused like an unknown id, but audited as a denial.
        h.audit?.({
          at: Date.now(), ms: 0, server: e.foreignServer, kind: "task", target: method, principal: meta?.principal,
          outcome: "denied", error: "denied: task belongs to another partition or principal",
        });
      }
      throw e;
    }
  };
  const taskCall = async (method: "tasks/get" | "tasks/update" | "tasks/cancel", params: { taskId: string; _meta?: Record<string, unknown>; inputResponses?: unknown }, ctx: HandlerCtx) => {
    const { meta, declared } = require(TASKS_EXT, ctx, params, method);
    const ref = await openTask(params.taskId, meta, method);
    const conn = client.connection(ref.server);
    if (!conn) throw new TaskNotFoundError();
    const wire: Record<string, unknown> = { taskId: ref.taskId };
    let interaction: { inputResponses?: Record<string, unknown>; answers?: { redactedFields?: string[]; declined?: string[] } } | undefined;
    if (method === "tasks/update") {
      // `inputResponses` is lifted out of params by the SDK (MRTR-reserved): read it from the request context.
      const given = (params.inputResponses ?? ctx.mcpReq.inputResponses) as Record<string, unknown> | undefined;
      if (given) {
        let answers = given;
        let note: { redactedFields?: string[]; declined?: string[] } | undefined;
        if (h.guardAnswers) {
          const g = await h.guardAnswers({ kind: "task", server: ref.server, target: ref.tool, args: {}, context: { meta }, inputResponses: given });
          answers = g.inputResponses;
          if (g.redactedFields?.length || g.declined?.length) note = { ...(g.redactedFields?.length ? { redactedFields: g.redactedFields } : {}), ...(g.declined?.length ? { declined: g.declined } : {}) };
        }
        wire.inputResponses = answers;
        interaction = { inputResponses: answers, ...(note ? { answers: note } : {}) };
      }
    }
    const res = await client.forward(ref.server, method, wire, {
      kind: "task",
      target: ref.tool,
      args: { taskId: ref.taskId },
      context: contextOf(meta, declared, conn),
      ...(interaction ? { interaction } : {}),
    });
    // The consumer only ever sees the namespaced id.
    return (method === "tasks/get" ? { ...res, taskId: params.taskId } : res) as never;
  };
  server.setRequestHandler("tasks/get" as never, { params: taskParams } as never, ((p: never, c: never) => taskCall("tasks/get", p, c)) as never);
  server.setRequestHandler("tasks/update" as never, { params: taskParams } as never, ((p: never, c: never) => taskCall("tasks/update", p, c)) as never);
  server.setRequestHandler("tasks/cancel" as never, { params: taskParams } as never, ((p: never, c: never) => taskCall("tasks/cancel", p, c)) as never);

  // ── skills ──
  const hintOf = (key: CacheKey): { ttlMs?: number } => {
    const e = client.cache.getSnapshot(key);
    return e && e.status === "success" ? { ttlMs: Math.max(0, Math.round(e.staleTime - (Date.now() - e.updatedAt))) } : {};
  };
  const skillServers = () => client.connections().filter((c) => c.supports("skills")).map((c) => c.name);
  server.setRequestHandler("skills/list" as never, { params: looseParams } as never, (async (p: never, c: never) => {
    const { meta } = require(SKILLS_EXT, c, p, "skills/list");
    const context = skillContext(meta);
    const skills = await client.listSkills(undefined, { context });
    const partition = context.partition;
    const ttls = skillServers().map((s) => hintOf({ kind: "skillList", server: s, partition }).ttlMs).filter((t): t is number => t !== undefined);
    return {
      skills: skills.filter((k) => h.skillFilter?.(k.server, k.uri) ?? true).map((k) => toGatewaySkill(k, h.namespace)),
      // Per-consumer content: never shareable across authorization contexts.
      cacheScope: "private",
      ...(ttls.length ? { ttlMs: Math.min(...ttls) } : {}),
    } as never;
  }) as never);
  server.setRequestHandler("skills/get" as never, { params: looseParams.extend({ uri: z.string() }) } as never, (async (p: { uri: string; _meta?: Record<string, unknown> }, c: never) => {
    const { meta } = require(SKILLS_EXT, c, p, "skills/get");
    const context = skillContext(meta);
    const at = await locateSkillFile(client, h.namespace, p.uri, context);
    if (!at || !(h.skillFilter?.(at.server, at.upstreamUri) ?? true)) throw new ProtocolError(INVALID_PARAMS, `unknown skill ${p.uri}`, { uri: p.uri });
    const skill = await client.getSkill(at.upstreamUri, at.server, { context });
    return { skill: toGatewaySkill(skill, h.namespace), cacheScope: "private", ...hintOf({ kind: "skill", server: at.server, uri: at.upstreamUri, partition: context.partition }) } as never;
  }) as never);

  // ── allowlisted pass-through of unknown extension methods ──
  for (const [id, cfg] of Object.entries(ext?.passthrough ?? {})) {
    if (!extensionAllowed(ext, id)) continue;
    for (const method of cfg.methods) {
      server.setRequestHandler(method as never, { params: looseParams } as never, (async (p: { _meta?: Record<string, unknown> }, c: never) => {
        const { meta, declared } = require(id, c, p, method);
        const ups = upstreamHas(client, id).map((x) => x.name);
        const named = meta?.[SERVER_META_KEY];
        const target = typeof named === "string" ? (ups.includes(named) ? named : undefined) : ups.length === 1 ? ups[0] : undefined;
        if (!target) throw new ProtocolError(INVALID_PARAMS, `${method}: ${ups.length > 1 || typeof named === "string" ? `name one upstream of ${ups.join(", ")} in _meta["${SERVER_META_KEY}"]` : "no upstream advertises this extension"}`);
        const { _meta: _m, ...wire } = p as Record<string, unknown>;
        return (await client.forward(target, method, wire, { kind: "extension", target: method, context: contextOf(meta, declared, client.connection(target)) })) as never;
      }) as never);
    }
  }
}

// ── tasks in tools/call ─────────────────────────────────────────────────────────

/** The Task fields of a CreateTaskResult, and nothing the SDK's tool-result defaults added. */
function taskFields(res: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["taskId", "status", "statusMessage", "createdAt", "lastUpdatedAt", "ttlMs", "pollIntervalMs", "_meta"]) if (res[k] !== undefined) out[k] = res[k];
  return out;
}

/**
 * Shape a task handle the upstream returned for a `tools/call` into what this consumer gets.
 * A consumer that declared tasks receives the handle with a namespaced id; one that did not
 * gets the finished result (the gateway polls the task itself, through the chain). Returns
 * undefined when `res` is not a task handle.
 */
export async function finishToolCall(
  h: Pick<ExtensionHost, "client" | "ids" | "ext">,
  res: unknown,
  call: { server: string; tool: string; meta: Record<string, unknown> | undefined; partition: string | undefined; declared: Declared; consumerTasks: boolean; context: CallContext },
): Promise<unknown | undefined> {
  if (!isTaskShaped(res)) return undefined;
  const handle = res as unknown as Record<string, unknown> & { taskId: string };
  if (call.consumerTasks) {
    const taskId = await h.ids.mint({ server: call.server, tool: call.tool, taskId: handle.taskId, partition: call.partition, principal: call.meta?.principal });
    return { ...taskFields(handle), taskId, resultType: "task" };
  }
  return resolveTask(h, call, handle.taskId);
}

/** Poll an upstream task to the end on behalf of a consumer that cannot hold a handle. */
async function resolveTask(h: Pick<ExtensionHost, "client" | "ext">, call: { server: string; tool: string; context: CallContext }, taskId: string): Promise<unknown> {
  const deadline = Date.now() + (h.ext?.taskResolveMs ?? 60_000);
  const step = (method: "tasks/get" | "tasks/cancel") => h.client.forward(call.server, method, { taskId }, { kind: "task", target: call.tool, args: { taskId }, context: call.context });
  for (;;) {
    const t = (await step("tasks/get")) as { status?: string; result?: unknown; error?: { message?: string }; pollIntervalMs?: number };
    if (t.status === "completed") return t.result ?? { content: [] };
    if (t.status === "failed") throw new ProtocolError(INTERNAL_ERROR, t.error?.message ?? `task ${taskId} failed`);
    if (t.status === "cancelled") throw new ProtocolError(INTERNAL_ERROR, `task ${taskId} was cancelled`);
    if (t.status === "input_required" || Date.now() > deadline) {
      await step("tasks/cancel").catch(() => {});
      throw new ProtocolError(INTERNAL_ERROR, t.status === "input_required"
        ? `${call.server}.${call.tool} needs input in a task, and this client did not declare the tasks extension`
        : `${call.server}.${call.tool} did not finish in time`);
    }
    await new Promise((r) => setTimeout(r, t.pollIntervalMs ?? 150));
  }
}

// ── skills: identity and routing ────────────────────────────────────────────────

const SCHEME = "skill://";
const nsUri = (server: string, uri: string): string => (uri.startsWith(SCHEME) ? `${SCHEME}${server}/${uri.slice(SCHEME.length)}` : uri);

/**
 * A skill as the gateway publishes it. With `namespace` (the default) every `skill://` URI, the
 * entry's and each manifest file's, gains the originating server as its first path segment
 * (`skill://git-commit/SKILL.md` on `github` becomes `skill://github/git-commit/SKILL.md`), so two
 * upstreams' same-named skills do not collide and a file read routes back to its upstream. The
 * origin is also in `_meta`. Digests, sizes and frontmatter are the upstream's, untouched.
 */
export function toGatewaySkill(skill: Skill, namespace: boolean): SkillEntry {
  const { server, ...entry } = skill;
  const _meta = { ...(isObject(entry._meta) ? entry._meta : {}), [SERVER_META_KEY]: server };
  if (!namespace) return { ...entry, _meta };
  return {
    ...entry,
    uri: nsUri(server, entry.uri),
    resources: entry.resources === "dynamic" ? "dynamic" : entry.resources.map((r) => ({ ...r, uri: nsUri(server, r.uri) })),
    _meta,
  };
}

/** Which upstream (and which upstream URI) a gateway skill URI names. */
export async function locateSkillFile(client: MCPClient, namespace: boolean, uri: string, context: CallContext): Promise<{ server: string; upstreamUri: string } | undefined> {
  if (!uri.startsWith(SCHEME)) return undefined;
  if (namespace) {
    const rest = uri.slice(SCHEME.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return undefined;
    const server = rest.slice(0, slash);
    return client.connection(server)?.supports("skills") ? { server, upstreamUri: `${SCHEME}${rest.slice(slash + 1)}` } : undefined;
  }
  // Not namespaced: the first upstream that lists the URI (or a file of a skill it lists) wins.
  for (const s of await client.listSkills(undefined, { context })) {
    if (s.uri === uri || (s.resources !== "dynamic" && s.resources.some((r) => r.uri === uri))) return { server: s.server, upstreamUri: uri };
  }
  return undefined;
}

/**
 * Serve one skill file for `resources/read`: the SDK-verified bytes of the upstream skill, byte for
 * byte. The interceptor chain sees it as `kind: "skill"` (policy / approval / audit); mcp-gate's
 * `redact` skips it by design. Returns undefined when `uri` is not a skill file the gateway serves.
 */
export async function readSkillFileFor(
  client: MCPClient,
  namespace: boolean,
  uri: string,
  context: CallContext,
  skillFilter?: (server: string, uri: string) => boolean,
): Promise<{ contents: Array<Record<string, unknown>> } | undefined> {
  const at = await locateSkillFile(client, namespace, uri, context);
  if (!at) return undefined;
  const skills = await client.listSkills(at.server, { context });
  const root = (u: string) => u.slice(0, u.lastIndexOf("/") + 1);
  const skill = skills.find((k) => k.uri === at.upstreamUri || (k.resources === "dynamic" ? at.upstreamUri.startsWith(root(k.uri)) : k.resources.some((r) => r.uri === at.upstreamUri)));
  if (!skill || !(skillFilter?.(skill.server, skill.uri) ?? true)) throw new ProtocolError(INVALID_PARAMS, `unknown resource ${uri}`, { uri });
  const file = await client.readSkillFile(skill, at.upstreamUri === skill.uri ? undefined : at.upstreamUri, { context });
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    text = undefined;
  }
  return {
    contents: [
      text !== undefined
        ? { uri, mimeType: file.mimeType ?? "text/markdown", text }
        : { uri, mimeType: file.mimeType ?? "application/octet-stream", blob: btoa(bin(file.bytes)) },
    ],
  };
}
