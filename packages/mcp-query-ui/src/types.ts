import type { CallContext, InteractionBroker, MCPClient } from "@johnhenry/mcp-query";
import type { McpUiAppCapabilities, McpUiHostContext, McpUiResourceCsp, McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CspDomainKind, HostCspOptions, HostPermissionOptions } from "./csp.js";

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
  kind: "tool" | "resource" | "resources-list" | "prompts-list" | "sampling" | "model-context";
  /** Tool name, resource URI, or (for the opt-in capabilities) the wire method: `resources/list`, `prompts/list`, `sampling/createMessage`, `ui/update-model-context`. */
  target: string;
  args?: Record<string, unknown>;
  /** `denied` = an authorization/approval refusal (JSON-RPC -32003); other failures are `error`. */
  outcome: "pending" | "ok" | "denied" | "error";
  error?: string;
}

/** An app's `ui/update-model-context`: context the app wants included in the model's next turns. Untrusted input. */
export interface AppModelContext {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}

/**
 * Which extra requests an app may make. EVERYTHING here is off by default; an app's request for a
 * capability that is off is refused with a clear JSON-RPC error and recorded in `state.calls` as `denied`.
 * (`prompts/get` is not listed: ext-apps' `AppBridge` exposes no handler for it.)
 */
export interface AppCapabilityOptions {
  /** `resources/list`: the server's resource list from the client. */
  resourcesList?: boolean;
  /** `prompts/list`: the server's prompt list from the client. */
  promptsList?: boolean;
  /**
   * `sampling/createMessage`: the app asks the host's model for a completion. Needs an {@link InteractionBroker}
   * (`client.interactions` or `interactions`), so policy / a human approves each request. DISCOURAGED: sampling is
   * deprecated in the core MCP protocol (SEP-2577).
   */
  sampling?: boolean;
  /** `ui/update-model-context`: the app pushes context for the model. Needs `onUpdateModelContext`. */
  updateModelContext?: boolean;
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
  /** True when the host customised the CSP (`frame.csp`); `cspHeader` then differs from the spec-derived default. */
  hostCsp?: boolean;
}

/** Host-owned policy for the app frame (issue #66). Defaults are the spec's; the host may tighten freely, loosening is an explicit `unsafeLoosen` opt-in. */
export interface AppFrameOptions {
  /** Extra / overriding CSP directives and host-added domains. See {@link HostCspOptions}. */
  csp?: HostCspOptions;
  /** Narrow (or, with `unsafeLoosen`, extend) the Permission-Policy `allow` list / inner `permissions`. See {@link HostPermissionOptions}. */
  permissions?: HostPermissionOptions;
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
  /** Host-owned CSP / permission policy for the app frame. Sandbox tokens and the iframe element itself are options of `mountIframe`. */
  frame?: AppFrameOptions;
  /** Host-level allowlist over the CSP domains an app declared. Return false to drop one. */
  allowDomain?: (domain: string, kind: CspDomainKind) => boolean;
  /** Deliver an app's `ui/message`. Return `{ isError: true }` to refuse. Default: accept (it is also in `state.messages`). */
  onMessage?: (message: AppMessage, session: { id: string; uri: string }) => { isError?: boolean } | void | Promise<{ isError?: boolean } | void>;
  /** Open a link for the app. Return false to refuse. Default: refuse everything. Only http(s) URLs are ever offered. */
  onOpenLink?: (url: string, session: { id: string; uri: string }) => boolean | Promise<boolean>;
  /** Extra app capabilities, all OFF by default and opt-in one by one. See {@link AppCapabilityOptions}. */
  appCapabilities?: AppCapabilityOptions;
  /**
   * Broker that approves the opt-in capabilities (policy and/or a human). Defaults to `client.interactions`.
   * Needed for `sampling`; for the others it is used when present. Interactions are filed under the peer
   * `mcp-app:<ui uri>`, so a policy that auto-allows the server's own requests does not auto-allow an app's.
   */
  interactions?: InteractionBroker;
  /** Receives an approved `ui/update-model-context` (required with `appCapabilities.updateModelContext`). Throw to refuse. */
  onUpdateModelContext?: (update: AppModelContext, session: { id: string; uri: string }) => void | Promise<void>;
  /** Wait at most this long (ms) for a human on an approval; then deny. Default: wait forever. */
  approvalTimeoutMs?: number;
  /** Cap on retained `messages`/`calls` per session. Default 100. */
  maxHistory?: number;
  /** Per-request timeout (ms) for the teardown handshake on close. Default 1000. */
  teardownTimeoutMs?: number;
}
