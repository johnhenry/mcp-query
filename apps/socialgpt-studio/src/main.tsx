import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MCPClient } from "mcp-query";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppProvider } from "@app-shared";
import { NavProvider } from "./nav.js";
import { App } from "./App.js";
import "./styles.css";

// Build the client directly — no WS proxy. Every server dials the RELATIVE url "/mcp",
// which Vite (dev) / the Deno|Node backend (prod) reverse-proxies to mcp.gpt.social
// with the OAuth bearer token injected server-side.
const client = new MCPClient({
  servers: {
    socialgpt: {
      transport: () => new StreamableHTTPClientTransport(new URL("/mcp", location.origin)),
    },
  },
  clientInfo: { name: "socialgpt-studio", version: "0.0.1" },
});

void client.connect();

const root = document.getElementById("app")!;
createRoot(root).render(
  <StrictMode>
    <AppProvider client={client}>
      <NavProvider>
        <App />
      </NavProvider>
    </AppProvider>
  </StrictMode>,
);
