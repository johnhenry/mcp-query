---
title: "mcp-query"
---

**A reactive, cached, embeddable MCP client for ordinary (non-agentic) applications.**

MCP is almost always consumed by LLM agents. But an MCP server is just a typed,
introspectable capability surface — tools, resources, prompts — and there's no
reason a normal app can't use it as a universal data/capability layer. `mcp-query`
gives such apps the developer experience that Apollo/React-Query gave GraphQL/REST
apps: hooks, a cache, reactivity, optimistic updates, devtools — on top of the
official `@modelcontextprotocol/sdk`.

> Status: **working reference implementation.** `tsc --noEmit` is clean and the full
> vitest suite (180+ tests, plus an opt-in stress suite) passes, including end-to-end
> coverage of the cache,
> multiplexing, protocol-driven invalidation, dynamic registration, reconnect, the
> human-in-the-loop broker, and Inspector-style tooling (message log, manual sampling,
> auth recorder, CLI) — all driven against a *real* SDK server over an in-memory
> transport, with the codegen CLI verified against the live
> `@modelcontextprotocol/server-everything`. It is a reference/learning codebase, not a
> published package (no build/publish pipeline yet).

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit (covers src + examples)
npm test              # vitest run — 180+ tests
npm run test:stress   # opt-in chaos/load suite (STRESS_REAL=1 spawns real servers)
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

## Usage

```tsx
import { MCPClient } from "mcp-query";
import { MCPProvider, useResource, useTool, useTools } from "mcp-query/react";
import { DevtoolsHub, MCPDevtools } from "mcp-query/devtools";
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

## Tasks (call-now, fetch-later)

MCP 2025-11-25 adds **tasks**: a tool call that returns immediately with a pollable task
instead of blocking until the result. mcp-query maps the whole lifecycle onto the cache:

```tsx
// Imperative: start a task, observe it, await the result.
const handle = await client.callToolTask("simulate-research-query", { query: "…" });
handle.task();                        // latest Task snapshot (status, statusMessage, …)
const unsub = handle.subscribe((t) => console.log(t.status));
const result = await handle.result(); // resolves on completed; rejects on failed/cancelled
await handle.cancel();                // tasks/cancel

// Management: getTask / listTasks / getTaskResult / cancelTask (all per server).
// Capability probe: client.connections()[0].supports("tasks").

// React: useMutation-shaped start + live status, or observe any task by id.
const [start, { task, isPending, data, cancel }] = useToolTask("simulate-research-query");
const { task: watched } = useTask(taskId, { server: "everything" });
```

Status snapshots are ordinary cache entries (`{kind: "task"}` keys), fed by both the
SDK's polling stream **and** server `notifications/tasks/status` pushes — so `useTask`
renders live even for tasks started elsewhere. Tool-level `execution.taskSupport` is
honored (`"forbidden"` → a clear client-side error), and the interceptor chain + audit
wrap task *initiation*. `MockMCPServer` runs `task: true` tools asynchronously over the
SDK's `InMemoryTaskStore`, so the whole loop is testable offline. (The SDK marks tasks
*experimental*; cross-version server interop is still settling — see the findings doc.)

## Errors & eviction

- **`MCPError extends Error`** — rejections are real errors (`instanceof Error`, stacks,
  readable `String(e)`) carrying `kind` / `server` / `code` / `data`. Aborted calls
  classify as `kind: "cancelled"`.
- **Eviction** — `cache.remove(key)` evicts one entry (subscribers are notified);
  `cache.clear({ server?, partition? })` sweeps a server or a tenant partition;
  `gcTime` on `readResource`/`queryTool` opts bounds how long an unobserved entry
  lingers (writes arm the per-entry gc timer, so imperative reads don't accumulate).

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
optimistic + invalidation + progress + cancel) · **tasks** (`callToolTask` → `TaskHandle`,
`useTask`/`useToolTask`, `getTask`/`listTasks`/`getTaskResult`/`cancelTask`) · capability
lists + templates + prompts · `useServerState` · in-flight dedup · structural sharing ·
polling · Suspense · persistence · cache eviction (`remove`/`clear`, per-read `gcTime`) ·
entity tags · structured output + annotation helpers (typed results from `outputSchema`
via codegen) · human-in-the-loop broker (sampling + elicitation, trust policy, audit) ·
Chrome built-in AI sampling · codegen + typed hooks · ping · completion (incl. dependent
completions via `context.arguments`) · dynamic add/remove server · read retry · devtools ·
raw JSON-RPC message log · manual (human-as-model) sampling · OAuth-debug recorder ·
`mcp-query-inspect` CLI + per-request timeouts. **180+ tests, green** (plus the opt-in
stress suite: `npm run test:stress`).

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
