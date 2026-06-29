// Build a runnable mock MCP server from a pinned contract, reusing mcp-query's
// MockMCPServer. Lets a consumer's tests run against the *contracted* surface with
// zero upstream — the contract becomes the test double.

import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import type { Contract } from "./contract.js";

/** Construct a MockMCPServer whose advertised surface mirrors the contract. */
export function mockFromContract(contract: Contract): MockMCPServer {
  return new MockMCPServer({
    tools: contract.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      annotations: t.annotations,
      // Placeholder result — the mock honors the *shape*, not real behavior.
      handler: () => ({ content: [{ type: "text", text: `[mock] ${t.name}` }] }),
    })),
    resources: contract.resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })),
    templates: contract.templates.map((t) => ({ uriTemplate: t.uriTemplate, name: t.name ?? t.uriTemplate })),
    prompts: contract.prompts.map((p) => ({ name: p.name, description: p.description, get: () => ({ messages: [] }) })),
  });
}
