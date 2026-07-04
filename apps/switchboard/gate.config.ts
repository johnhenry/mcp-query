// Switchboard's governed endpoint. The WS proxy spawns `tsx <mcp-gate/cli> <this file>`
// as a stdio sidecar; the gate multiplexes the upstreams below behind one policy:
//   - `everything.get-env` is hidden AND denied (env leaks)
//   - destructive tools are denied
//   - anything shaped like a secret is redacted from every result
//   - at most 4 concurrent calls per upstream; failing upstreams trip a circuit breaker
//
// Remote upstreams are added only when reachable-by-default (Context7 needs no token) or
// their token is present, so the app demos fully offline on server-everything alone.
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GateConfig } from "@mcp-query/gate";
import type { ConnectionConfig } from "mcp-query";

const upstreams: Record<string, ConnectionConfig> = {
  everything: {
    transport: () =>
      new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }),
  },
};

if (process.env.SWITCHBOARD_OFFLINE !== "1") {
  upstreams.context7 = {
    transport: () =>
      new StreamableHTTPClientTransport(new URL("https://mcp.context7.com/mcp"), {
        requestInit: process.env.CONTEXT7_API_KEY
          ? { headers: { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY } }
          : undefined,
      }),
  };
  if (process.env.HF_TOKEN) {
    upstreams.hf = {
      transport: () =>
        new StreamableHTTPClientTransport(new URL("https://huggingface.co/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` } },
        }),
    };
  }
}

const config: GateConfig = {
  upstreams,
  policy: {
    deny: ["everything.get-env", "*.delete*", "*.remove*"],
    denyDestructive: true,
  },
  redact: [
    { pattern: /sk-[A-Za-z0-9]{8,}/g, replacement: "sk-[REDACTED]" },
    { pattern: /(?:api[_-]?key|token)["\s:=]+[A-Za-z0-9_\-.]{12,}/gi, replacement: "[REDACTED-CREDENTIAL]" },
  ],
  rateLimit: { concurrency: 4 },
  circuitBreaker: { threshold: 3, cooldownMs: 10_000 },
};

export default config;
