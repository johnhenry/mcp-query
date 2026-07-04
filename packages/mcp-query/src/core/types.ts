// Shared types. We lean on the official SDK's wire types where possible and only
// define the few app-facing shapes the cache/connection layers need.

import type {
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  ServerCapabilities,
  Task,
  TaskStatus,
} from "@modelcontextprotocol/sdk/types.js";

export type { Tool, Resource, ResourceTemplate, Prompt, ServerCapabilities, Task, TaskStatus };
export type { Tag } from "./tags.js";

/**
 * How this client identifies itself to servers during `initialize` (the SDK's
 * `Implementation`). Defaults to mcp-query's own name/version when omitted.
 */
export interface ClientInfo {
  name: string;
  version: string;
  title?: string;
}

/**
 * Per-server lifecycle, modeled on the LSP client state machine, plus an
 * MCP-specific `degraded` state for "connected but a wanted capability is absent"
 * and a `reconnecting` state that triggers cache reconciliation.
 */
export type ServerState =
  | "idle"
  | "connecting" // transport opening
  | "initializing" // `initialize` handshake + capability negotiation
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
  constructor(
    readonly kind: MCPErrorKind,
    message: string,
    readonly server?: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "MCPError";
  }
}

export type ListKind = "tools" | "resources" | "prompts";

/** Handlers for server -> client requests. Registering one advertises the capability. */
export interface HostHandlers {
  /** Server asks the host LLM to complete something. Omit in non-agentic apps. */
  sampling?: (req: unknown) => Promise<unknown>;
  /** Server asks the user for structured input mid-call. Maps to a UI dialog. */
  elicitation?: (req: {
    message: string;
    requestedSchema: Record<string, unknown>;
  }) => Promise<{ action: "accept" | "decline" | "cancel"; content?: unknown }>;
  /** Filesystem/URI boundaries the client exposes to the server. */
  roots?: () => Array<{ uri: string; name?: string }>;
}
