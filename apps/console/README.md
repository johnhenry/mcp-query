# MCP Console

An **operator UI** that auto-generates a polished, usable interface from any MCP server's
capability discovery. Point it at a server and it lists every tool, resource, and prompt,
builds an input form for each from its JSON Schema, runs it, and renders the result for a
human — tables for tabular data, images for image content, transcripts for prompt
messages, pretty JSON for everything else.

This is the **"use the server"** app, deliberately distinct from
[`apps/inspector`](../inspector) (a protocol debugger). There is **no raw JSON-RPC log, no
message composer, and no OAuth debugger** here — just the controls an operator needs to
actually drive a server.

Built with **vanilla Web Components** (no framework). It reuses mcp-query's
framework-agnostic core and the shared app spine:

- `@app-shared/reactive` — a `Reactive` base custom element (re-render on store change) + `esc`
- `@app-shared/schema-form` — `buildSchemaForm(jsonSchema)` → `{ element, getValues }`
- `@app-shared/transport` — `WebSocketProxyTransport` (browser ↔ local proxy bridge)
- `@app-shared/oauth` — `BrowserOAuthProvider` for direct browser-side OAuth
- `mcp-query` — `MCPClient`, `isReadOnly`, `isDestructive`
- `mcp-query/devtools` — `DevtoolsHub` (used only to cheaply re-render on activity)

## Run

```bash
npm run dev -w @mcp-query/console
```

`dev` runs two processes concurrently:

| process | what it does |
|---------|--------------|
| `dev:proxy` | a local **WebSocket proxy** (`tsx ../shared/src/proxy-cli.ts`) that dials stdio/http/sse MCP servers on the browser's behalf |
| `dev:web`   | the Vite dev server for the console UI |

The proxy prints a pre-wired URL — **open that link**, because it carries the
`?proxyToken=…&proxyPort=…` the browser needs to reach the proxy:

```
  ⬡ mcp-query proxy  ws://localhost:6281  (token abc123)
  → Open:  http://localhost:5174/?proxyToken=abc123&proxyPort=6281
```

> Direct OAuth (http/sse) servers connect straight from the browser and don't need the
> proxy token, but stdio servers always go through the proxy.

## Connect a server

Use the **Connect a server** panel in the header. The form is persisted to
`localStorage` (uncheck *save* to skip), and saved servers reconnect with one click.

### stdio (subprocess via the proxy)

The canonical demo server, which advertises tools, resources, and prompts:

| field | value |
|-------|-------|
| name | `everything` |
| transport | `stdio` |
| command | `npx` |
| args | `-y @modelcontextprotocol/server-everything` |

The proxy spawns the subprocess; the console lists its capabilities and lets you run them.

### direct http/sse with OAuth

| field | value |
|-------|-------|
| name | your label |
| transport | `http` (or `sse`) |
| url | the server's MCP endpoint, e.g. `https://example.com/mcp` |
| **direct** | ✅ checked |

With **direct** checked, the browser connects straight to the server using
`BrowserOAuthProvider`. If the server requires OAuth you'll be redirected to its identity
provider and back to the app with a `?code=…`; the console finishes the token exchange and
completes the connection automatically. (Plain http/sse servers that don't need auth also
work in direct mode, or you can leave *direct* unchecked to tunnel them through the proxy.)

## Using the console

- **Server switcher** (header): multiple servers can be connected at once; click a chip to
  make one active, or the ✕ to disconnect it.
- **Capability nav** (left): tools, resources, and prompts for the active server, with a
  filter box and `RO` (read-only) / `⚠` (destructive) badges derived from each tool's
  annotations. It re-renders automatically when a server emits `*_list_changed`.
  - **Keyboard:** `j`/`k` or `↓`/`↑` move the cursor, `Enter` opens, `/` focuses the filter.
- **Tool pane:** a form built from the tool's `inputSchema`, a **Run** button (destructive
  tools confirm first), and a result rendered for humans — arrays of objects become a
  table, image content renders inline, text/JSON is shown cleanly.
- **Resource pane:** opens a resource's contents, with a **live** toggle that subscribes
  (`readResource { subscribe: true }`) and re-reads on `resources/updated`.
- **Prompt pane:** fills the prompt's declared arguments and renders the returned messages
  as a transcript.

## Develop / verify

```bash
npm run typecheck -w @mcp-query/console
npm test       -w @mcp-query/console   # vitest + happy-dom
npm run build  -w @mcp-query/console
```

### Layout

```
src/
  main.ts                     # entry: registers <console-app>, resumes OAuth callback
  styles.css                  # self-contained operator theme (OKLCH + neumorphic)
  lib/
    store.ts                  # MCPClient, signals, connect/OAuth, localStorage server book
    render.ts                 # pure render/coercion helpers (unit-tested)
  components/
    console-app.ts            # header (connect form + switcher) + nav + main pane
    console-nav.ts            # capability list, filter, badges, keyboard nav
    console-tool.ts           # schema form → run → result
    console-resource.ts       # read + live subscribe
    console-prompt.ts         # args form → getPrompt → transcript
test/
  render.test.ts              # buildSchemaForm + coercion + render helpers
  integration.test.ts         # MockMCPServer + MCPClient end-to-end → render assertions
```
