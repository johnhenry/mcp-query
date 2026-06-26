# Prior art & where each idea was borrowed from

Does an "Apollo for MCP" already exist, and what can be learned from REST/gRPC/tRPC/
GraphQL clients? Short version: the plumbing exists everywhere, the agent-adapter layer
is crowded, but the **reactive cached embeddable data-layer client for non-agentic
apps** was an unfilled niche as of early 2026 — and the best models are TanStack Query,
RTK Query, and the Language Server Protocol, *not* Apollo.

## Does it already exist?

MCP clients sort into three tiers; this library lives in the gap between them.

- **Tier 1 — low-level SDKs (mature).** The official SDKs (`@modelcontextprotocol/sdk`,
  Python, Go, Rust, C#, …) give you a `Client`, transports, JSON-RPC plumbing. No cache,
  no reactivity, no hooks. "Raw fetch," not Apollo.
- **Tier 2 — agent adapters (crowded).** Vercel AI SDK's `experimental_createMCPClient`,
  LangChain's `langchain-mcp-adapters`, `mcp-use`, FastMCP's client. Their job is the
  *opposite*: flatten MCP tools into LLM tool-call definitions. They assume a model is in
  the loop.
- **Tier 3 — registries / gateways / codegen (emerging).** Smithery, Composio, mcp.run,
  Docker's MCP toolkit, various gateways solve **multi-server aggregation**. `mcporter`
  is real prior art for the *codegen-typed-client* angle. Infrastructure/CLI, not an
  in-app reactive data layer.

Missing: `useResource(uri)` / `useTool(name)` backed by a cache that re-renders on
`listChanged`/`updated`, with declarative invalidation and schema-driven forms.

## The key reframe: TanStack Query, not Apollo

Apollo's defining feature — normalized entity caching — is exactly what MCP can't
support. The clients that *deliberately don't normalize* are the right templates.

| Source | What was taken |
|---|---|
| **TanStack Query / SWR** | key→document cache with staleness + background refetch; arbitrary keys (URI / `tool+args`), not entity IDs. **The starting point.** |
| **RTK Query** | tag-based invalidation (`provideTags`/`invalidateTags`) — the cleanest model for "the protocol won't tell me what changed, so I declare relationships." mcp-query's tags are this, with `resources/updated`/`list_changed` driving much of it automatically. |
| **urql (+ Graphcache)** | tiered cache: document cache by default, normalization opt-in. Validates the two-tier architecture. |
| **Relay** | cautionary tale: normalization only works because Relay *forces* server conventions (global `Node` IDs, Connection spec). MCP mandates none → confirms you can't get free normalization. Its cursor spec mirrors MCP pagination. |
| **Connect-Query (Buf)** | proof that typed RPC + a key-cache compose cleanly; blueprint for "JSON-Schema codegen → typed hooks → cache." |

## Lessons from the RPC ecosystems

| System | Steal this | Doesn't transfer |
|---|---|---|
| **gRPC** | IDL→codegen; spec'd streaming; deadlines/cancellation; interceptors (middleware); reflection (≈ `tools/list`). | Browser needs a proxy; rigid protobuf IDL vs per-tool JSON Schema. |
| **tRPC** | the DX goal: typed procedures, autocomplete, query/mutation tagging (≈ `readOnlyHint`), TanStack Query integration. | its no-codegen magic needs client+server in one TS codebase; MCP servers are polyglot/decoupled, so you reach the same DX via **codegen from JSON Schema**. |
| **OpenAPI/Swagger** | schema-as-contract → generated typed clients. | static; MCP surfaces mutate at runtime. |
| **GraphQL Mesh / Apollo Router** | wrapping many heterogeneous backends behind one client — the multi-server problem, solved once. | — |
| **Falcor / OData** | "paths/URIs as cache keys"; standardized metadata/introspection. | niche/dated. |

## The two deepest analogs (most people miss these)

**Language Server Protocol — the protocol twin.** MCP is openly modeled on LSP:
JSON-RPC, `initialize` capability negotiation, bidirectional requests, notifications,
progress, cancellation, and **dynamic capability registration**
(`client/registerCapability` ≈ `listChanged`). Crucially, **an LSP client is already a
non-agentic protocol client embedded in an app** — the editor. Editors solved years ago
exactly what this library needs: multiplexing N servers, binding capabilities to UI,
dynamic feature (de)registration, cancellation on rapid input, progress reporting. The
lifecycle/multiplexing/reconnect patterns in `connection.ts` come straight from how
editors manage language servers.

**Capability-passing RPC (Cap'n Proto / CapTP).** MCP's server→client calls (sampling,
elicitation, roots) are capability callbacks; the object-capability RPC world is the
right mental model for designing those handlers.

## Synthesis — what mcp-query actually is

> **"TanStack Query for MCP, with an LSP-client lifecycle and an RTK-Query invalidation
> model."**

- Cache & hooks: TanStack Query's mental model (not Apollo's). Key = URI or `tool(args)`.
- Invalidation: RTK Query tags; auto-derived from `resources/updated` where servers
  emit it, declared where they don't.
- Normalization: opt-in, urql-style — never promised.
- Typing/codegen: OpenAPI/Connect-style codegen from JSON Schema.
- Lifecycle, multiplexing, bidirectional handlers, reconnect: LSP-client patterns.

The reason it didn't already exist is that everyone building MCP clients so far has been
building Tier-2 agent adapters, not app data layers.
