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

import type { HostHandlers, ServerCapabilities } from "./types.js";

/** Returns the client-capabilities object to advertise, given which handlers exist. */
export function clientCapabilities(h: HostHandlers): ServerCapabilities {
  const caps: Record<string, unknown> = {};
  if (h.sampling) caps.sampling = {};
  if (h.elicitation) caps.elicitation = {};
  if (h.roots) caps.roots = { listChanged: false };
  return caps as ServerCapabilities;
}

/** Wire the host handlers onto a freshly constructed SDK client (call before connect). */
export function installHandlers(client: Client, h: HostHandlers): void {
  if (h.sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => (await h.sampling!(req.params)) as never);
  }
  if (h.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const p = req.params as { message: string; requestedSchema?: Record<string, unknown> };
      return (await h.elicitation!({ message: p.message, requestedSchema: p.requestedSchema ?? {} })) as never;
    });
  }
  if (h.roots) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: h.roots!() }));
  }
}
