// In-process mock MCP server harness, rebuilt on the v2 SDK for the 2026-07-28
// era. Serves BOTH protocol generations through one in-process HTTP dispatcher:
//
//   modern leg — `createMcpHandler` (per-request Server instances, stateless,
//     `subscriptions/listen` change delivery via a shared event bus);
//   legacy leg — a tiny sessionful router over
//     `WebStandardStreamableHTTPServerTransport` (real `Mcp-Session-Id`
//     assignment, standalone GET SSE stream, server→client requests) so
//     session-resumption and unsolicited-notification behavior stay testable.
//
// The client-side factory returns a real `StreamableHTTPClientTransport` whose
// `fetch` is served in-process — the SDK-documented testing pattern — so
// `versionNegotiation` ('auto' probe, legacy fallback, pins) is exercised for
// real. Force an era per test via `new MockMCPServer(spec, { era })`.
//
// Tool handlers keep the imperative `ctx.elicit()/ctx.sample()/ctx.listRoots()`
// API on top of the return-based multi-round-trip flow via a record/replay
// engine: an unanswered interaction suspends the handler and returns
// `inputRequired(...)`; the retry (or, on legacy connections, the SDK's
// built-in shim) re-runs the handler with the recorded answer. Handlers must
// therefore be deterministic up to their last interaction call.

import {
  createMcpHandler,
  INVALID_PARAMS,
  isLegacyRequest,
  InMemoryServerEventBus,
  inputRequired,
  ProtocolError,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type Implementation,
  type InputRequest,
  type McpHttpHandler,
  type ProtocolEra,
  type ServerCapabilities,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import * as z from "zod";

import { TASKS_EXT, type DetailedTask } from "../core/tasksExt.js";
import type { TransportContext } from "../core/connection.js";
import { FILES_EXT, findFileParams, acceptsFile, type FileInput, type UploadTarget } from "../core/filesExt.js";
import type { MockFilesSpec, MockReceivedFile } from "./mockFiles.js";
import { buildMockSkill, SKILLS_EXT, type BuiltSkill, type MockSkill, type MockSkillsCacheHint } from "./mockSkills.js";

import { EVENTS_EXT, MockEventSource, type MockEventsSpec } from "./mockEvents.js";

export type { MockSkill, MockSkillTamper, MockSkillsCacheHint } from "./mockSkills.js";
export { MockEventSource } from "./mockEvents.js";
export { MockUploadSink } from "./mockFiles.js";
export type { MockFilesSpec, MockReceivedFile, SinkRequest } from "./mockFiles.js";
export type { MockEventType, MockEventsSpec, MockPollRecord } from "./mockEvents.js";

/** Context a tool handler can use to call back into the client (sampling/elicitation/roots). */
export interface MockToolContext {
  /** Issue a sampling/createMessage request to the connected client. */
  sample: (params: Record<string, unknown>) => Promise<{ content: { type: string; text?: string } }>;
  /** Issue an elicitation/create request to the connected client. */
  elicit: (params: Record<string, unknown>) => Promise<{ action: string; content?: unknown }>;
  /** Ask the client for its roots (roots/list). */
  listRoots: () => Promise<{ roots: Array<{ uri: string; name?: string }> }>;
  /** Emit a progress notification for this call (if the client sent a progressToken). */
  progress: (progress: number, total?: number) => void;
  /** The request's `_meta` (per-call context the client attached), if any. */
  meta?: Record<string, unknown>;
  /** Aborts when the client cancels this request (notifications/cancelled). */
  signal?: AbortSignal;
  /** Files extension (`spec.files`): the files this call carried, keyed by parameter name (inline, or confirmed in the sink). */
  files?: Record<string, MockReceivedFile>;
}

export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** Advertised as the tool's `_meta` in tools/list (e.g. MCP Apps' `ui.resourceUri`). */
  _meta?: Record<string, unknown>;
  handler?: (
    args: Record<string, unknown>,
    ctx: MockToolContext,
  ) => { content: unknown[]; isError?: boolean } | unknown | Promise<unknown>;
  /**
   * Task-capable tool (SEP-2663): when the caller declares the tasks extension,
   * a call creates a task, runs `handler` asynchronously (after `taskDelayMs`,
   * default 20ms), and stores its return value as the task result. In a task
   * context, ctx.elicit/sample register mid-flight inputRequests (answered via
   * tasks/update) instead of suspending. Plain calls run synchronously as usual.
   */
  task?: boolean;
  taskDelayMs?: number;
}
export interface MockResource {
  uri: string;
  name?: string;
  mimeType?: string;
  /** Advertised as `_meta` on the list entry and on the read contents (e.g. MCP Apps' `ui.csp`). */
  _meta?: Record<string, unknown>;
  read?: () => { text?: string; blob?: string };
}
export interface MockPrompt {
  name: string;
  description?: string;
  get?: (args: Record<string, string>) => { messages: unknown[]; description?: string };
}

export interface MockSpec {
  tools?: MockTool[];
  resources?: MockResource[];
  templates?: Array<{ uriTemplate: string; name: string }>;
  prompts?: MockPrompt[];
  /** Advertise the logging capability (enables notifyLog — legacy-era delivery). */
  logging?: boolean;
  /** Advertise completions; map of argument name → candidate values, or a function of
   *  (argName, value, context.arguments) for context-dependent completions. */
  completions?:
    | Record<string, string[]>
    | ((argName: string, value: string, contextArgs?: Record<string, string>) => string[]);
  /** Override advertised capabilities; defaults are derived from which arrays are present. */
  capabilities?: ServerCapabilities;
  /** If set, list responses are chunked to exercise cursor pagination. */
  pageSize?: number;
  /**
   * Skills over MCP (io.modelcontextprotocol/skills): serves skills/list, skills/get and the skill
   * files over resources/read, with a sha256 manifest per skill. A skill's `tamper` makes its entry
   * lie so host verification can be tested. Advertises `resources` + the skills extension.
   */
  skills?: MockSkill[];
  /** `ttlMs` / `cacheScope` stamped on skills/list + skills/get results (default 0 / "private"). */
  skillsCache?: MockSkillsCacheHint;
  /**
   * Events extension (io.modelcontextprotocol/events): serves events/list and events/poll from a
   * controllable source (`server.events`: emit / truncate / fail). Advertises the extension; modern era only.
   */
  events?: MockEventsSpec;
  /**
   * EXPERIMENTAL files extension (io.modelcontextprotocol/files): advertises it and, for a tool whose input
   * schema marks a param `x-mcp-file`, serves the inline and out-of-band (`upload_required`) flows against
   * `files.sink`. Modern era only.
   */
  files?: MockFilesSpec;
  /** Advertise `directoryRead` and serve `resources/directory/read` for the skill directories. */
  skillsDirectoryRead?: boolean;
}

export interface MockMCPServerOptions {
  /**
   * Which protocol eras this mock serves. "both" (default) routes by request
   * classification — the CLIENT's versionNegotiation decides what happens.
   * "legacy" answers modern probes with 404 (an 'auto' client falls back);
   * "modern" rejects 2025 handshakes (tests pins and rejection paths).
   */
  era?: "legacy" | "modern" | "both";
}

/** Thrown by the replay ctx to suspend a handler at its first unanswered interaction. */
class Suspend {
  constructor(
    readonly key: string,
    readonly request: InputRequest,
  ) {}
}

interface MockTaskRecord {
  task: {
    taskId: string;
    status: DetailedTask["status"];
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttlMs: number | null;
    pollIntervalMs: number;
  };
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  /** Pending mid-flight input requests, keyed like MRTR inputRequests. */
  pendingInput: Map<string, { request: InputRequest; resolve: (response: unknown) => void }>;
}

export class MockMCPServer {
  /** Mutable — change it between connects to simulate capability/list changes. */
  spec: MockSpec;

  // observability for assertions
  connectCount = 0;
  /** resources/subscribe refcounts — LEGACY-era observability only (modern-era
   *  subscriptions live inside the SDK's listen router; assert client-observable
   *  behavior instead). */
  subscribed = new Set<string>();
  callLog: Array<{ name: string; args: unknown }> = [];
  /** Skills traffic seen by the mock: `skills/list`, `skills/get <uri>`, `read <uri>` (for cache assertions). */
  skillLog: string[] = [];
  /** The events fixture's controllable source (`spec.events`): `emit`, `truncate`, `fail`, `polls`. */
  events?: MockEventSource;
  /** The `_meta` (minus protocol envelope keys) seen on skills traffic: `{ method, meta }` per request. */
  skillMetaLog: Array<{ method: string; meta: Record<string, unknown> | undefined }> = [];

  /** Files extension: every `upload_required` result this mock issued, in order (wire shape). */
  uploadRequests: Array<Record<string, unknown>> = [];
  /** Files extension: the `requestState` values seen on retries. */
  fileRetries: string[] = [];
  private fileRound = 0;
  private fileRounds = new Map<string, { ids: string[]; args: string }>();

  private readonly eraOpt: "legacy" | "modern" | "both";
  private readonly bus = new InMemoryServerEventBus();
  private readonly handler: McpHttpHandler;
  private legacySessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: Server }>();
  /** Tasks survive reconnects (like a real server) — keyed by taskId. */
  private taskStore = new Map<string, MockTaskRecord>();
  private replay = new Map<string, unknown[]>(); // requestState token → recorded answers
  private replaySeq = 0;
  private taskSeq = 0;
  private lastEnvelopeClientInfo?: Implementation;
  private lastEnvelopeClientCaps?: Record<string, unknown>;
  private closed = false;

  constructor(spec: MockSpec, opts: MockMCPServerOptions = {}) {
    this.spec = spec;
    this.eraOpt = opts.era ?? "both";
    if (spec.events) this.events = new MockEventSource(spec.events);
    this.handler = createMcpHandler(({ era }) => this.buildServer(era), { legacy: "reject", bus: this.bus });
  }

  /** Use as a ServerConnection `transport` factory (in-process Streamable HTTP). */
  transport = (ctx?: TransportContext): Transport => {
    this.connectCount++;
    return new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
      fetch: (url, init) => this.dispatch(new Request(url, init)),
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
  };

  /** Tear down streams and sessions. REQUIRED in test teardown (afterEach). */
  async close(): Promise<void> {
    this.closed = true;
    await this.handler.close();
    for (const { transport } of this.legacySessions.values()) {
      await transport.close().catch(() => {});
    }
    this.legacySessions.clear();
  }

  // ── in-process HTTP dispatch ───────────────────────────────────────────────
  private dispatch = async (request: Request): Promise<Response> => {
    if (this.closed) return new Response("mock closed", { status: 503 });
    if (this.eraOpt !== "modern") {
      // isLegacyRequest may need the body — hand it a clone.
      if (await isLegacyRequest(request.clone())) return this.legacyLeg(request);
      if (this.eraOpt === "legacy") {
        // Modern-classified traffic (the server/discover probe) on a legacy-only
        // mock: unrecognized → an 'auto' client falls back to initialize.
        return new Response("not found", { status: 404 });
      }
    }
    return this.handler.fetch(request);
  };

  /** Sessionful 2025-era serving: initialize creates a session; later requests route by header. */
  private async legacyLeg(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.legacySessions.get(sessionId);
      // Unknown/expired session → 404 per Streamable HTTP; the client
      // re-initializes (this is the "server forgot the session" resume path).
      if (!session) return new Response("session not found", { status: 404 });
      const res = await session.transport.handleRequest(request);
      if (request.method === "DELETE") {
        this.legacySessions.delete(sessionId);
      }
      return res;
    }
    // No session header: an initialize POST — mint a session.
    const server = this.buildServer("legacy");
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `mock-session-${crypto.randomUUID()}`,
      onsessioninitialized: (id) => {
        this.legacySessions.set(id, { transport, server });
      },
      onsessionclosed: (id) => {
        this.legacySessions.delete(id);
      },
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  // ── notification helpers (fire on BOTH legs; whichever has listeners delivers) ──
  async notifyResourceUpdated(uri: string): Promise<void> {
    this.handler.notify.resourceUpdated(uri);
    await this.eachLegacySession((s) => s.notification({ method: "notifications/resources/updated", params: { uri } }));
  }
  async notifyToolListChanged(): Promise<void> {
    this.handler.notify.toolsChanged();
    await this.eachLegacySession((s) => s.sendToolListChanged());
  }
  async notifyResourceListChanged(): Promise<void> {
    this.handler.notify.resourcesChanged();
    await this.eachLegacySession((s) => s.sendResourceListChanged());
  }
  async notifyPromptListChanged(): Promise<void> {
    this.handler.notify.promptsChanged();
    await this.eachLegacySession((s) => s.sendPromptListChanged());
  }
  /** LEGACY-era only: the modern revision has no unsolicited log channel (SEP-2577). */
  async notifyLog(level: string, data: unknown, logger?: string): Promise<void> {
    await this.eachLegacySession((s) => s.notification({ method: "notifications/message", params: { level, data, logger } }));
  }
  /** Push an unsolicited task snapshot (`notifications/tasks`, SEP-2663). LEGACY-era delivery. */
  async notifyTaskStatus(task: Record<string, unknown>): Promise<void> {
    await this.eachLegacySession((s) => s.notification({ method: "notifications/tasks", params: task }));
  }
  /**
   * Send `notifications/events/list_changed`. LEGACY-era delivery only (the SDK's modern listen router
   * carries a fixed set of change kinds), so modern-era tests inject the notification client-side.
   */
  async notifyEventsListChanged(): Promise<void> {
    await this.eachLegacySession((s) => s.notification({ method: "notifications/events/list_changed" }));
  }
  private async eachLegacySession(fn: (server: Server) => Promise<void>): Promise<void> {
    await Promise.allSettled([...this.legacySessions.values()].map(({ server }) => fn(server)));
  }

  /** The identity the connected client advertised (initialize on legacy; request envelope on modern). */
  clientInfo(): { name?: string; version?: string; title?: string } | undefined {
    // Latest session wins — sessions accumulate across connects on one mock.
    let last: { name?: string; version?: string; title?: string } | undefined;
    for (const { server } of this.legacySessions.values()) {
      const v = server.getClientVersion();
      if (v) last = v;
    }
    return last ?? this.lastEnvelopeClientInfo;
  }

  /** The capabilities the connected client advertised (initialize on legacy; request envelope on modern). */
  clientCapabilities(): { extensions?: Record<string, unknown>; [k: string]: unknown } | undefined {
    let last: Record<string, unknown> | undefined;
    for (const { server } of this.legacySessions.values()) {
      const v = server.getClientCapabilities();
      if (v) last = v as Record<string, unknown>;
    }
    return last ?? this.lastEnvelopeClientCaps;
  }

  // ── server construction (fresh per modern request / per legacy session) ────
  private capabilities(): ServerCapabilities {
    if (this.spec.capabilities) return this.spec.capabilities;
    const caps: ServerCapabilities = {};
    if (this.spec.tools) caps.tools = { listChanged: true };
    if (this.spec.resources || this.spec.templates) caps.resources = { subscribe: true, listChanged: true };
    if (this.spec.prompts) caps.prompts = { listChanged: true };
    if (this.spec.logging) caps.logging = {};
    if (this.spec.completions) caps.completions = {};
    if (this.spec.tools?.some((t) => t.task)) {
      caps.extensions = { ...(caps.extensions ?? {}), [TASKS_EXT]: {} };
    }
    if (this.spec.skills) {
      caps.resources ??= { subscribe: true, listChanged: true };
      caps.extensions = { ...(caps.extensions ?? {}), [SKILLS_EXT]: this.spec.skillsDirectoryRead ? { directoryRead: true } : {} };
    }
    if (this.spec.files) {
      const f = this.spec.files;
      caps.extensions = { ...(caps.extensions ?? {}), [FILES_EXT]: { ...(f.upload === false ? {} : { upload: {} }), ...(f.maxInlineBytes ? { maxInlineBytes: f.maxInlineBytes } : {}) } };
    }
    if (this.spec.events) {
      caps.extensions = { ...(caps.extensions ?? {}), [EVENTS_EXT]: this.spec.events.listChanged === false ? {} : { listChanged: true } };
    }
    return caps;
  }

  private page<T>(items: T[], cursor?: string): { slice: T[]; nextCursor?: string } {
    const size = this.spec.pageSize;
    if (!size) return { slice: items };
    const start = cursor ? Number(cursor) : 0;
    const slice = items.slice(start, start + size);
    const next = start + size;
    return { slice, nextCursor: next < items.length ? String(next) : undefined };
  }

  private captureClient(ctx: ServerContext): void {
    const info = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientInfo"] as Implementation | undefined;
    if (info) this.lastEnvelopeClientInfo = info;
    const caps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"] as Record<string, unknown> | undefined;
    if (caps) this.lastEnvelopeClientCaps = caps;
  }

  private buildServer(_era: ProtocolEra): Server {
    const caps = this.capabilities();
    const server = new Server({ name: "mock", version: "1.0.0" }, { capabilities: caps });
    const s = () => this.spec;

    // Only register handlers for advertised capabilities — the SDK rejects
    // handlers whose capability is absent.
    if (caps.tools) this.installTools(server);
    if (caps.resources) this.installResources(server, s);
    if (caps.prompts) this.installPrompts(server, s);
    if (caps.completions) {
      server.setRequestHandler("completion/complete", (req) => {
        const completions = s().completions;
        const values =
          typeof completions === "function"
            ? completions(req.params.argument.name, req.params.argument.value, req.params.context?.arguments)
            : (completions?.[req.params.argument.name] ?? []);
        return { completion: { values, hasMore: false } };
      });
    }
    if (caps.extensions?.[TASKS_EXT]) this.installTasks(server);
    if (caps.extensions?.[SKILLS_EXT]) this.installSkills(server);
    if (caps.extensions?.[EVENTS_EXT] && this.events) this.installEvents(server, this.events);
    return server;
  }

  // ── tools (incl. the MRTR record/replay engine and the task branch) ────────
  private installTools(server: Server): void {
    server.setRequestHandler("tools/list", (req, ctx) => {
      this.captureClient(ctx);
      const { slice, nextCursor } = this.page(this.spec.tools ?? [], req.params?.cursor);
      return {
        tools: slice.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema ?? { type: "object" }) as { type: "object" },
          ...(t.annotations ? { annotations: t.annotations } : {}),
          ...(t._meta ? { _meta: t._meta } : {}),
        })),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });

    server.setRequestHandler("tools/call", async (req, ctx) => {
      this.captureClient(ctx);
      const tool = (this.spec.tools ?? []).find((t) => t.name === req.params.name);
      if (!tool) throw new ProtocolError(INVALID_PARAMS, `unknown tool ${req.params.name}`);

      const retried = ctx.mcpReq.inputResponses && Object.keys(ctx.mcpReq.inputResponses).length > 0;
      if (!retried) this.callLog.push({ name: req.params.name, args: req.params.arguments });

      // Task branch (SEP-2663): server-directed async execution when the tool is
      // task-capable and the caller declared the extension.
      if (tool.task && this.callerDeclaredTasks(ctx)) {
        return this.startTask(tool, (req.params.arguments as Record<string, unknown>) ?? {}) as never;
      }

      if (this.spec.files) {
        const early = this.filesRound(tool, (req.params.arguments as Record<string, unknown>) ?? {}, ctx);
        if (early.result) return early.result as never;
        return (await this.runWithReplay(tool, (req.params.arguments as Record<string, unknown>) ?? {}, ctx, early.files)) as never;
      }
      return (await this.runWithReplay(tool, (req.params.arguments as Record<string, unknown>) ?? {}, ctx)) as never;
    });
  }

  /**
   * Files extension: validate the file params of a call, and either answer early (an error result, or an
   * `upload_required` round) or hand the received files to the tool handler.
   */
  private filesRound(tool: MockTool, args: Record<string, unknown>, ctx: ServerContext): { result?: Record<string, unknown>; files?: Record<string, MockReceivedFile> } {
    const f = this.spec.files!;
    const params = findFileParams(tool.inputSchema);
    if (params.size === 0) return {};
    const err = (text: string) => ({ result: { content: [{ type: "text", text }], isError: true } });
    const envCaps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
    const metaCaps = (ctx.mcpReq._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
    const declared = ((envCaps ?? metaCaps) as { extensions?: Record<string, { upload?: unknown } | undefined> } | undefined)?.extensions?.[FILES_EXT];
    const state = ctx.mcpReq.requestState<string>();
    const files: Record<string, MockReceivedFile> = {};
    const pending: FileInput[] = [];
    let inlineTotal = 0;
    for (const [param, { descriptor }] of params) {
      const v = args[param] as FileInput | undefined;
      if (v === undefined) continue;
      if (descriptor.maxSize !== undefined && v.size > descriptor.maxSize) return err(`${param}: larger than maxSize`);
      if (!acceptsFile(descriptor.accept, v.mimeType, v.name)) return err(`${param}: type not accepted`);
      if (v.data !== undefined) {
        const bytes = Uint8Array.from(Buffer.from(v.data, "base64"));
        inlineTotal += bytes.byteLength;
        if (bytes.byteLength !== v.size) return err(`${param}: size mismatch`);
        files[param] = { id: v.id, name: v.name, mimeType: v.mimeType, size: v.size, bytes, via: "inline" };
      } else if (v.size === 0) {
        files[param] = { id: v.id, name: v.name, mimeType: v.mimeType, size: 0, bytes: new Uint8Array(0), via: "inline" };
      } else pending.push(v);
    }
    if (inlineTotal > (f.maxInlineBytes ?? 0)) return err("inline data over maxInlineBytes");
    if (pending.length === 0) return { files };
    if (f.upload === false || !declared || declared.upload === undefined) return err("this call needs an out-of-band upload but the request did not declare it");
    if (state === undefined || !this.fileRounds.has(state)) {
      const token = `files-${++this.fileRound}`;
      const sink = f.sink;
      const uploads: UploadTarget[] = pending.map((p) =>
        f.target
          ? f.target(p.id, p)
          : {
              fileId: p.id,
              url: sink!.url(`/u/${token}/${p.id}`),
              method: "PUT" as const,
              headers: { "Content-Type": p.mimeType },
              credentials: "omit" as const,
              expiresAt: new Date(Date.now() + (f.expiresInMs ?? 60_000)).toISOString(),
            },
      );
      this.fileRounds.set(token, { ids: pending.map((p) => p.id), args: JSON.stringify(args) });
      const result = { resultType: "upload_required", content: [], uploads, requestState: token };
      this.uploadRequests.push(result);
      return { result };
    }
    this.fileRetries.push(state);
    const round = this.fileRounds.get(state)!;
    if (round.args !== JSON.stringify(args)) return err("arguments changed since the upload request");
    if (f.repeatUploadRequired) {
      const result = { resultType: "upload_required", content: [], uploads: [], requestState: `${state}-again` };
      this.uploadRequests.push(result);
      this.fileRounds.set(`${state}-again`, round);
      return { result };
    }
    for (const p of pending) {
      const got = f.sink?.requests.find((r) => r.method !== "GET" && r.path === `/u/${state}/${p.id}`);
      if (!got) return err(`${p.id}: bytes have not arrived`);
      const body = new Uint8Array(got.body);
      if (body.byteLength !== p.size) return err(`${p.id}: size mismatch`);
      const param = [...params.keys()].find((k) => (args[k] as FileInput | undefined)?.id === p.id)!;
      files[param] = { id: p.id, name: p.name, mimeType: p.mimeType, size: p.size, bytes: body, via: "upload" };
    }
    this.fileRounds.delete(state);
    return { files };
  }

  private callerDeclaredTasks(ctx: ServerContext): boolean {
    const envCaps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
    const metaCaps = (ctx.mcpReq._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
    const caps = (envCaps ?? metaCaps) as { extensions?: Record<string, unknown> } | undefined;
    return !!caps?.extensions?.[TASKS_EXT];
  }

  /**
   * Run a tool handler under the record/replay MRTR engine. The i-th
   * interaction call either returns the recorded answer or suspends the
   * handler, returning `inputRequired` with a requestState token; the retry
   * (client-driven on modern, SDK legacy shim on 2025 connections) records the
   * answer under the same token and re-runs from the top.
   */
  private async runWithReplay(
    tool: MockTool,
    args: Record<string, unknown>,
    ctx: ServerContext,
    files?: Record<string, MockReceivedFile>,
  ): Promise<CallToolResult | ReturnType<typeof inputRequired>> {
    const priorToken = ctx.mcpReq.requestState<string>();
    const token = priorToken ?? `replay-${++this.replaySeq}`;
    const answers = this.replay.get(token) ?? [];
    this.replay.set(token, answers);
    // Fold this round's responses in (keys are q<index>).
    for (const [k, v] of Object.entries(ctx.mcpReq.inputResponses ?? {})) {
      const idx = Number(k.slice(1));
      if (Number.isInteger(idx)) answers[idx] = v;
    }

    let i = 0;
    const interact = (build: () => InputRequest): unknown => {
      const idx = i++;
      if (answers[idx] !== undefined) return answers[idx];
      throw new Suspend(`q${idx}`, build());
    };
    const progressToken = (ctx.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken;
    const mockCtx: MockToolContext = {
      elicit: (params) =>
        Promise.resolve(
          interact(() =>
            (params as { mode?: string }).mode === "url"
              ? inputRequired.elicitUrl({
                  message: String((params as { message?: unknown }).message ?? ""),
                  url: String((params as { url?: unknown }).url ?? ""),
                })
              : inputRequired.elicit({
                  message: String((params as { message?: unknown }).message ?? ""),
                  requestedSchema: ((params as { requestedSchema?: unknown }).requestedSchema ?? {
                    type: "object",
                    properties: {},
                  }) as never,
                }),
          ) as { action: string; content?: unknown },
        ),
      sample: (params) =>
        Promise.resolve(interact(() => inputRequired.createMessage(params as never)) as { content: { type: string; text?: string } }),
      listRoots: () => Promise.resolve(interact(() => inputRequired.listRoots()) as { roots: Array<{ uri: string; name?: string }> }),
      progress: (progress, total) => {
        if (progressToken !== undefined) {
          void ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress, total } });
        }
      },
      meta: ctx.mcpReq._meta as Record<string, unknown> | undefined,
      signal: ctx.mcpReq.signal,
      ...(files ? { files } : {}),
    };

    try {
      const out = await tool.handler?.(args, mockCtx);
      this.replay.delete(token); // flow completed — free the recording
      if (out && typeof out === "object" && "content" in out) return out as CallToolResult;
      return { content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }) }] };
    } catch (err) {
      if (err instanceof Suspend) {
        return inputRequired({ inputRequests: { [err.key]: err.request }, requestState: token });
      }
      this.replay.delete(token);
      throw err;
    }
  }

  // ── tasks extension (SEP-2663) — custom-method handlers over the shared store ──
  private startTask(tool: MockTool, args: Record<string, unknown>): Record<string, unknown> {
    const now = new Date().toISOString();
    const record: MockTaskRecord = {
      task: {
        taskId: `task-${++this.taskSeq}`,
        status: "working",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: 60_000,
        pollIntervalMs: 25,
      },
      pendingInput: new Map(),
    };
    this.taskStore.set(record.task.taskId, record);

    const touch = () => (record.task.lastUpdatedAt = new Date().toISOString());
    const taskCtx: MockToolContext = {
      // Mid-flight input: register an inputRequests entry, flip to input_required,
      // resolve when tasks/update answers it.
      elicit: (params) =>
        this.awaitTaskInput(record, () =>
          (params as { mode?: string }).mode === "url"
            ? inputRequired.elicitUrl({ message: String((params as { message?: unknown }).message ?? ""), url: String((params as { url?: unknown }).url ?? "") })
            : inputRequired.elicit({
                message: String((params as { message?: unknown }).message ?? ""),
                requestedSchema: ((params as { requestedSchema?: unknown }).requestedSchema ?? { type: "object", properties: {} }) as never,
              }),
        ) as Promise<{ action: string; content?: unknown }>,
      sample: (params) => this.awaitTaskInput(record, () => inputRequired.createMessage(params as never)) as Promise<{ content: { type: string; text?: string } }>,
      listRoots: () => this.awaitTaskInput(record, () => inputRequired.listRoots()) as Promise<{ roots: Array<{ uri: string; name?: string }> }>,
      progress: () => {}, // notifications/progress MUST NOT be sent for a task (SEP-2663)
      meta: undefined,
    };

    setTimeout(async () => {
      try {
        const out = await tool.handler?.(args, taskCtx);
        if ((record.task.status as string) === "cancelled") return; // cancelled mid-run — keep that status
        record.result =
          out && typeof out === "object" && "content" in out
            ? (out as Record<string, unknown>)
            : { content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }) }] };
        record.task.status = "completed";
        touch();
      } catch (e) {
        if ((record.task.status as string) === "cancelled") return;
        record.error = { message: e instanceof Error ? e.message : String(e) };
        record.task.status = "failed";
        touch();
      }
    }, tool.taskDelayMs ?? 20);

    // CreateTaskResult: Result & Task (resultType is stamped by the wire codec, not us).
    return { ...record.task };
  }

  private awaitTaskInput(record: MockTaskRecord, build: () => InputRequest): Promise<unknown> {
    const key = `q${record.pendingInput.size}`;
    record.task.status = "input_required";
    record.task.lastUpdatedAt = new Date().toISOString();
    return new Promise((resolve) => {
      record.pendingInput.set(key, {
        request: build(),
        resolve: (response) => {
          record.pendingInput.delete(key);
          if (record.pendingInput.size === 0 && record.task.status === "input_required") {
            record.task.status = "working";
            record.task.lastUpdatedAt = new Date().toISOString();
          }
          resolve(response);
        },
      });
    });
  }

  private detailedTask(record: MockTaskRecord): Record<string, unknown> {
    const base: Record<string, unknown> = { ...record.task };
    if (record.task.status === "input_required" && record.pendingInput.size) {
      base.inputRequests = Object.fromEntries([...record.pendingInput].map(([k, v]) => [k, v.request]));
    }
    if (record.task.status === "completed" && record.result) base.result = record.result;
    if (record.task.status === "failed" && record.error) base.error = record.error;
    return base;
  }

  private installTasks(server: Server): void {
    const taskIdParams = z.looseObject({ taskId: z.string() });
    server.setRequestHandler("tasks/get", { params: taskIdParams }, (params) => {
      const record = this.taskStore.get(params.taskId);
      if (!record) throw new ProtocolError(INVALID_PARAMS, `unknown task ${params.taskId}`);
      return this.detailedTask(record) as never;
    });
    server.setRequestHandler(
      "tasks/update",
      // `inputResponses` is an MRTR-reserved param the SDK lifts out of the
      // params before the handler runs — read it from ctx.mcpReq instead.
      { params: z.looseObject({ taskId: z.string(), inputResponses: z.record(z.string(), z.unknown()).optional() }) },
      (params, ctx) => {
        const record = this.taskStore.get(params.taskId);
        if (!record) throw new ProtocolError(INVALID_PARAMS, `unknown task ${params.taskId}`);
        const responses =
          params.inputResponses ??
          ((ctx as unknown as ServerContext).mcpReq.inputResponses as Record<string, unknown> | undefined) ??
          {};
        for (const [k, v] of Object.entries(responses)) {
          record.pendingInput.get(k)?.resolve(v); // unknown/settled keys are ignored (spec)
        }
        return {} as never;
      },
    );
    server.setRequestHandler("tasks/cancel", { params: taskIdParams }, (params) => {
      const record = this.taskStore.get(params.taskId);
      if (!record) throw new ProtocolError(INVALID_PARAMS, `unknown task ${params.taskId}`);
      if (!["completed", "failed", "cancelled"].includes(record.task.status)) {
        record.task.status = "cancelled";
        record.task.lastUpdatedAt = new Date().toISOString();
      }
      return {} as never;
    });
  }

  // ── events extension (SEP-3415) — custom-method handlers over the controllable source ──
  private installEvents(server: Server, source: MockEventSource): void {
    const clientExt = (ctx: ServerContext) => {
      const envCaps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
      const metaCaps = (ctx.mcpReq._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
      return ((envCaps ?? metaCaps) as { extensions?: Record<string, unknown> } | undefined)?.extensions;
    };
    server.setRequestHandler("events/list", { params: z.looseObject({ cursor: z.string().optional() }) }, (params) => {
      return { resultType: "complete", ...source.list(params.cursor) } as never;
    });
    server.setRequestHandler(
      "events/poll",
      {
        params: z.looseObject({
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()).optional(),
          cursor: z.string().nullable().optional(),
          maxAgeMs: z.number().optional(),
          maxEvents: z.number().optional(),
        }),
      },
      (params, ctx) => {
        try {
          return source.poll(params, clientExt(ctx)) as never;
        } catch (e) {
          if ((e as { notFound?: boolean }).notFound) throw new ProtocolError(-32023, (e as Error).message, { kind: "event" });
          const rpc = e as { code?: number; message?: string; data?: unknown };
          if (typeof rpc?.code === "number") throw new ProtocolError(rpc.code, rpc.message ?? "events error", rpc.data);
          throw e;
        }
      },
    );
  }

  // ── skills extension (SEP-2640) — spec-shaped entries, built from spec.skills ──
  private async builtSkills(): Promise<BuiltSkill[]> {
    return Promise.all((this.spec.skills ?? []).map((k) => buildMockSkill(k)));
  }

  private installSkills(server: Server): void {
    const hint = () => ({ ttlMs: this.spec.skillsCache?.ttlMs ?? 0, cacheScope: this.spec.skillsCache?.cacheScope ?? "private" });
    const seen = (method: string, params: Record<string, unknown>) =>
      this.skillMetaLog.push({ method, meta: params._meta as Record<string, unknown> | undefined });
    server.setRequestHandler("skills/list", { params: z.looseObject({ cursor: z.string().optional() }) }, async (params) => {
      this.skillLog.push("skills/list");
      seen("skills/list", params);
      const entries = (await this.builtSkills()).map((b) => b.entry);
      const { slice, nextCursor } = this.page(entries, params.cursor);
      return { skills: slice, ...(nextCursor ? { nextCursor } : {}), ...hint() } as never;
    });
    server.setRequestHandler("skills/get", { params: z.looseObject({ uri: z.string() }) }, async (params) => {
      this.skillLog.push(`skills/get ${params.uri}`);
      seen("skills/get", params);
      const found = (await this.builtSkills()).find((b) => b.entry.uri === params.uri);
      if (!found) throw new ProtocolError(INVALID_PARAMS, `unknown skill ${params.uri}`, { uri: params.uri });
      return { skill: found.entry, ...hint() } as never;
    });
    if (this.spec.skillsDirectoryRead) {
      server.setRequestHandler("resources/directory/read", { params: z.looseObject({ uri: z.string(), cursor: z.string().optional() }) }, async (params) => {
        this.skillLog.push(`dir ${params.uri}`);
        seen("resources/directory/read", params);
        const dir = params.uri.endsWith("/") ? params.uri : params.uri + "/";
        const children = new Map<string, { uri: string; name: string; mimeType: string; size?: number }>();
        for (const b of await this.builtSkills()) {
          for (const [uri, text] of b.files) {
            if (!uri.startsWith(dir) || uri === dir) continue;
            const rest = uri.slice(dir.length);
            const slash = rest.indexOf("/");
            if (slash < 0) children.set(uri, { uri, name: rest, mimeType: "text/markdown", size: new TextEncoder().encode(text).byteLength });
            else children.set(dir + rest.slice(0, slash + 1), { uri: dir + rest.slice(0, slash + 1), name: rest.slice(0, slash), mimeType: "inode/directory" });
          }
        }
        if (children.size === 0) throw new ProtocolError(INVALID_PARAMS, `unknown directory ${params.uri}`, { uri: params.uri });
        return { resources: [...children.values()], ...hint() } as never;
      });
    }
  }

  // ── resources / prompts ────────────────────────────────────────────────────
  private installResources(server: Server, s: () => MockSpec): void {
    server.setRequestHandler("resources/list", (req) => {
      const { slice, nextCursor } = this.page(s().resources ?? [], req.params?.cursor);
      return {
        resources: slice.map((r) => ({ uri: r.uri, name: r.name ?? r.uri, mimeType: r.mimeType, ...(r._meta ? { _meta: r._meta } : {}) })),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
    server.setRequestHandler("resources/templates/list", () => ({
      resourceTemplates: (s().templates ?? []).map((t) => ({ uriTemplate: t.uriTemplate, name: t.name })),
    }));
    server.setRequestHandler("resources/read", async (req) => {
      const r = (s().resources ?? []).find((x) => x.uri === req.params.uri);
      if (!r) {
        const text = (await this.builtSkills()).find((b) => b.files.has(req.params.uri))?.files.get(req.params.uri);
        if (text !== undefined) {
          this.skillLog.push(`read ${req.params.uri}`);
          this.skillMetaLog.push({ method: "resources/read", meta: (req.params as { _meta?: Record<string, unknown> })._meta });
          return { contents: [{ uri: req.params.uri, mimeType: "text/markdown", text }] };
        }
      }
      if (!r) throw new ProtocolError(INVALID_PARAMS, `unknown resource ${req.params.uri}`, { uri: req.params.uri });
      const contents = r.read?.() ?? { text: `contents of ${r.uri}` };
      return {
        contents: [
          contents.blob != null
            ? { uri: r.uri, mimeType: r.mimeType ?? "application/octet-stream", blob: contents.blob, ...(r._meta ? { _meta: r._meta } : {}) }
            : { uri: r.uri, mimeType: r.mimeType ?? "text/plain", text: contents.text ?? "", ...(r._meta ? { _meta: r._meta } : {}) },
        ],
      };
    });
    // Registry-gated: reachable on legacy connections only (the 2026-07-28 era
    // replaced these with the subscriptions/listen filter).
    server.setRequestHandler("resources/subscribe", (req) => {
      this.subscribed.add(req.params.uri);
      return {};
    });
    server.setRequestHandler("resources/unsubscribe", (req) => {
      this.subscribed.delete(req.params.uri);
      return {};
    });
  }

  private installPrompts(server: Server, s: () => MockSpec): void {
    server.setRequestHandler("prompts/list", (req) => {
      const { slice, nextCursor } = this.page(s().prompts ?? [], req.params?.cursor);
      return {
        prompts: slice.map((p) => ({ name: p.name, description: p.description })),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
    server.setRequestHandler("prompts/get", (req) => {
      const p = (s().prompts ?? []).find((x) => x.name === req.params.name);
      if (!p) throw new ProtocolError(INVALID_PARAMS, `unknown prompt ${req.params.name}`);
      const out = p.get?.((req.params.arguments as Record<string, string>) ?? {}) ?? {
        messages: [{ role: "user", content: { type: "text", text: `prompt ${p.name}` } }],
      };
      return out as never;
    });
  }
}
