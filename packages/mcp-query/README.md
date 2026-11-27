# mcp-query

**A reactive, cached, embeddable MCP client for ordinary (non-agentic) applications.**

MCP is almost always consumed by LLM agents. But an MCP server is just a typed,
introspectable capability surface — tools, resources, prompts — and there's no
reason a normal app can't use it as a universal data/capability layer. `mcp-query`
gives such apps the developer experience that Apollo/React-Query gave GraphQL/REST
apps: hooks, a cache, reactivity, optimistic updates, devtools — on top of the
official v2 MCP SDK (`@modelcontextprotocol/client`).

**MCP 2026-07-28 ready, v1 by default.** Unconfigured connections speak the
classic 2025-era protocol byte-for-byte (no probe, no behavioral changes).
Opt into newer revisions per client or per connection with the additive
`versions` list:

```ts
new MCPClient({ servers, versions: ["2026-07-28", "2025-11-25"] });
// → probe via server/discover; speak 2026-07-28 where offered, fall back
//   losslessly to v1 otherwise. A modern-only list (["2026-07-28"]) pins.
```

On a modern connection you get the full revision — multi-round-trip
elicitation/sampling through the same human-in-the-loop broker, change
notifications over `subscriptions/listen`, SEP-2549 `ttlMs`/`cacheScope`
cache hints, per-request `logLevel` — while legacy connections keep the
classic behavior (including session resumption). `connection(name).era`
tells you what was actually negotiated; `versionNegotiation` remains the
low-level escape hatch. Deprecated
surfaces (sampling/roots/logging per SEP-2577, sessions per SEP-2567, the old
tasks RPCs per SEP-2663) are annotated `@deprecated` and remain functional on
legacy connections. Tasks are reimplemented on the `io.modelcontextprotocol/tasks`
extension wire shapes. They work on legacy connections with any SDK and on
2026-07-28 connections with `@modelcontextprotocol/client` >= 2.3.0 (status is
poll-only on the modern era); see [Tasks and SDK versions](#tasks-and-sdk-versions).

> Status: **published, working reference implementation.** `main` is pre-2026-07-28:
> this package is at `0.0.1`, the `latest` tag on npm, and speaks MCP 2025-11-25 (v1)
> only, on top of the official `@modelcontextprotocol/sdk@^1.29.0`. `tsc --noEmit` is
> clean and the full vitest suite passes (`npm test` for the current count), including
> end-to-end coverage of the cache, multiplexing, protocol-driven invalidation, dynamic
> registration, reconnect, the human-in-the-loop broker, and Inspector-style tooling
> (message log, manual sampling, auth recorder, CLI) — all driven against a *real* SDK
> server over an in-memory transport, with the codegen CLI verified against the live
> `@modelcontextprotocol/server-everything`. A preview build with the 2026-07-28
> migration (v2 SDK, dual-era support, `versions` negotiation) is in progress on
> [PR #17](https://github.com/johnhenry/mcp-query/pull/17), held until the spec
> finalizes on the 28th — try it via the `rc` dist-tag: `npm install @johnhenry/mcp-query@rc`.
> See [Supported protocol versions](#supported-protocol-versions) below.

## Install

```bash
npm install @johnhenry/mcp-query
```

This installs `latest` (`0.0.1`), which speaks MCP 2025-11-25 (v1) only. To preview
the in-progress 2026-07-28 migration ahead of its release, install the `rc` tag instead:
`npm install @johnhenry/mcp-query@rc`.

## Supported protocol versions

| npm tag | Version | Protocol | SDK |
|---|---|---|---|
| `latest` (default, this branch) | `0.0.1` | MCP 2025-11-25 only | `@modelcontextprotocol/sdk@^1.29.0` (v1) |
| `rc` | `0.1.0-rc.1` | MCP 2025-11-25 + opt-in 2026-07-28 | v2 SDK, dual-era |

The `rc` preview (built from [PR #17](https://github.com/johnhenry/mcp-query/pull/17),
not yet merged to `main`) adds opt-in support for the finalized 2026-07-28 revision via
an additive `versions` list:

```ts
new MCPClient({ servers, versions: ["2026-07-28", "2025-11-25"] })
```

This probes each server with `server/discover`, speaks 2026-07-28 where the server
offers it, and falls back losslessly to 2025-11-25 (v1) otherwise; a modern-only list
pins (no fallback). Unconfigured connections — and everything installed from `latest`
today — keep speaking 2025-11-25 byte-for-byte, no probe.

## Browser

### Single-file browser bundle

`@johnhenry/mcp-query/browser-bundle` is one self-contained ES module for hosts that vendor or
sandbox their dependencies (no nested `node_modules`, no CDN resolution, no peer-dependency
surprises). The MCP SDK client, `zod`, and `@johnhenry/agent-query-core` are inlined, so a single
`import` makes a single request:

```js
import { MCPClient, StreamableHTTPClientTransport, createGateClient } from "/vendor/mcp-query.browser.js";
// or, through a bundler / import map: "@johnhenry/mcp-query/browser-bundle"

const client = new MCPClient({
  servers: { api: { transport: () => new StreamableHTTPClientTransport(new URL("https://example.com/mcp")) } },
});
await client.connect();
```

What is inside:

- everything `@johnhenry/mcp-query` exports from its main entry (`MCPClient`, cache, router, interceptors, ...);
- the browser-safe transports `StreamableHTTPClientTransport`, `SSEClientTransport`, `InMemoryTransport`
  (the Node-only `StdioClientTransport` is excluded; reach stdio servers through a bridge, below);
- the browser-safe parts of [`@johnhenry/mcp-gate`](../mcp-gate), its `browser` export condition:
  `createGateClient`, `compilePolicy`, `explainPolicy`, `policyListAnnotator`, `policyListFilter`,
  `validateGateConfig`, `redact`, `redactValue`, `resolveHttpUpstream`, `CircuitOpenError`. The gateway
  `Server` (`createGate`) and stdio upstreams are not included.

What is not: **the React hooks** (`@johnhenry/mcp-query/react`) are not in this bundle. They need your
app's single copy of `react`, so they stay a normal module import with `react` external; this
bundle is the framework-free core. Types for the core and transports ship as
`dist/browser/mcp-query.browser.d.ts`; the gate's types come from `@johnhenry/mcp-gate`.

The existing export paths (`.`, `./react`, `./transports`, ...) resolve exactly as before.
The bundle is built by `npm run build` (`scripts/build-browser.mjs`, esbuild, minified ESM,
`es2022`) and checked by `test/browser-bundle.test.ts`, which serves the single file to
Chromium, intercepts every request to prove nothing else is fetched, constructs an `MCPClient`
and connects it, plus a governed gate client, over an in-page transport. (The Chromium step needs
Playwright, which is not a dependency of this repo; it runs when `require("playwright")` resolves or
`PLAYWRIGHT_MODULE` points at an install, and is skipped otherwise.)

Sizes (regenerate with `npm run size-table -w @johnhenry/mcp-query -- --write`):

<!-- size-table:start -->
| File | Raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `mcp-query.browser.js` (minified, one file) | 372.6 KiB | 101.1 KiB | 86.2 KiB |

Where the raw bytes come from:

| Inlined package | Raw (minified) |
| --- | ---: |
| `@modelcontextprotocol/client` | 190.9 KiB |
| `zod` | 84.6 KiB |
| `@johnhenry/mcp-query (core)` | 48.1 KiB |
| `@modelcontextprotocol/core` | 16.0 KiB |
| `@johnhenry/mcp-gate (browser parts)` | 14.2 KiB |
| `@johnhenry/agent-query-core` | 7.8 KiB |
| `eventsource` | 5.1 KiB |
| `eventsource-parser` | 3.7 KiB |
| `pkce-challenge` | 0.7 KiB |
<!-- size-table:end -->

### Connecting to servers from a browser

A page has two ways to reach an MCP server: **Streamable HTTP, directly** (a remote server, or a
local one that speaks HTTP), or **through a local bridge** for stdio servers.

#### Streamable HTTP from a page

```ts
import { MCPClient, StreamableHTTPClientTransport } from "@johnhenry/mcp-query";

const client = new MCPClient({
  versions: ["2026-07-28", "2025-11-25"], // modern first, fall back to the 2025-era handshake
  servers: {
    api: {
      transport: () =>
        new StreamableHTTPClientTransport(new URL("https://api.example.com/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }, // or an authProvider (OAuth)
        }),
    },
  },
});
```

The page's `fetch` is subject to CORS, and MCP's headers are all non-safelisted, so **every request
is preflighted**. A browser-reachable server (or the reverse proxy in front of it) must therefore
allow and expose the headers below. CORS is not defined by the MCP spec; this table is what the
2026-07-28 and 2025-11-25 Streamable HTTP pages require clients to *send* and *read*, which is
what CORS must let through.

| | 2026-07-28 | 2025-era (2025-03-26 to 2025-11-25) |
| --- | --- | --- |
| `Access-Control-Allow-Methods` | `POST, OPTIONS` (GET and DELETE are removed; a server answers them `405`) | `POST, GET, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type`, `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Authorization`, plus one `Mcp-Param-<Name>` per `x-mcp-header` your tools declare | `Content-Type`, `Accept`, `MCP-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID`, `Authorization` |
| `Access-Control-Expose-Headers` | `WWW-Authenticate` (OAuth discovery on `401`) | `Mcp-Session-Id`, `WWW-Authenticate` |
| `Access-Control-Allow-Origin` | the page's exact origin (echoed from an allowlist) + `Vary: Origin` | same |

Details that matter:

- **2026-07-28 request headers.** `MCP-Protocol-Version` on every POST; `Mcp-Method` on every request;
  `Mcp-Name` on `tools/call`, `resources/read` and `prompts/get` (Base64 `=?base64?...?=` encoded when the
  value is not plain ASCII); and `Mcp-Param-<Name>` for each tool parameter whose `inputSchema` has an
  `x-mcp-header` annotation (so `{"x-mcp-header": "Region"}` is sent as `Mcp-Param-Region`). A server must
  validate them against the body and answers a mismatch with `400` and JSON-RPC error `-32020`. There is
  no session id in this revision and nothing session-related to expose.
- **`Mcp-Param-*` cannot be wildcarded.** `Access-Control-Allow-Headers` has no prefix patterns, and its `*`
  does not cover `Authorization` (and is ignored on credentialed requests), so list the header names your
  tools actually use, plus `Authorization` explicitly. If the tool set is dynamic, echo the preflight's
  `Access-Control-Request-Headers` back after checking each name against an allowlist.
- **2025-era servers.** The session id arrives in an `Mcp-Session-Id` *response* header; the browser hides it
  from JavaScript unless it is in `Access-Control-Expose-Headers`, and the client then sends it back as a
  request header (so it is also in `Allow-Headers`). Without `Expose-Headers: Mcp-Session-Id` a
  session-ful server appears to work for `initialize` and then fails on the next call. `Last-Event-ID` is
  only sent when resuming an SSE stream.
- **Both eras, when you probe.** With `versions: ["2026-07-28", ...]` the first request is a modern probe;
  a legacy server's `400`/`404`/`405` then triggers the `initialize` fallback. CORS must be correct on
  those error responses too (headers on non-2xx answers, not only on `200`), or the browser reports an
  opaque network error instead of the status and the fallback cannot tell what happened.
- **Preflight.** Answer `OPTIONS` on the MCP endpoint with `204`, the `Allow-*` headers above, and
  `Access-Control-Max-Age` (for example `600`). Preflights do not carry `Authorization`, so do not
  require auth on `OPTIONS`.
- **`Origin` is still validated.** The spec requires servers to reject requests with an invalid `Origin`
  with `403` (DNS-rebinding defence). A CORS allowlist and that check should use the same list.
- **Auth.** A `401` should carry `WWW-Authenticate` (exposed, as above). The OAuth discovery documents
  and the authorization server's token and registration endpoints are fetched by the page too, so they
  need CORS as well. Run OAuth in the page with an `authProvider` (see `instrumentAuthProvider`).
- **Local servers from an `https` page.** Browsers may additionally require a private-network-access
  opt-in on the preflight (`Access-Control-Allow-Private-Network: true`) and block `http` from `https`
  as mixed content, with `http://localhost` / `http://127.0.0.1` exempted. Check the browser versions
  you target.

A minimal Node reference (adapt the allowlist):

```js
const ALLOWED = new Set(["https://app.example"]);
const HEADERS = "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Authorization, Mcp-Param-Region, Mcp-Session-Id, Last-Event-ID";
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED.has(origin)) return res.writeHead(403).end();
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate"); // drop Mcp-Session-Id on 2026-07-28-only servers
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", HEADERS);
    res.setHeader("Access-Control-Max-Age", "600");
    return res.writeHead(204).end();
  }
}
```

#### stdio servers: the WebSocket bridge

A page cannot spawn a stdio server, so a local **bridge** relays JSON-RPC between a WebSocket and the
child process. The wire protocol (framing, how the target command is selected, token and `Origin`
checks, lifecycle, errors) is specified in [docs/ws-stdio-bridge.md](https://github.com/johnhenry/mcp-query/blob/main/packages/mcp-query/docs/ws-stdio-bridge.md); the
reference implementation is `apps/shared`'s `startProxy` and is pinned by tests. mcp-query does not ship
a bridge itself. Because the bridge **spawns local processes on behalf of a web page**, any
implementation must bind to loopback, check `Origin`, require a token and refuse to spawn anything it
was not explicitly told to allow; the doc lists the exact requirements. The reference bridge is safe by
default: `Origin` required and loopback-only, and **no target allowed until you pass `allowTargets`** (or the
named, warning-logging `allowAnyTarget` escape hatch).


### Tasks and SDK versions

The `io.modelcontextprotocol/tasks` extension (SEP-2663) is driven over raw
requests with mcp-query's own schemas (field names verified against the
ext-tasks v2 schema: `ttlMs`, `pollIntervalMs`, `inputRequests`, `inputResponses`).

| Connection era | SDK 2.0.x - 2.2.x | SDK >= 2.3.0 |
| --- | --- | --- |
| 2025-11-25 (legacy) | works | works |
| 2026-07-28 (modern) | fails fast: the SDK blocks `tasks/get` / `tasks/cancel` on that wire | works: `callToolTask`, `getTask`, `cancelTask`, `input_required` rounds via `tasks/update` |

The peer range stays `^2.0.0`; mcp-query probes the installed SDK at runtime rather
than comparing versions. On a modern connection with an older SDK, the task calls
reject with an error naming the 2.3.0 requirement (or pin that server's `versions` to
a legacy revision). Task status on the modern era is **poll-only**:
`notifications/tasks` needs a `taskIds` filter on `subscriptions/listen`, which the SDK
client does not expose, so handles poll `tasks/get` at the server's `pollIntervalMs`.
`notifications/tasks` pushes are still consumed on legacy connections.

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit (covers src + examples)
npm test              # vitest run
npm run build         # emit dist/ (ESM + .d.ts) — what `npm publish` ships
npm run example:node  # runnable: drives @modelcontextprotocol/server-everything
npm run codegen -- --command npx --args "-y @modelcontextprotocol/server-everything" --out src/mcp.gen.ts
```

### Examples

A graded series from one-liner to full app lives in [`examples/`](./examples) (see
[examples/README.md](./examples/README.md)) — `01`→`06` are **runnable** with no network
(`npm run example:01` … `example:06`):

- **01** connect/list/call · **02** caching + invalidation · **03** live subscriptions ·
  **04** multi-server routing · **05** human-in-the-loop · **06** *running alongside a
  separate MCP client on shared state*.
- [`examples/node-everything.ts`](./examples/node-everything.ts) — guided tour against the
  real `server-everything` (`npm run example:node`).
- [`examples/07-hybrid-agent-ui.tsx`](./examples/07-hybrid-agent-ui.tsx) /
  [`react-app.tsx`](./examples/react-app.tsx) — illustrative React (agent + live UI + broker;
  every React surface).

### What the tests cover

| File | Exercises |
|---|---|
| `test/cache.test.ts` | staleTime, subscriber ref-counting, tag + protocol invalidation, optimistic rollback, gc |
| `test/router.test.ts` | tool/resource routing, namespacing, ambiguity errors |
| `test/connection.test.ts` | connect/negotiate, cursor pagination, `resources/updated`, `list_changed`, **reconnect with a changed capability set** |
| `test/session-resume.test.ts` | session capture/persist, resume-skips-`initialize`, validated fallback on forgotten sessions, resume across reconnect |
| `test/client.test.ts` | multi-server routing, URI-tagged caching, subscribe ref-count, declared invalidation, isError rollback |
| `test/codegen.test.ts` | JSON Schema → TS, generated output compiles under `--strict`, paginated `generateFromClient` |
| `test/react.dom.test.tsx` | `useResource` loading→data, `useTool` invoke, `useTools` reactivity on `list_changed` (happy-dom) |

The in-memory mock server (`src/testing/mockServer.ts`, exported as `mcp-query/testing`)
is reusable for testing your own integrations.

## Design & background

- [**docs/api.md**](./docs/api.md) — **the full API reference: every feature with an example.**
- [**docs/backend.md**](./docs/backend.md) — using mcp-query **server-side**: multi-tenant
  context, interceptors, authorization + audit, resilience, metrics/health, the gateway
  re-server, per-principal sessions, and the multi-node L2 cache.

The conceptual analysis behind every choice lives in [`docs/`](./docs):

- [**docs/design.md**](./docs/design.md) — the Apollo reframe, the GraphQL↔MCP mapping, what's
  similar/different/new/harder/impossible, the MCP server conventions a client must respect, and
  **how `MCPClient` relates to the SDK's `Client`** (wraps, not replaces).
- [**docs/prior-art.md**](./docs/prior-art.md) — does this already exist? Lessons from TanStack
  Query, RTK Query, urql, Relay, gRPC, tRPC, Connect, and LSP.
- [**docs/sampling-and-non-agentic.md**](./docs/sampling-and-non-agentic.md) — why "non-agentic"
  ≠ "no LLM," and how to plug Chrome's built-in AI into the `sampling` handler.
- [**docs/human-in-the-loop.md**](./docs/human-in-the-loop.md) — the InteractionBroker: one
  approval queue for sampling + elicitation, with prompt-edit, response-redaction, trust
  policy, and an audit log.
- [**docs/inspector.md**](./docs/inspector.md) — Inspector-style debugging on mcp-query: raw
  JSON-RPC message log, manual (human-as-model) sampling, OAuth-debug recorder, and the
  `mcp-query-inspect` CLI + per-request timeouts.
- [**docs/webmcp.md**](./docs/webmcp.md) — *experimental* WebMCP bridge: expose backend tools
  to an in-browser agent (`bridgeToWebMCP`), and consume page tools (`webMcpToolServer`).

## The thesis

The right prior art for an MCP client is **not Apollo** — Apollo's defining feature
(normalized entity caching) is impossible on MCP's opaque, identity-free results.
The right models are:

| Borrowed from | What we took |
|---|---|
| **TanStack Query** | key→document cache, `staleTime`/`gcTime`, background refetch, cache-and-network |
| **RTK Query** | tag-based invalidation (`providesTags`/`invalidatesTags`) |
| **urql** | document cache by default, normalization strictly opt-in |
| **Language Server Protocol** | per-server lifecycle state machine, *dynamic registration* (`list_changed` ≙ `client/registerCapability`), N-server multiplexing, reconnection with capability re-negotiation, cancellation/progress |
| **Connect-Query** | typed RPC feeding a key-cache; codegen from schema (JSON Schema here) |

The MCP bonus: a chunk of the invalidation you'd hand-declare in RTK Query is
**emitted by the protocol itself** (`notifications/resources/updated`,
`notifications/.../list_changed`), so well-behaved servers invalidate your cache for free.

## Architecture (two layers)

```
                        ┌──────────────────────────── React bindings ───────────────────────────┐
                        │ useResource (useQuery)   useTool (useMutation)   useTools/usePrompt …   │
                        └───────────────▲───────────────────────▲──────────────────▲─────────────┘
                                        │ useSyncExternalStore    │                  │
  Layer 1: CACHE  ──────────────────────┴─────────────────────────┴──────────────────┴───────────
  MCPCache: key→entry, tag index, invalidateTags, onResourceUpdated/onListChanged,
            ref-counted subscribers (→ drives resources/subscribe), gc, optimistic patch
                                        ▲                         ▲
                       writes / invalidation                fires onResourceUpdated / onListChanged
                                        │                         │
  Layer 2: CONNECTIONS ─────────────────┴─────────────────────────┴──────────────────────────────
  MCPClient            multiplexer + router + host handlers (sampling/elicitation/roots)
   └─ ServerConnection (×N)  LSP-style state machine · dynamic registration · reconnect+reconcile
        └─ @modelcontextprotocol/sdk Client  ── stdio / Streamable HTTP / SSE
```

**The seam that matters:** the connection layer *drives* the cache layer.
- `notifications/resources/updated` → `cache.onResourceUpdated` → invalidates that exact URI tag.
- `notifications/<kind>/list_changed` → re-list → `cache.onListChanged` → `useTools()` re-renders.
- cache subscriber count (>0) → connection issues `resources/subscribe`; (==0) → unsubscribe + gc.
- reconnect → re-`initialize` (capabilities may differ) → reconcile → re-list → resubscribe observed entries.
- with a `sessionStore` (opt-in), reload/reconnect *resumes* the server-side Streamable HTTP
  session instead: the persisted `Mcp-Session-Id` skips `initialize`, a `ping` validates it,
  and a forgotten session falls back to fresh init ([docs/api.md](docs/api.md#session-resumption-streamable-http)).

## Usage

```tsx
import { MCPClient } from "@johnhenry/mcp-query";
import { MCPProvider, useResource, useTool, useTools } from "@johnhenry/mcp-query/react";
import { DevtoolsHub, MCPDevtools } from "@johnhenry/mcp-query/devtools";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const hub = new DevtoolsHub();

const client = new MCPClient({
  servers: {
    fs:     { transport: () => new StdioClientTransport({ command: "mcp-server-filesystem", args: ["/work"] }) },
    github: { transport: () => new StreamableHTTPClientTransport(new URL("https://mcp.example.com/github")) },
  },
  schemeMap: { file: "fs", github: "github" },
  handlers: {
    // Registering a handler is what advertises the capability to the server.
    elicitation: async (req) => showModal(req.message, req.requestedSchema), // → UI dialog
    roots:       () => [{ uri: "file:///work" }],
    // no `sampling` → not advertised → server never asks for an LLM. (non-agentic)
  },
  devtools: hub,
});
await client.connect();

function App() {
  return (
    <MCPProvider client={client}>
      <Issues />
      <MCPDevtools hub={hub} />
    </MCPProvider>
  );
}

function Issues() {
  // useQuery analog: read a resource, live-subscribe, auto-tagged by URI.
  const { data, isLoading } = useResource("github://repos/acme/app/issues", {
    fetchPolicy: "cache-and-network",
    subscribe: true,
  });

  // useMutation analog. Args validate against the tool's inputSchema (bind a form to it).
  // `invalidates` is the fallback for servers that DON'T emit resources/updated.
  const [createIssue, { isPending, isDestructive, inputSchema }] = useTool("github.create_issue", {
    invalidates: ["res:github:github://repos/acme/app/issues"],
    optimistic: (a) => [{
      key: { kind: "resource", server: "github", uri: "github://repos/acme/app/issues" },
      recipe: (prev: any) => ({ ...prev, contents: [...(prev?.contents ?? []), { title: a.title }] }),
    }],
  });

  const { tools } = useTools({ server: "github" }); // re-renders on tools/list_changed
  // ...render `inputSchema` as a form; gate a confirm dialog on `isDestructive`...
}
```

### Hooks and servers that aren't added yet

`client.listTools("x")` (and `listResources` / `listResourceTemplates` / `listPrompts`) **throw** an
`MCPError` for a server name that isn't configured: `unknown server "x"; configured: a, b` (every
method that takes a server name uses this same message). The capability hooks --
`useTools`, `useResourceList`, `usePromptList`, `useResourceTemplates` -- deliberately do the
opposite and return an **empty list** for a server that hasn't been added *yet*. Rationale: with
dynamic topology (`client.addServer()` after mount, lazy/deferred connections) a component often
renders before its server exists; a thrown error during render would crash the tree (or need an
error boundary) for what is a normal transient state, and the hook re-renders with real data the
moment the server is added and its lists load. The trade-off is that a typo'd server name in a hook
renders an empty list rather than an error -- if you want strictness, call `client.listTools(name)`
yourself (it throws), or check `client.connection(name)`.

## What's deliberately *not* here (and why)

- **Normalized caching.** No global object identity in MCP results → impossible to do
  automatically. The opt-in entity layer is `providesTags` + `entityTag()` only.
- **Static end-to-end types (tRPC-style).** MCP servers are polyglot/decoupled, so types
  come from **codegen against `tools/list` JSON Schemas** + `createTypedHooks()`, not TS
  inference.
Everything else discussed during design — codegen-typed hooks, sampling (incl. Chrome
built-in AI), polling, persistence, Suspense, dynamic topology, completion, ping — is now
implemented. See [docs/api.md](./docs/api.md) for every feature with an example.

## Feature coverage

Reads/queries (`useResource`, `useToolResult`, `queryTool`) · mutations (`useTool` with
optimistic + invalidation + progress + cancel) · capability lists + templates + prompts ·
`useServerState` · in-flight dedup · structural sharing · polling · Suspense · persistence ·
entity tags · structured output + annotation helpers · human-in-the-loop broker (sampling +
elicitation, trust policy, audit) · Chrome built-in AI sampling · codegen + typed hooks ·
ping · completion · dynamic add/remove server · read retry · devtools · raw JSON-RPC message
log · manual (human-as-model) sampling · OAuth-debug recorder · `mcp-query-inspect` CLI +
per-request timeouts · Skills over MCP (`listSkills` / `getSkill` / `readSkillFile` / `readSkillDirectory`,
SDK-verified, cached (L1 + shared `cacheStore`), `_meta` forwarded, opt-in broker approval, `useSkills` /
`useSkill`, TanStack `mcpqSkills*QueryOptions`; needs SDK >= 2.4.0, see [docs/api.md](./docs/api.md#skills-over-mcp-iomodelcontextprotocolskills-sep-2640)).
Full vitest suite green — run `npm test` for the current count.

## File map

| Path | Role |
|---|---|
| `core/cache.ts` | the centerpiece — keys, tags, invalidation, subscribers, gc, optimistic |
| `core/connection.ts` | LSP-style lifecycle, dynamic registration, reconnect + reconcile |
| `core/client.ts` | multiplexer + imperative read/call/list API |
| `core/router.ts` | resolve tool-name / resource-URI → server (namespacing, ambiguity) |
| `core/handlers.ts` | sampling/elicitation/roots; registration ⇒ capability advertisement |
| `core/keys.ts`, `core/tags.ts` | cache-key shapes + tag conventions |
| `react/*` | `useResource`, `useTool`, `useTools/useResourceList/usePrompt` |
| `devtools/*` | event protocol + three-pane panel |
