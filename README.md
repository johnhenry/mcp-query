# mcp-query

**A reactive, cached, embeddable MCP client for ordinary (non-agentic) applications.**

MCP is almost always consumed by LLM agents. But an MCP server is just a typed,
introspectable capability surface — tools, resources, prompts — and there's no
reason a normal app can't use it as a universal data/capability layer. `mcp-query`
gives such apps the developer experience that Apollo/React-Query gave GraphQL/REST
apps: hooks, a cache, reactivity, optimistic updates, devtools — on top of the
official `@modelcontextprotocol/sdk`.

> Status: **working reference implementation.** `tsc --noEmit` is clean and the full
> vitest suite (49 tests) passes, including end-to-end coverage of the cache,
> multiplexing, protocol-driven invalidation, dynamic registration, and reconnect —
> all driven against a *real* SDK server over an in-memory transport. The codegen CLI
> is verified against the live `@modelcontextprotocol/server-everything`. It is a
> reference/learning codebase, not a published package (no build/publish pipeline yet).

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run — 49 tests
npm run codegen -- --command npx --args "-y @modelcontextprotocol/server-everything" --out src/mcp.gen.ts
```

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

## What's deliberately *not* here (and why)

- **Normalized caching.** No global object identity in MCP results → impossible to do
  automatically. The opt-in entity layer is `providesTags` + `entityTag()` only.
- **Static end-to-end types (tRPC-style).** MCP servers are polyglot/decoupled, so types
  come from **codegen against `tools/list` JSON Schemas**, not TS inference. (A `codegen`
  step would emit typed `useTool<"github.create_issue">` overloads — not yet built.)
- **Sampling by default.** Non-agentic apps usually have no LLM; the handler is omitted,
  so the capability isn't advertised.

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
