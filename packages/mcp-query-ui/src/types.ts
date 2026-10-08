import type { CallContext, MCPClient } from "@johnhenry/mcp-query";
import type { McpUiAppCapabilities, McpUiHostContext, McpUiResourceCsp, McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CspDomainKind } from "./csp.js";

export type AppStatus = "loading" | "loaded" | "connecting" | "ready" | "closing" | "closed" | "error";

/** A `ui/message` the app asked the host to deliver to the conversation. Inert data until the host forwards it. */
export interface AppMessage {
  id: number;
  at: number;
  role: string;
  content: unknown[];
}

/** An app-initiated tool call or resource read, with its outcome under the gate. */
export interface AppCall {
  id: number;
  at: number;
  kind: "tool" | "resource";
  /** Tool name, or resource URI. */
  target: string;
  args?: Record<string, unknown>;
  /** `denied` = an authorization/approval refusal (JSON-RPC -32003); other failures are `error`. */
  outcome: "pending" | "ok" | "denied" | "error";
  error?: string;
}

/** The subscribable, immutable snapshot of one mounted app (`useSyncExternalStore`-compatible). */
export interface AppSessionState {
  readonly id: string;
  readonly server: string;
  readonly uri: string;
  readonly status: AppStatus;
  readonly error?: string;
  readonly appInfo?: { name: string; version: string; title?: string };
  readonly appCapabilities?: McpUiAppCapabilities;
  readonly size?: { width?: number; height?: number };
  readonly messages: readonly AppMessage[];
  readonly calls: readonly AppCall[];
}

/** What the host learned from reading the `ui://` resource. */
export interface AppResource {
  uri: string;
  mimeType: string;
  html: string;
  /** CSP domains after validation + the host's `allowDomain` filter -- what the sandbox proxy must enforce. */
  csp: McpUiResourceCsp;
  /** The CSP header value for `csp` (see {@link buildAppCsp}). Log it for audit. */
  cspHeader: string;
  permissions: McpUiResourcePermissions | undefined;
  /** `allow=` attribute value for the inner iframe (Permission Policy). */
  allow: string;
  /** Dedicated sandbox origin the server asked for, if any (informational). */
  domain?: string;
  prefersBorder?: boolean;
}

export interface AppHostOptions {
  /** The (gated) client. App-initiated tools/call and resources/read go through it. */
  client: MCPClient;
  /** The server that owns the app. Tools and resources are resolved against this server only. */
  server: string;
  /** Host identity shown to the app. Default `{ name: "mcp-query-ui", version }`. */
  hostInfo?: { name: string; version: string };
  /** Extra host context for the app (theme, locale, ...). `sandbox` is filled in from the resource. */
  hostContext?: McpUiHostContext;
  /**
   * Request context for every call/read an app makes (tenant `partition`, `meta`). `meta.principal`
   * defaults to `mcp-app:<uri>` so gate audit/approval can tell app-initiated traffic apart.
   */
  context?: CallContext | ((session: { id: string; uri: string }) => CallContext);
  /** Host-level allowlist over the CSP domains an app declared. Return false to drop one. */
  allowDomain?: (domain: string, kind: CspDomainKind) => boolean;
  /** Deliver an app's `ui/message`. Return `{ isError: true }` to refuse. Default: accept (it is also in `state.messages`). */
  onMessage?: (message: AppMessage, session: { id: string; uri: string }) => { isError?: boolean } | void | Promise<{ isError?: boolean } | void>;
  /** Open a link for the app. Return false to refuse. Default: refuse everything. Only http(s) URLs are ever offered. */
  onOpenLink?: (url: string, session: { id: string; uri: string }) => boolean | Promise<boolean>;
  /** Cap on retained `messages`/`calls` per session. Default 100. */
  maxHistory?: number;
  /** Per-request timeout (ms) for the teardown handshake on close. Default 1000. */
  teardownTimeoutMs?: number;
}
