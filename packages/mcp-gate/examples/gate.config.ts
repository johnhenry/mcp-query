// Example gate config: front @modelcontextprotocol/server-everything (stdio), deny
// destructive tools, redact SSNs from any result, cap concurrency, and break on failure.
// Serve it with:  npx tsx packages/mcp-gate/src/cli.ts packages/mcp-gate/examples/gate.config.ts

import type { GateConfig } from "../src/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config: GateConfig = {
  upstreams: {
    everything: {
      transport: () => new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }),
    },
  },
  policy: {
    denyDestructive: true, // block anything flagged destructiveHint
    deny: ["*.get-env"], // and explicitly block this tool (glob over `server.tool`)
  },
  redact: [
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[EMAIL]" },
  ],
  rateLimit: { concurrency: 8 },
  circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
};

export default config;
