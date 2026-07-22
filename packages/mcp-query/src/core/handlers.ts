// Bidirectional handlers — the server -> client request channel (sampling,
// elicitation, roots). In MCP, as in LSP, *registering a handler is what advertises
// the capability*. Omit a handler and the server is told the client can't do it,
// so it never asks. Non-agentic apps typically register elicitation + roots and
// omit sampling (no LLM in the loop).

import {
  CreateMessageRequestSchema, // sampling
  ElicitRequestSchema, // elicitation
  ListRootsRequestSchema, // roots
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { ElicitationRequest, HostHandlers, ServerCapabilities } from "./types.js";

/** Returns the client-capabilities object to advertise, given which handlers exist. */
export function clientCapabilities(h: HostHandlers): ServerCapabilities {
  const caps: Record<string, unknown> = {};
  if (h.sampling) caps.sampling = {};
  // Servers gate each elicitation mode on its own sub-capability — declare both,
  // since our handler (and the broker) supports form and url alike.
  if (h.elicitation) caps.elicitation = { form: {}, url: {} };
  if (h.roots) caps.roots = { listChanged: false };
  return caps as ServerCapabilities;
}

/** Wire the host handlers onto a freshly constructed SDK client (call before connect). */
export function installHandlers(client: Client, h: HostHandlers): void {
  if (h.sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => (await h.sampling!(req.params)) as never);
  }
  if (h.elicitation) {
    // Pass the params through as-is (mode "form" or "url") — don't assume form shape,
    // or url-mode requests silently lose their `url`/`elicitationId`.
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      return (await h.elicitation!(req.params as ElicitationRequest)) as never;
    });
  }
  if (h.roots) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: h.roots!() }));
  }
}
