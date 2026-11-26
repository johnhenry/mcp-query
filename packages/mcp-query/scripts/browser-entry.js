// Entry point for the single-file browser bundle (see scripts/build-browser.mjs).
// Everything reachable from here is inlined: the MCP SDK client, zod, agent-query-core.
// React hooks (`./react`) are deliberately NOT part of this bundle.
export * from "../dist/index.js";

// Browser-safe transports. StdioClientTransport is Node-only and excluded.
export {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  InMemoryTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

// Browser-safe parts of @johnhenry/mcp-gate (its `browser` entry: library mode, no gateway
// Server, no stdio upstreams). Resolved from the monorepo source at build time.
export {
  createGateClient,
  compilePolicy,
  explainPolicy,
  policyListAnnotator,
  policyListFilter,
  validateGateConfig,
  redact,
  redactValue,
  resolveHttpUpstream,
  CircuitOpenError,
} from "../../mcp-gate/src/index.browser.ts";
