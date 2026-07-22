// Shared types. We lean on the official SDK's wire types where possible and only
// define the few app-facing shapes the cache/connection layers need.

import type {
  Tool,
  Resource,
  ResourceTemplateType,
  Prompt,
  ServerCapabilities,
  LoggingLevel,
} from "@modelcontextprotocol/client";

// The v1 SDK called the wire type `ResourceTemplate`; v2 renamed it to
// `ResourceTemplateType`. Keep mcp-query's public alias stable.
export type ResourceTemplate = ResourceTemplateType;
export type { Tool, Resource, Prompt, ServerCapabilities, LoggingLevel };
export type { Tag } from "./tags.js";
export type { Task, TaskStatus, DetailedTask } from "./tasksExt.js";

/**
 * How this client identifies itself to servers — during `initialize` on
 * 2025-era connections, and in the per-request `_meta` envelope on the
 * 2026-07-28 era. Defaults to mcp-query's own name/version when omitted.
 */
export interface ClientInfo {
  name: string;
  version: string;
  title?: string;
}

/** The negotiated protocol generation of a connection (2026-07-28 spec). */
export type ProtocolEra = "legacy" | "modern";

/**
 * Per-server lifecycle, modeled on the LSP client state machine, plus an
 * MCP-specific `degraded` state for "connected but a wanted capability is absent"
 * and a `reconnecting` state that triggers cache reconciliation.
 */
export type ServerState =
  | "idle"
  | "connecting" // transport opening
  | "initializing" // handshake/probe + capability negotiation
  | "ready"
  | "degraded"
  | "reconnecting"
  | "failed"
  | "closed";

/**
 * Two error channels, mirrored from GraphQL (network vs graphQLErrors):
 *  - "protocol": a JSON-RPC error (transport/method failure) — thrown/rejected.
 *  - "tool":     a successful call whose *result* carried `isError: true` — surfaced as data.
 *  - "transport"/"timeout"/"cancelled": connection-level failures.
 */
export type MCPErrorKind = "protocol" | "tool" | "transport" | "timeout" | "cancelled";

/**
 * A real Error subclass (so `instanceof Error`, stacks, and String(e) all behave) that
 * still carries the structured fields consumers match on. Historically this was a plain
 * object — field access is unchanged, only the prototype gained Error semantics.
 */
export class MCPError extends Error {
  /** For resource-not-found errors (-32602 with a uri, or the legacy -32002), the resource URI. */
  readonly uri?: string;

  constructor(
    readonly kind: MCPErrorKind,
    message: string,
    readonly server?: string,
    readonly code?: number,
    readonly data?: unknown,
    uri?: string,
  ) {
    super(message);
    this.name = "MCPError";
    if (uri !== undefined) this.uri = uri;
  }
}

export type ListKind = "tools" | "resources" | "prompts";

/**
 * A server's `elicitation/create` request. "form" (the original shape) asks the user
 * to fill out structured fields inline. "url" asks the host to send the user to `url`
 * out-of-band; on the 2026-07-28 revision the server learns the outcome when the
 * client retries the original call (the multi-round-trip pattern), so there is no
 * `elicitationId`/completion-notification correlation anymore — servers that need to
 * correlate across retries encode their own identifier in `requestState`.
 */
export type ElicitationRequest =
  | { mode?: "form"; message: string; requestedSchema: Record<string, unknown> }
  | { mode: "url"; message: string; url: string };

/**
 * Handlers for server-initiated interactions. Registering one advertises the
 * capability. On 2025-era connections these answer server→client JSON-RPC
 * requests; on the 2026-07-28 era the SAME handlers are invoked by the SDK's
 * in-band multi-round-trip driver when a call returns `input_required`.
 */
export interface HostHandlers {
  /**
   * Server asks the host LLM to complete something. Omit in non-agentic apps.
   *
   * @deprecated The Sampling feature is deprecated as of MCP 2026-07-28
   * (SEP-2577; functional through the ≥12-month deprecation window, and still
   * used by the multi-round-trip driver when a server embeds a sampling
   * request). New designs should integrate LLM provider APIs directly.
   */
  sampling?: (req: unknown) => Promise<unknown>;
  /** Server asks the user for input mid-call: a form to fill out, or a URL to visit. */
  elicitation?: (
    req: ElicitationRequest,
  ) => Promise<{ action: "accept" | "decline" | "cancel"; content?: unknown }>;
  /**
   * Filesystem/URI boundaries the client exposes to the server.
   *
   * @deprecated The Roots feature is deprecated as of MCP 2026-07-28
   * (SEP-2577; functional through the deprecation window, and still used by
   * the multi-round-trip driver for embedded `roots/list` requests). Prefer
   * passing paths via tool parameters, resource URIs, or configuration.
   */
  roots?: () => Array<{ uri: string; name?: string }>;
}
