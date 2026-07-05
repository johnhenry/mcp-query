// In-memory mock MCP server harness. Spins up a *real* SDK Server over a linked
// in-memory transport pair, so a ServerConnection can be driven end-to-end with no
// subprocess. The spec is mutable and notifications are routed to the live server
// instance, which lets tests exercise:
//   - tool/resource/prompt listing + pagination
//   - tool calls (incl. isError + destructive/readOnly annotations)
//   - resources/updated  -> cache invalidation
//   - *_list_changed      -> dynamic registration
//   - reconnect with a CHANGED capability set (mutate spec between connects)
//   - resources/subscribe ref-counting

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  CompleteRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

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
}

export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler?: (
    args: Record<string, unknown>,
    ctx: MockToolContext,
  ) => { content: unknown[]; isError?: boolean } | unknown | Promise<unknown>;
  /**
   * Task-capable tool: a task-augmented call (params.task) creates a task, runs `handler`
   * asynchronously (after `taskDelayMs`, default 20ms), and stores its return value as the
   * task result. Plain calls still run the handler synchronously as usual.
   */
  task?: boolean;
  taskDelayMs?: number;
}
export interface MockResource {
  uri: string;
  name?: string;
  mimeType?: string;
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
  /** Advertise the logging capability (enables notifyLog). */
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
}

export class MockMCPServer {
  /** Mutable — change it between connects to simulate capability/list changes. */
  spec: MockSpec;

  // observability for assertions
  connectCount = 0;
  subscribed = new Set<string>();
  callLog: Array<{ name: string; args: unknown }> = [];

  /** Shared across reconnects so tasks survive a dropped connection (like a real server). */
  readonly taskStore = new InMemoryTaskStore();

  private active: Server | null = null;

  constructor(spec: MockSpec) {
    this.spec = spec;
  }

  /** Use as a ServerConnection `transport` factory: each call links a fresh server. */
  transport = (): Transport => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = this.build();
    this.active = server;
    this.connectCount++;
    void server.connect(serverT);
    return clientT;
  };

  // ── notification helpers (route to the live server) ──────────────────────
  async notifyResourceUpdated(uri: string): Promise<void> {
    await this.active?.notification({ method: "notifications/resources/updated", params: { uri } });
  }
  async notifyToolListChanged(): Promise<void> {
    await this.active?.notification({ method: "notifications/tools/list_changed" });
  }
  async notifyResourceListChanged(): Promise<void> {
    await this.active?.notification({ method: "notifications/resources/list_changed" });
  }
  async notifyPromptListChanged(): Promise<void> {
    await this.active?.notification({ method: "notifications/prompts/list_changed" });
  }
  async notifyLog(level: string, data: unknown, logger?: string): Promise<void> {
    await this.active?.notification({ method: "notifications/message", params: { level, data, logger } });
  }
  /** Push a task status snapshot (notifications/tasks/status). */
  async notifyTaskStatus(task: Record<string, unknown>): Promise<void> {
    await this.active?.notification({ method: "notifications/tasks/status", params: task });
  }
  /** The identity (name/version/title) the connected client advertised during initialize. */
  clientInfo(): { name?: string; version?: string; title?: string } | undefined {
    return this.active?.getClientVersion();
  }

  // ── server construction ───────────────────────────────────────────────────
  private capabilities(): ServerCapabilities {
    if (this.spec.capabilities) return this.spec.capabilities;
    const caps: ServerCapabilities = {};
    if (this.spec.tools) caps.tools = { listChanged: true };
    if (this.spec.resources || this.spec.templates) caps.resources = { subscribe: true, listChanged: true };
    if (this.spec.prompts) caps.prompts = { listChanged: true };
    if (this.spec.logging) caps.logging = {};
    if (this.spec.completions) caps.completions = {};
    if (this.spec.tools?.some((t) => t.task)) {
      (caps as { tasks?: unknown }).tasks = { list: {}, cancel: {}, requests: { tools: { call: {} } } };
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

  private build(): Server {
    const caps = this.capabilities();
    // Passing a taskStore auto-installs the tasks/get|result|list|cancel handlers.
    const server = new Server(
      { name: "mock", version: "1.0.0" },
      { capabilities: caps, ...((caps as { tasks?: unknown }).tasks ? { taskStore: this.taskStore } : {}) },
    );
    const s = () => this.spec;

    // Only register handlers for advertised capabilities — the SDK rejects handlers
    // for capabilities the server didn't declare.
    if (caps.tools) this.installTools(server, s);
    if (caps.resources) this.installResources(server, s);
    if (caps.prompts) this.installPrompts(server, s);
    if (caps.completions) {
      server.setRequestHandler(CompleteRequestSchema, (req) => {
        const completions = s().completions;
        const values =
          typeof completions === "function"
            ? completions(req.params.argument.name, req.params.argument.value, req.params.context?.arguments)
            : completions?.[req.params.argument.name] ?? [];
        return { completion: { values, hasMore: false } };
      });
    }
    return server;
  }

  private installTools(server: Server, s: () => MockSpec): void {
    server.setRequestHandler(ListToolsRequestSchema, (req) => {
      const { slice, nextCursor } = this.page(s().tools ?? [], req.params?.cursor);
      return {
        tools: slice.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: "object" },
          annotations: t.annotations,
        })),
        nextCursor,
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const tool = (s().tools ?? []).find((t) => t.name === req.params.name);
      this.callLog.push({ name: req.params.name, args: req.params.arguments });
      if (!tool) throw new Error(`unknown tool ${req.params.name}`);

      // Task-augmented call: acknowledge with a CreateTaskResult, run the handler
      // asynchronously, and store its return value as the task result.
      const taskParams = (req.params as { task?: { ttl?: number } }).task;
      const taskExtra = extra as unknown as {
        taskStore?: {
          createTask(o: { ttl?: number | null }): Promise<{ taskId: string }>;
          storeTaskResult(id: string, status: "completed" | "failed", result: unknown): Promise<void>;
        };
        taskRequestedTtl?: number;
      };
      if (tool.task && taskParams && taskExtra.taskStore) {
        const store = taskExtra.taskStore;
        const task = await store.createTask({ ttl: taskExtra.taskRequestedTtl ?? null });
        void (async () => {
          await new Promise((r) => setTimeout(r, tool.taskDelayMs ?? 20));
          try {
            const out = await tool.handler?.(req.params.arguments ?? {}, {
              sample: () => Promise.reject(new Error("sampling unavailable in task context")),
              elicit: () => Promise.reject(new Error("elicitation unavailable in task context")),
              listRoots: () => Promise.reject(new Error("roots unavailable in task context")),
              meta: req.params._meta as Record<string, unknown> | undefined,
              progress: () => {},
            });
            const result =
              out && typeof out === "object" && "content" in out
                ? (out as Record<string, unknown>)
                : { content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }) }] };
            // The task may have been cancelled while the handler ran — that's fine.
            await store.storeTaskResult(task.taskId, "completed", result).catch(() => {});
          } catch (e) {
            await store
              .storeTaskResult(task.taskId, "failed", {
                content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
                isError: true,
              })
              .catch(() => {});
          }
        })();
        return { task } as Record<string, unknown>;
      }

      const progressToken = (req.params._meta as { progressToken?: string | number } | undefined)?.progressToken;
      const ctx: MockToolContext = {
        sample: (params) => server.createMessage(params as never) as never,
        elicit: (params) => server.elicitInput(params as never) as never,
        listRoots: () => server.listRoots() as never,
        meta: req.params._meta as Record<string, unknown> | undefined,
        progress: (progress, total) => {
          if (progressToken !== undefined) {
            void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, total } });
          }
        },
      };
      const out = await tool.handler?.(req.params.arguments ?? {}, ctx);
      if (out && typeof out === "object" && "content" in out) return out as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }) }] };
    });
  }

  private installResources(server: Server, s: () => MockSpec): void {
    server.setRequestHandler(ListResourcesRequestSchema, (req) => {
      const { slice, nextCursor } = this.page(s().resources ?? [], req.params?.cursor);
      return {
        resources: slice.map((r) => ({ uri: r.uri, name: r.name ?? r.uri, mimeType: r.mimeType })),
        nextCursor,
      };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: (s().templates ?? []).map((t) => ({ uriTemplate: t.uriTemplate, name: t.name })),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, (req) => {
      const r = (s().resources ?? []).find((x) => x.uri === req.params.uri);
      if (!r) throw new Error(`unknown resource ${req.params.uri}`);
      const body = r.read?.() ?? { text: `contents of ${r.uri}` };
      return { contents: [{ uri: r.uri, mimeType: r.mimeType ?? "text/plain", ...body }] };
    });

    server.setRequestHandler(SubscribeRequestSchema, (req) => {
      this.subscribed.add(req.params.uri);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, (req) => {
      this.subscribed.delete(req.params.uri);
      return {};
    });
  }

  private installPrompts(server: Server, s: () => MockSpec): void {
    server.setRequestHandler(ListPromptsRequestSchema, () => ({
      prompts: (s().prompts ?? []).map((p) => ({ name: p.name, description: p.description })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, (req) => {
      const p = (s().prompts ?? []).find((x) => x.name === req.params.name);
      if (!p) throw new Error(`unknown prompt ${req.params.name}`);
      return p.get?.(req.params.arguments ?? {}) ?? { messages: [] };
    });
  }
}
