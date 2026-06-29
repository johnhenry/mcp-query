# @mcp-query/ops-cockpit

A NOC-style **live operations dashboard** built on [`mcp-query`](../../packages/mcp-query),
monitoring **multiple MCP servers at once**. It aggregates every connection into a grid
of health tiles, lets you drill into a server's tools and *watch* read-only ones on an
interval, and streams a unified activity log fed by both the client's audit callback and
the devtools event hub.

It's a React + Vite app that talks to MCP servers through the shared **WebSocket proxy**
(the browser-to-stdio bridge that `mcp-query` deliberately leaves out).

## Run it

```bash
# from the repo root
npm run dev -w @mcp-query/ops-cockpit
```

`dev` runs two processes via `concurrently`:

- **`dev:proxy`** — `tsx ../shared/src/proxy-cli.ts`, the local WS↔MCP bridge
  (localhost-only, random bearer token, prints a connect URL with `?proxyPort` /
  `?proxyToken`).
- **`dev:web`** — Vite. Open the URL the proxy prints (it carries the token), e.g.
  `http://localhost:5175/?proxyPort=6282&proxyToken=…`.

By default the cockpit dials **two stdio servers**, `everything-a` and `everything-b`,
both `npx -y @modelcontextprotocol/server-everything`. The roster is editable in the UI
(add/reset) and persisted to `localStorage`.

### Other scripts

```bash
npm run typecheck -w @mcp-query/ops-cockpit
npm test          -w @mcp-query/ops-cockpit
npm run build     -w @mcp-query/ops-cockpit
```

## What you see

### 1. Tile grid — one tile per connection

Each tile shows, live:

- **Server name** + a color-coded **status badge** (healthy / connecting / degraded /
  failed / offline).
- **Lifecycle state** from `useServerState(server)` (`ready`, `reconnecting`, `failed`…).
- **Latency** — a shared poller calls `client.health()` (which round-trips a `ping` per
  server) on a configurable interval and shows the last `pingMs`.
- **Capability counts** — tools / resources / prompts, from `useTools`,
  `useResourceList`, `usePromptList` (these re-render on `*_list_changed`).
- A **hand-rolled inline SVG sparkline** of the rolling ping history (no chart lib — see
  `src/lib/sparkline.ts`).

The poll interval is adjustable in the control bar. Tiles update continuously.

### 2. Drill-down — click a tile

Lists that server's tools (re-rendered on `subscribeCapabilities` / `list_changed`).
**Read-only tools** (`isReadOnly`, i.e. `annotations.readOnlyHint`) get a **watch
widget**: pick args (a schema-driven form) and an interval, and it calls the tool via
`useToolResult({ refetchInterval })`, rendering each result with the shared `ResultView`.
Mutating tools are shown but not auto-watched (cockpit is observe-first).

### 3. Activity stream — live, filterable log

Newest-first. Two sources are merged in `src/lib/activity.ts`:

- the client's **`onCall` audit** entries (durable read/call/query outcomes: server,
  method, ok, ms), and
- **`DevtoolsHub`** events (wire-level request / response / notification / server-state).

Filter chips: `all` / `ok` / `error` / `audit` / `devtools`.

## How "killing a server" flips a tile

Each tile's status is derived purely from `(lifecycle state, live ping)` by
`healthToTileStatus()` (`src/lib/tile-status.ts`):

| Situation | Tile status |
|---|---|
| `ready` + ping ok | **healthy** (green) |
| `ready` + ping failing (silently dead) | **degraded** (amber) |
| `connecting` / `initializing` | **connecting** |
| `reconnecting` / `degraded` | **degraded** |
| `failed` / `closed` | **failed** (red) |

So if you **kill** one of the `server-everything` subprocesses (e.g. the proxy loses the
stdio transport), the next health poll's `ping` fails and `mcp-query` transitions the
connection — the tile flips to **degraded** then **failed**, its sparkline flatlines, and
a `server-state` row appears in the activity stream. **The app stays up** — failures are
isolated per connection, and an unreachable server is rendered as a failed tile rather
than crashing the dashboard. A tile that fails to connect at all shows the same failed
state with its tools unavailable until it reconnects.

## Wiring (entry point)

```ts
const activity = new ActivityStore();
const hub = new DevtoolsHub(2000);
activity.attachHub(hub);

const client = makeProxyClient({
  servers: toSpecMap(roster), // name -> TargetSpec ({ transport:"stdio"|"http"|"sse", … })
  hub,
  onCall: (e) => activity.push(e),
  clientInfo: { name: "ops-cockpit", version: "0.0.1" },
});
void client.connect();
// …rendered under <AppProvider client={client}>
```

Runtime "add server" calls `client.addServer(name, { transport })`, reusing the same
`WebSocketProxyTransport` factory the boot servers use.

## mcp-gate

The roster supports `http` / `sse` targets in addition to `stdio`, so a tile can point at
a **`mcp-gate`-fronted endpoint** (an auth/policy gateway in front of one or more MCP
servers) by adding a server with transport `http`/`sse` and the gate's URL. The cockpit
just monitors whatever the proxy can dial; pointing a tile at a gate is supported but not
required for the default experience.

## Tests

`npm test -w @mcp-query/ops-cockpit` runs (happy-dom):

- **`test/helpers.test.ts`** — pure helpers: the `health → tile-status` mapping, the
  rolling latency history + SVG sparkline geometry, and the activity filter.
- **`test/integration.test.ts`** — two `MockMCPServer`s ("mcp-query/testing") behind one
  `MCPClient` over `InMemoryTransport`, asserting tile data (state + capability counts +
  health→status), read-only tool detection, and that the `ActivityStore` captures the
  `onCall` audit stream.
```
