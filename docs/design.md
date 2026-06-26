# Why mcp-query looks the way it does

This is the conceptual analysis the library is built on: what an "Apollo Client for
MCP" should actually be, and why the parts that look like Apollo are borrowed from
elsewhere.

## The reframe

Apollo Client's real job isn't "talk to GraphQL" — it's to be a **declarative,
cached, reactive data layer** between a UI and a remote capability surface, hiding the
network. GraphQL is just the protocol it happens to speak.

MCP is *also* a typed, introspectable capability surface — tools, resources, prompts.
Today nearly every MCP client is an LLM agent host, but nothing in the protocol
requires an LLM. So an "Apollo for MCP" treats MCP servers as a **universal
client-side connector to capabilities and data** — ODBC for tools-and-resources — and
gives ordinary apps the same ergonomics: hooks, a cache, reactivity, optimistic
updates, devtools.

## The mapping that drives everything

| Apollo / GraphQL | MCP |
|---|---|
| Query (read, addressable) | **Resource read** (`resources/read`, URI-keyed) |
| Mutation (write, side-effecting) | **Tool call** (`tools/call`) |
| Subscription | **Resource subscription** (`resources/subscribe` + `notifications/resources/updated`) |
| Schema introspection | **Capability listing** (`tools/list`, `resources/list`, `prompts/list`) + `initialize` |
| Schema changes (rare, build-time) | `listChanged` notifications (runtime, common) |
| ApolloLink chain | Transport (stdio / Streamable HTTP) + middleware |
| Federation / subgraphs | **Multiple servers** (the normal case, not the exotic one) |
| — | **Prompts** (server-provided templated message flows) |
| — | **Server→client calls**: sampling, elicitation, roots |

## What's similar, different, new, harder, impossible

**Similar to Apollo**
- Two error channels: JSON-RPC protocol errors vs a tool result with `isError: true` —
  the exact analog of GraphQL network errors vs `errors[]`. Surface them distinctly.
- Introspection-driven tooling: `tools/list` + JSON Schema is to MCP what the SDL is to
  GraphQL — you can codegen types from it.
- Cursor pagination on the `*/list` methods → a clean `fetchMore` analog.
- A composable middleware chain (auth, retry, logging) — basically ApolloLink.

**Different**
- **Multi-server is the default.** You aggregate N independent capability surfaces,
  each with its own lifecycle, auth, and capability set. Namespacing and partial
  availability are first-class — closer to a federation gateway living on the client.
- **The schema is dynamic.** GraphQL schemas change at deploy time; MCP surfaces change
  at runtime via `listChanged`. Cached capability lists must invalidate reactively.
- **Results are mostly opaque.** Content blocks (text/image/blob) or, in newer specs,
  `structuredContent` with an optional `outputSchema`. There is **no global object
  identity** (`id` + `__typename`).
- **The protocol is bidirectional.** Servers call back into the client.

**New (no Apollo analog)**
- **Server-initiated requests.** *Elicitation* (server requests structured user input
  mid-call → a UI dialog) is genuinely new. *Sampling* lets a server borrow an LLM.
  *Roots* scope what the server may touch. See [sampling-and-non-agentic.md](./sampling-and-non-agentic.md).
- **Prompts as a primitive** — server-authored parameterized message templates.
- **Behavioral hints as policy inputs.** `readOnlyHint` → safe to cache/auto-call;
  `idempotentHint` → safe to retry; `destructiveHint` → require UI confirmation. Apollo
  has no protocol-level "this mutation is destructive" signal.

**Easier than Apollo**
- Real-time without designing a subprotocol: `resources/subscribe` is built in.
- Thinner transport (JSON-RPC over stdio/Streamable HTTP).
- Standardized auth (OAuth 2.1 flow for the HTTP transport).

**Harder**
- **Cache invalidation.** MCP gives no automatic signal about which resources a tool
  affected unless the server emits `resources/updated`. So invalidation is either
  notification-driven or **manually declared**. This is the single biggest gap.
- **Type safety** is always partial — the surface is runtime-mutable.
- **Optimistic updates** mean guessing an opaque result shape (clean only with an
  `outputSchema`).

**Effectively impossible today**
- **Normalized caching — Apollo's crown jewel.** It needs stable global object identity
  and a typed object graph; MCP has neither. The best you can build is a two-tier cache:
  a URI-keyed document cache (natural) plus an **opt-in, app-declared entity layer**.
  You cannot get Apollo's automatic normalization for free.

## MCP server conventions a client must respect

- **Capability negotiation** — honor `protocolVersion` and the negotiated capability set
  from `initialize`; gate features and degrade gracefully.
- **`listChanged`** — treat capability lists as live data, re-list and re-render.
- **Resource templates** (URI Templates) — the "parameterized query" primitive.
- **Cursor pagination** — thread the server's `nextCursor`, don't synthesize page numbers.
- **Content + tool annotations** — flow `audience`/`priority` and the read-only/
  destructive/idempotent hints into cache/retry/confirmation policy.
- **Two error layers** — never collapse JSON-RPC errors and `isError` tool results.
- **Progress + cancellation** — surface `progressToken`, support request cancellation.
- **Transport/session semantics** — Streamable HTTP has sessions and resumability that
  stdio doesn't; plan reconnection/replay accordingly.
- **Security posture** — a non-agentic client worries less about prompt injection but
  more about deterministic guardrails: confirm on `destructiveHint`, root-scoping, don't
  auto-invoke non-`readOnly` tools.

## The resulting architecture (two layers)

The honest positioning: **"Apollo's DX minus automatic normalization, plus a
bidirectional, multi-server, runtime-dynamic capability layer."** The two pieces of
design that earn their keep are the **invalidation strategy** (notification-driven where
possible, declarative where not) and the **multi-server aggregation/namespacing model**.

That splits cleanly into:

- **Layer 1 — cache** (`src/core/cache.ts`): key→document store, tag invalidation,
  protocol-driven invalidation, ref-counted subscribers, gc, optimistic patch.
- **Layer 2 — connections** (`src/core/connection.ts`, `client.ts`, `router.ts`):
  per-server lifecycle, dynamic registration, multiplexing, reconnect-with-reconciliation.

The seam: the connection layer *drives* the cache layer (`resources/updated` →
invalidate; `list_changed` → re-list; subscriber count → `resources/subscribe`;
reconnect → reconcile). See [prior-art.md](./prior-art.md) for where each idea was
borrowed from.
