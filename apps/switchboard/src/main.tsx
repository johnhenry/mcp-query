// Switchboard — one governed endpoint, many tenants.
//
// The browser client dials TWO targets through the WS proxy:
//   gate            an @mcp-query/gate sidecar (spawned as stdio: tsx <cli> <gate.config.ts>)
//                   fronting server-everything + Context7 (+ HF with a token) behind policy
//   context7-direct the same remote, ungoverned — the "governed vs direct" comparison
//
// Browser-side, every operation runs through an interceptor chain (trace → tenant-meta →
// rateLimit) — the same seam the gate uses server-side — and every tenant works in its own
// cache partition via client.scope({ partition }).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeProxyClient, AppProvider } from "@app-shared";
import { rateLimit } from "@johnhenry/mcpq/server";
import { traceInterceptor, tenantMetaInterceptor } from "./trace.js";
import { App } from "./App.js";
import "./styles.css";

export const client = makeProxyClient({
  servers: {
    gate: {
      transport: "stdio",
      command: "npx",
      args: ["tsx", __GATE_CLI__, __GATE_CONFIG__],
    },
    "context7-direct": {
      transport: "http",
      url: "https://mcp.context7.com/mcp",
    },
  },
  clientInfo: { name: "switchboard", version: "0.0.1", title: "Switchboard" },
  interceptors: [traceInterceptor(), tenantMetaInterceptor(), rateLimit({ concurrency: 4 })],
});

void client.connect();

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <AppProvider client={client}>
      <App />
    </AppProvider>
  </StrictMode>,
);
