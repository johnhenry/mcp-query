// Bidirectional handlers — server-initiated interactions (sampling, elicitation,
// roots). In MCP, as in LSP, *registering a handler is what advertises the
// capability*. Omit a handler and the server is told the client can't do it, so
// it never asks. Non-agentic apps typically register elicitation and omit
// sampling (no LLM in the loop).
//
// Era note (2026-07-28): on legacy connections these handlers answer real
// server→client JSON-RPC requests; on modern connections the SDK's
// multi-round-trip driver invokes the SAME registrations to fulfil requests a
// server embeds in an `input_required` result. One registration serves both.

import type { Client, ClientCapabilities } from "@modelcontextprotocol/client";

import { TASKS_EXT } from "./tasksExt.js";
import { warnDeprecatedFeature } from "./deprecations.js";
import type { ElicitationRequest, HostHandlers, RootsHandlerResult } from "./types.js";

/** Normalize a roots handler's return value to a `roots/list` result, keeping an optional `_meta` (restored by the draft revision). */
export function rootsResult(
  roots: NonNullable<HostHandlers["roots"]>,
  params?: unknown,
): { roots: Array<{ uri: string; name?: string }>; _meta?: Record<string, unknown> } {
  const out: RootsHandlerResult = roots(params as { _meta?: Record<string, unknown> } | undefined);
  return Array.isArray(out) ? { roots: out } : out;
}

/** Where a handler is installed: lets the deprecation warning name the server and tell eras apart. */
export interface HandlerContext {
  server: string;
  era: () => string | undefined;
}

/** Returns the client-capabilities object to advertise, given which handlers exist. */
export function clientCapabilities(h: HostHandlers, extensions?: Record<string, object>): ClientCapabilities {
  const caps: Record<string, unknown> = {
    // Declared unconditionally: mcp-query can drive the tasks extension
    // (SEP-2663) whenever the server offers it; the declaration is how the
    // server learns task-shaped tools/call answers are acceptable.
    extensions: { ...extensions, [TASKS_EXT]: {} },
  };
  if (h.sampling) caps.sampling = {};
  // Servers gate each elicitation mode on its own sub-capability — declare
  // both, since our handler (and the broker) supports form and url alike.
  if (h.elicitation) caps.elicitation = { form: {}, url: {} };
  if (h.roots) caps.roots = { listChanged: false };
  return caps as ClientCapabilities;
}

/** Wire the host handlers onto a freshly constructed SDK client (call before connect). */
export function installHandlers(client: Client, h: HostHandlers, ctx?: HandlerContext): void {
  // A modern-era server that asks for sampling/roots is using a feature SEP-2577 deprecates
  // (a legacy-era server is using the feature its own revision defines, so no warning there).
  const modern = (): boolean => ctx?.era() === "modern";
  if (h.sampling) {
    client.setRequestHandler("sampling/createMessage", async (req) => {
      if (modern()) warnDeprecatedFeature("sampling", ctx?.server);
      return (await h.sampling!(req.params)) as never;
    });
  }
  if (h.elicitation) {
    // Pass the params through as-is (mode "form" or "url") — don't assume form
    // shape, or url-mode requests silently lose their `url`.
    client.setRequestHandler("elicitation/create", async (req) => {
      return (await h.elicitation!(req.params as ElicitationRequest)) as never;
    });
  }
  if (h.roots) {
    client.setRequestHandler("roots/list", (req) => {
      if (modern()) warnDeprecatedFeature("roots", ctx?.server);
      return rootsResult(h.roots!, req.params) as never;
    });
  }
}
