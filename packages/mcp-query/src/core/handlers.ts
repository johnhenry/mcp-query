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
import type { ElicitationRequest, HostHandlers } from "./types.js";

/** Returns the client-capabilities object to advertise, given which handlers exist. */
export function clientCapabilities(h: HostHandlers): ClientCapabilities {
  const caps: Record<string, unknown> = {
    // Declared unconditionally: mcp-query can drive the tasks extension
    // (SEP-2663) whenever the server offers it; the declaration is how the
    // server learns task-shaped tools/call answers are acceptable.
    extensions: { [TASKS_EXT]: {} },
  };
  if (h.sampling) caps.sampling = {};
  // Servers gate each elicitation mode on its own sub-capability — declare
  // both, since our handler (and the broker) supports form and url alike.
  if (h.elicitation) caps.elicitation = { form: {}, url: {} };
  if (h.roots) caps.roots = { listChanged: false };
  return caps as ClientCapabilities;
}

/** Wire the host handlers onto a freshly constructed SDK client (call before connect). */
export function installHandlers(client: Client, h: HostHandlers): void {
  if (h.sampling) {
    client.setRequestHandler("sampling/createMessage", async (req) => (await h.sampling!(req.params)) as never);
  }
  if (h.elicitation) {
    // Pass the params through as-is (mode "form" or "url") — don't assume form
    // shape, or url-mode requests silently lose their `url`.
    client.setRequestHandler("elicitation/create", async (req) => {
      return (await h.elicitation!(req.params as ElicitationRequest)) as never;
    });
  }
  if (h.roots) {
    client.setRequestHandler("roots/list", () => ({ roots: h.roots!() }));
  }
}
