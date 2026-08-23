// Prompt Studio — prompts as a product surface.
//
// The console lists prompts; nobody RUNS them. This app is a workbench for the two
// MCP capabilities that make servers feel like products rather than tool bags:
//   - prompts/get with live completion/complete typeahead on arguments
//   - resource templates (URI Templates) expanded into parameterized reads
// plus the codegen loop (src/mcp.gen.ts → createTypedHooks) and persistCache, so a
// reload hydrates the last session's catalog instantly from localStorage.
//
// Connection: dev runs a WS proxy (npm run dev:proxy) that the browser dials; the proxy
// spawns `@modelcontextprotocol/server-everything` over stdio — it ships prompts with
// completable arguments, resource templates, and the completions capability.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeProxyClient, AppProvider } from "@app-shared";
import { persistCache } from "@johnhenry/mcp-query";
import { App } from "./App.js";
import "./styles.css";

export const SERVER = "everything";

const client = makeProxyClient({
  servers: {
    [SERVER]: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    },
  },
  clientInfo: { name: "prompt-studio", version: "0.0.1", title: "Prompt Studio" },
});

// Hydrate the cache from the last visit and persist writes (debounced) back.
persistCache(client.cache, window.localStorage, { key: "prompt-studio" });

void client.connect();

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <AppProvider client={client}>
      <App />
    </AppProvider>
  </StrictMode>,
);
