---
title: "Example apps"
---

Nine real UIs built on the client, each exercising a different surface of the reactive-cache-plus-hooks model. All of them share a WS proxy for local MCP server access except socialgpt-studio, which pairs with a Deno backend.

| App | Stack | What it demonstrates |
|---|---|---|
| **[inspector](https://github.com/johnhenry/mcp-query/tree/main/apps/inspector)** | Web Components + Vite | The flagship — a full MCP Inspector with a local stdio/HTTP proxy. Start here if you want to poke at a server interactively. |
| **[console](https://github.com/johnhenry/mcp-query/tree/main/apps/console)** | Web Components + Vite | A terminal-style MCP console over the shared WS proxy. |
| **[composer](https://github.com/johnhenry/mcp-query/tree/main/apps/composer)** | React + Vite | A chat composer where the *user* drives MCP tools to assemble grounded input, with a pluggable model picker ([ai.matey](https://github.com/johnhenry/ai.matey)). |
| **[approvals](https://github.com/johnhenry/mcp-query/tree/main/apps/approvals)** | React + Vite | Human-in-the-loop approvals — the pattern for tool calls that need a person to sign off before they execute. |
| **[notebook](https://github.com/johnhenry/mcp-query/tree/main/apps/notebook)** | React + Vite | An interactive notebook over MCP tools — the exploratory/scripting end of the spectrum. |
| **[ops-cockpit](https://github.com/johnhenry/mcp-query/tree/main/apps/ops-cockpit)** | React + Vite | An operations cockpit — dashboards and controls for running MCP-backed systems, not just querying them. |
| **[socialgpt-studio](https://github.com/johnhenry/mcp-query/tree/main/apps/socialgpt-studio)** | React + Vite + Deno | The one app with its own backend — shows the client working against a server you don't control end-to-end. |
| **[prompt-studio](https://github.com/johnhenry/mcp-query/tree/main/apps/prompt-studio)** | React + Vite | Prompts as a product surface — run server prompts with live `completion/complete` typeahead (including dependent completions), expand resource templates into subscribed reads, over codegen-typed hooks. |
| **[switchboard](https://github.com/johnhenry/mcp-query/tree/main/apps/switchboard)** | React + Vite | One governed endpoint, many tenants — an `@johnhenry/mcp-gate` sidecar fronting local + live remote upstreams, an interceptor trace waterfall, and per-tenant cache partitions via `client.scope()`. |

Each is a real, runnable example — clone the repo and `npm install && npm run dev` inside any `apps/*` directory.
