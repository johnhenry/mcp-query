// createAppHost — the framework-free MCP Apps host. Mounts `ui://` app resources and bridges the
// app's tools/call + resources/read through the existing MCPClient, so every interceptor on that
// client (mcp-gate policy, approval, rate-limit, redaction, audit) applies to app-initiated traffic
// exactly as it does to any other caller. Built on ext-apps' AppBridge; transport-agnostic here
// (see ./iframe.ts for the sandboxed-iframe wiring).
import type { CallContext, MCPClient } from "@johnhenry/mcp-query";
import type { Transport } from "@modelcontextprotocol/client";
import {
  AppBridge,
  RESOURCE_MIME_TYPE,
  getToolUiResourceUri,
  isToolVisibilityModelOnly,
  type McpUiResourceMeta,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { buildAppCsp, permissionsAllowAttribute, sanitizeCsp } from "./csp.js";
import { createStore } from "./store.js";
import type { AppCall, AppHostOptions, AppMessage, AppResource, AppSessionState } from "./types.js";

export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** Pass as `new MCPClient({ extensions })` so servers learn this client can render MCP Apps. */
export function mcpAppsExtensions(): Record<string, object> {
  return { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } };
}

export interface OpenAppOptions {
  /** The `ui://` resource to mount. One of `uri` / `tool` is required. */
  uri?: string;
  /** Resolve the app from this tool's `_meta.ui.resourceUri`. */
  tool?: string;
  /** Sent to the app as `ui/notifications/tool-input` once it has initialized. */
  toolInput?: Record<string, unknown>;
  /** Sent to the app as `ui/notifications/tool-result` once it has initialized. */
  toolResult?: Record<string, unknown>;
}

export interface AppSession {
  readonly id: string;
  readonly resource: AppResource;
  /** Advanced escape hatch (host-context pushes, sandbox handshake). Do not replace its on* handlers: that would bypass the gate wiring. */
  readonly bridge: AppBridge;
  getState(): AppSessionState;
  subscribe(cb: () => void): () => void;
  /** Attach the bridge to a transport (postMessage to a sandbox iframe, or any MCP `Transport`). */
  connect(transport: Transport): Promise<void>;
  /** Resolves when the app has completed `ui/initialize`; rejects on close, error or timeout. */
  whenReady(timeoutMs?: number): Promise<void>;
  /** Push a (new) tool result to a ready app. */
  sendToolResult(result: Record<string, unknown>): Promise<void>;
  /** Run `fn` when the session closes (e.g. remove the iframe). Runs immediately if already closed. */
  addCleanup(fn: () => void): void;
  /** Tell the app to tear down, close the transport, run cleanups. Idempotent. */
  close(): Promise<void>;
}

export interface AppHost {
  open(opts: OpenAppOptions): Promise<AppSession>;
  getSessions(): readonly AppSession[];
  /** Fires when a session is opened or closed (the list changed). */
  subscribe(cb: () => void): () => void;
  closeAll(): Promise<void>;
}

const DENIED_CODE = -32003; // AuthorizationError (mcp-query/server) -- same sentinel client.run() uses for audit

let nextSession = 1;

export function createAppHost(options: AppHostOptions): AppHost {
  const { client, server } = options;
  const maxHistory = options.maxHistory ?? 100;
  const sessions = new Set<AppSession>();
  const hostSubs = new Set<() => void>();
  let snapshot: readonly AppSession[] = [];
  const publish = () => {
    snapshot = [...sessions];
    for (const cb of [...hostSubs]) cb();
  };

  const cap = <T>(list: readonly T[], item: T): readonly T[] => [...list, item].slice(-maxHistory);

  async function open(opts: OpenAppOptions): Promise<AppSession> {
    const uri = resolveUri(client, server, opts);
    if (!uri.startsWith("ui://")) throw new Error(`MCP App resources use the ui:// scheme (got ${JSON.stringify(uri)})`);

    // The read goes through the client: interceptors/gate apply and the cache serves repeat mounts.
    const resource = await loadResource(client, server, uri, options);
    const id = `app-${nextSession++}`;
    const sref = { id, uri };
    const store = createStore<AppSessionState>({ id, server, uri, status: "loaded", messages: [], calls: [] });
    const cleanups: Array<() => void> = [];
    let closed = false;
    let seq = 0;

    const ctxFor = (): CallContext => {
      const base = typeof options.context === "function" ? options.context(sref) : options.context ?? {};
      return { ...base, meta: { principal: `mcp-app:${uri}`, ...(base.meta ?? {}) } };
    };

    const bridge = new AppBridge(
      null,
      options.hostInfo ?? { name: "mcp-query-ui", version: "0.1.0" },
      {
        serverTools: {},
        serverResources: {},
        message: { text: {} },
        ...(options.onOpenLink ? { openLinks: {} } : {}),
        sandbox: { permissions: resource.permissions, csp: resource.csp },
      },
      { hostContext: { ...options.hostContext, sandbox: { permissions: resource.permissions, csp: resource.csp } } as never },
    );

    /** Track one app-initiated operation through its outcome. */
    async function track<R>(kind: AppCall["kind"], target: string, args: Record<string, unknown> | undefined, run: () => Promise<R>): Promise<R> {
      const call: AppCall = { id: ++seq, at: Date.now(), kind, target, ...(args ? { args } : {}), outcome: "pending" };
      store.update((s) => ({ calls: cap(s.calls, call) }));
      const settle = (patch: Partial<AppCall>) =>
        store.update((s) => ({ calls: s.calls.map((c) => (c.id === call.id ? { ...c, ...patch } : c)) }));
      try {
        const r = await run();
        settle({ outcome: "ok" });
        return r;
      } catch (e) {
        settle({
          outcome: (e as { code?: number })?.code === DENIED_CODE ? "denied" : "error",
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }

    // tools/call: visibility is enforced here (spec: host MUST reject app calls to model-only
    // tools); everything else -- allow/deny/approve, rate limits, redaction, audit -- is the
    // client's interceptor stack.
    bridge.oncalltool = async (params) => {
      const def = client.listTools(server).find((t) => t.name === params.name);
      if (!def) throw new Error(`unknown tool ${JSON.stringify(params.name)} on ${server}`);
      if (isToolVisibilityModelOnly(def as never)) throw new Error(`tool ${JSON.stringify(params.name)} is not callable by apps (visibility excludes "app")`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return track("tool", params.name, args, () => client.callTool(params.name, args, { server, context: ctxFor() })) as never;
    };

    bridge.onreadresource = async (params) =>
      track("resource", params.uri, undefined, () => client.readResource(params.uri, { server, context: ctxFor() })) as never;

    bridge.onmessage = async (params) => {
      const message: AppMessage = { id: ++seq, at: Date.now(), role: params.role, content: params.content as unknown[] };
      store.update((s) => ({ messages: cap(s.messages, message) }));
      const r = await options.onMessage?.(message, sref);
      return r && r.isError ? { isError: true } : {};
    };

    bridge.onopenlink = async (params) => {
      if (!options.onOpenLink || !/^https?:\/\//i.test(params.url)) return { isError: true };
      try {
        return (await options.onOpenLink(params.url, sref)) ? {} : { isError: true };
      } catch {
        return { isError: true };
      }
    };

    bridge.addEventListener("sizechange", (p) => {
      const size = { ...(p.width != null ? { width: p.width } : {}), ...(p.height != null ? { height: p.height } : {}) };
      store.update({ size });
    });
    bridge.addEventListener("requestteardown", () => void close());
    bridge.addEventListener("initialized", () => {
      store.update({ status: "ready", appInfo: bridge.getAppVersion(), appCapabilities: bridge.getAppCapabilities() });
      void (async () => {
        try {
          if (opts.toolInput) await bridge.sendToolInput({ arguments: opts.toolInput });
          if (opts.toolResult) await bridge.sendToolResult(opts.toolResult as never);
        } catch (e) {
          fail(e);
        }
      })();
    });
    bridge.onclose = () => void close();

    function fail(e: unknown) {
      if (!closed) store.update({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }

    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      store.update({ status: "closing" });
      if (session.getState().appInfo) {
        await bridge.teardownResource({}, { timeout: options.teardownTimeoutMs ?? 1000 }).catch(() => {});
      }
      bridge.onclose = undefined;
      await bridge.close().catch(() => {});
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch (e) {
          console.error("[mcp-query-ui] cleanup threw:", e);
        }
      }
      store.update({ status: "closed" });
      sessions.delete(session);
      publish();
    }

    const session: AppSession = {
      id,
      resource,
      bridge,
      getState: store.getState,
      subscribe: store.subscribe,
      async connect(transport) {
        if (closed) throw new Error("session is closed");
        store.update({ status: "connecting" });
        try {
          await bridge.connect(transport);
        } catch (e) {
          fail(e);
          throw e;
        }
      },
      whenReady(timeoutMs = 10_000) {
        return new Promise<void>((resolve, reject) => {
          const check = () => {
            const st = session.getState().status;
            if (st === "ready") return done(resolve);
            if (st === "closed" || st === "closing" || st === "error") return done(() => reject(new Error(`app ${st} before ready${session.getState().error ? `: ${session.getState().error}` : ""}`)));
            return false;
          };
          const timer = setTimeout(() => done(() => reject(new Error(`app not ready after ${timeoutMs}ms`))), timeoutMs);
          const unsub = session.subscribe(check);
          function done(fn: () => void): true {
            clearTimeout(timer);
            unsub();
            fn();
            return true;
          }
          check();
        });
      },
      sendToolResult: (result) => bridge.sendToolResult(result as never),
      addCleanup(fn) {
        if (closed) fn();
        else cleanups.push(fn);
      },
      close,
    };

    sessions.add(session);
    publish();
    return session;
  }

  return {
    open,
    getSessions: () => snapshot,
    subscribe(cb) {
      hostSubs.add(cb);
      return () => void hostSubs.delete(cb);
    },
    async closeAll() {
      await Promise.allSettled([...sessions].map((s) => s.close()));
    },
  };
}

function resolveUri(client: MCPClient, server: string, opts: OpenAppOptions): string {
  if (opts.uri) return opts.uri;
  if (!opts.tool) throw new Error("open() needs a `uri` or a `tool`");
  const def = client.listTools(server).find((t) => t.name === opts.tool);
  if (!def) throw new Error(`unknown tool ${JSON.stringify(opts.tool)} on ${server}`);
  const uri = getToolUiResourceUri(def as never);
  if (!uri) throw new Error(`tool ${JSON.stringify(opts.tool)} declares no UI (_meta.ui.resourceUri)`);
  return uri;
}

async function loadResource(client: MCPClient, server: string, uri: string, options: AppHostOptions): Promise<AppResource> {
  const ctx: CallContext = { ...(typeof options.context === "function" ? options.context({ id: "pending", uri }) : options.context ?? {}) };
  ctx.meta = { principal: `mcp-app:${uri}`, ...(ctx.meta ?? {}) };
  const res = (await client.readResource(uri, { server, context: ctx })) as {
    contents?: Array<{ uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }>;
  };
  const item = res.contents?.find((c) => c.uri === uri) ?? res.contents?.[0];
  if (!item) throw new Error(`resource ${uri} returned no contents`);
  if (item.mimeType !== RESOURCE_MIME_TYPE) throw new Error(`resource ${uri} is not an MCP App (mimeType ${item.mimeType ?? "unset"}, expected ${RESOURCE_MIME_TYPE})`);
  const html = item.text ?? (item.blob != null ? atob(item.blob) : undefined);
  if (html == null) throw new Error(`resource ${uri} has no text/blob content`);

  // The read result's _meta wins; the resources/list entry is the spec's fallback location.
  const listed = client.listResources(server).find((r) => r.uri === uri) as { _meta?: Record<string, unknown> } | undefined;
  const meta = ((item._meta?.ui ?? listed?._meta?.ui) ?? {}) as McpUiResourceMeta;
  const csp = sanitizeCsp(meta.csp, options.allowDomain);
  return {
    uri,
    mimeType: item.mimeType,
    html,
    csp,
    cspHeader: buildAppCsp(csp),
    permissions: meta.permissions,
    allow: permissionsAllowAttribute(meta.permissions),
    ...(meta.domain ? { domain: meta.domain } : {}),
    ...(meta.prefersBorder != null ? { prefersBorder: meta.prefersBorder } : {}),
  };
}
