# API reference — every feature, with an example

A complete catalog of the public surface. Conceptual background lives in
[design.md](./design.md), [prior-art.md](./prior-art.md),
[human-in-the-loop.md](./human-in-the-loop.md), and
[sampling-and-non-agentic.md](./sampling-and-non-agentic.md). Runnable demos are in
[`examples/`](../examples).

- [Client construction](#client-construction)
- [Imperative client API](#imperative-client-api)
- [React hooks](#react-hooks)
- [Cache: tags, invalidation, optimistic, persistence](#cache)
- [Annotations & structured output](#annotations--structured-output)
- [Human-in-the-loop](#human-in-the-loop)
- [Codegen & typed hooks](#codegen--typed-hooks)
- [Transports & auth](#transports--auth)
- [Devtools](#devtools)

---

## Client construction

```ts
import { MCPClient, InteractionBroker } from "mcp-query";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new MCPClient({
  servers: {
    fs: { transport: () => new StdioClientTransport({ command: "mcp-server-filesystem", args: ["/work"] }) },
  },
  schemeMap: { file: "fs" },        // route file:// URIs to the "fs" server
  handlers: { roots: () => [{ uri: "file:///work" }] },
  interactions: new InteractionBroker(/* … */), // optional HITL broker
  retry: 2,                         // retry reads up to 2× on failure
  clientInfo: { name: "my-app", version: "1.2.3", title: "My App" }, // identity sent at initialize
  defaultRequestOptions: { timeout: 30_000 }, // client-wide default, overridable per-call
  // cache, devtools — see below
});
```

`clientInfo` is what servers see during `initialize` (the SDK's `Implementation`); it defaults
to `{ name: "mcp-query", version: … }`. `defaultRequestOptions` sets client-wide
`timeout`/`resetTimeoutOnProgress`/`maxTotalTimeout`, merged *under* any per-call
`requestOptions`. (The SDK also supports `title`/`websiteUrl`/`icons` on `Implementation` and
`enforceStrictCapabilities` — only `title` is surfaced today; the rest are a documented future
option.)

```ts
await client.connect();             // connects all servers; failures are isolated
// …
await client.close();
```

`ConnectionConfig` per server: `{ transport: () => Transport, maxRetries?, retryDelay? }`.
The transport factory is re-invoked on reconnect.

## Imperative client API

```ts
// reads (cached, deduped, URI-tagged)
await client.readResource("file:///a", { subscribe: true, staleTime: 30_000 });

// mutations
await client.callTool("fs.write_file", { path: "x", contents: "y" }, {
  invalidates: ["res:fs:file:///a"],
  optimistic: (args) => [/* CachePatch[] */],
  signal,
  onProgress: (p) => console.log(p.progress, p.total),
});

// read-only tool as a cached query
await client.queryTool("fs.search", { q: "todo" }, { providesTags: (r) => [/* … */] });

// capability lists (kept live by list_changed)
client.listTools("fs"); client.listResources("fs");
client.listResourceTemplates("fs"); client.listPrompts("fs");

// server-provided prompt template
await client.getPrompt("summarize", { text: "…" }, "fs");

// argument autocompletion (completion/complete)
await client.complete({ type: "ref/prompt", name: "summarize" }, { name: "tone", value: "" }, "fs");

// lifecycle & ops
client.serverState("fs");           // "ready" | "reconnecting" | "degraded" | …
await client.ping("fs");            // liveness
await client.setLogLevel("fs", "debug");
await client.notifyRootsChanged();  // fire roots/list_changed to all servers

// dynamic topology
await client.addServer("github", { transport: () => httpTransport });
await client.removeServer("github");
```

## Server-side / multi-tenant (`CallContext` + `scope`)

For backend use, one shared client can serve many principals: `partition` isolates cache
entries per tenant/session (no cross-tenant reads), and `meta` is forwarded to the server
as the request's `_meta` (e.g. a user id). Per-call, or bound via `scope()`:

```ts
// per call
await client.readResource(uri, { context: { partition: tenantId, meta: { userId } } });

// or bind a per-request view
const tenant = client.scope({ partition: tenantId, meta: { userId } });
await tenant.readResource(uri);
await tenant.callTool("svc.do_thing", args);   // partitioned cache + _meta propagated
```

`partition` namespaces cache *storage* (keys are byte-identical to before when omitted);
tag-based and protocol invalidation still fan out across partitions (safe — refetch, not
leak). Note: true per-user *auth* on a shared connection isn't an MCP concept — for that,
instantiate one `MCPClient` per principal; `context` covers cache isolation + `_meta`.

## React hooks

```tsx
import {
  MCPProvider, useResource, useTool, useToolResult,
  useTools, useResourceList, usePromptList, useResourceTemplates, usePrompt,
  useServerState, useInteractions, useAuditLog,
} from "mcp-query/react";

<MCPProvider client={client}>…</MCPProvider>
```

**useResource** — useQuery analog:

```tsx
const { data, error, isLoading, isStale, refetch } = useResource("file:///a", {
  server: "fs",                      // optional; else routed by URI
  fetchPolicy: "cache-and-network",  // | "cache-first" | "network-only"
  staleTime: 30_000,
  subscribe: true,                   // live updates via resources/subscribe
  refetchInterval: 5_000,            // polling fallback when subscribe is unsupported
  providesTags: (r) => [/* entity tags */],
  select: (raw) => raw,              // transform/narrow
  suspense: true,                    // throw to a <Suspense> boundary
  skip: false,
});
```

**useTool** — useMutation analog:

```tsx
const [createIssue, { isPending, error, progress, inputSchema, outputSchema, isDestructive, cancel, reset }] =
  useTool<{ title: string }>("github.create_issue", {
    invalidates: (args, result) => ["res:github:github://issues"],
    optimistic: (args) => [/* CachePatch[] */],
  });
await createIssue({ title: "hi" });
// bind a form to `inputSchema`; gate a confirm dialog on `isDestructive`; show `progress`.
```

**useToolResult** — query-shaped read of a read-only tool (same options as useResource):

```tsx
const { data, isLoading } = useToolResult("github.search_issues", { q: "is:open" }, { server: "github" });
```

**Capability lists** (reactive to `list_changed`):

```tsx
const { tools } = useTools({ server: "github" });
const { resources } = useResourceList({ server: "github" });
const { prompts } = usePromptList({ server: "github" });
const { templates } = useResourceTemplates({ server: "github" });
const { messages } = usePrompt("summarize", { text }, "github");
```

**useServerState** — reactive connection lifecycle:

```tsx
const { state, isReady, supports } = useServerState("github");
// state: "idle"|"connecting"|"initializing"|"ready"|"degraded"|"reconnecting"|"failed"|"closed"
```

**useInteractions / useAuditLog** — see [Human-in-the-loop](#human-in-the-loop).

## Cache

```ts
import { resourceTag, capsTag, serverTag, entityTag } from "mcp-query";

// invalidation (RTK-Query style)
client.cache.invalidateTags([resourceTag("github", "github://issues")]);
client.cache.invalidateTags([entityTag("Issue", 1234)]); // entity-layer

// optimistic update + rollback
const rollback = client.cache.patch([
  { key: { kind: "resource", server: "github", uri: "github://issues" }, recipe: (p) => /* next */ p },
]);
rollback();
```

- **Structural sharing**: a re-write with deep-equal data keeps the old reference and
  skips the re-render (`structuralEqual` is exported).
- **In-flight de-dup**: concurrent reads of the same key share one request; the request
  is aborted when its last observer unsubscribes.

**Persistence / hydration** (offline, SSR):

```ts
import { persistCache } from "mcp-query";

const stop = persistCache(client.cache, window.localStorage, { key: "myapp", debounce: 250 });
// or manually: const snap = client.cache.dehydrate(); newCache.hydrate(snap);
```

## Annotations & structured output

```ts
import { isReadOnly, isDestructive, isIdempotent, structuredContent, contentAnnotations, isToolError } from "mcp-query";

if (isDestructive(tool)) confirmFirst();
const data = structuredContent<{ total: number }>(result); // the structuredContent field
const { audience, priority } = contentAnnotations(result.content[0]);
if (isToolError(result)) showToolError(result);
```

## Human-in-the-loop

```tsx
import { InteractionBroker, chromeBuiltinAISampling } from "mcp-query";
import { useInteractions, useAuditLog } from "mcp-query/react";

const broker = new InteractionBroker({
  model: chromeBuiltinAISampling(),
  policy: ({ server }) => (server === "fs" ? "allow" : "ask"), // "allow"|"deny"|"ask"
  reviewResponses: true,                                       // redact model output
});
const client = new MCPClient({ servers, interactions: broker });

function ApprovalCenter() {
  const { interactions, resolve } = useInteractions();
  const audit = useAuditLog();
  return interactions.map((i) => (
    <Dialog key={i.id}>
      {i.server} wants {i.type} ({i.phase})
      <button onClick={() => resolve(i.id, { action: "approve", editedMessages, editedResult, content })}>ok</button>
      <button onClick={() => resolve(i.id, { action: "deny" })}>no</button>
    </Dialog>
  ));
}
```

Full details: [human-in-the-loop.md](./human-in-the-loop.md). Chrome built-in AI
sampling: [sampling-and-non-agentic.md](./sampling-and-non-agentic.md).

## Codegen & typed hooks

```bash
npm run codegen -- --command npx --args "-y @modelcontextprotocol/server-everything" --out src/mcp.gen.ts
```

Emits `GeneratedToolMap`, `ToolName`, `ToolArgs`/`ToolResult`, plus `GeneratedPromptMap`
and `ResourceTemplateUri`. Feed the tool map to the typed hook factory:

```tsx
import { createTypedHooks } from "mcp-query/react";
import type { GeneratedToolMap } from "./mcp.gen";

const { useTool, useToolResult } = createTypedHooks<GeneratedToolMap>();
const [createIssue] = useTool("github.create_issue"); // args + result fully typed
```

## Transports & auth

Any MCP SDK transport works — the per-server `transport` is a factory. Auth is configured
on the transport itself (OAuth 2.1 for Streamable HTTP), so no special client API is
needed:

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new MCPClient({
  servers: {
    github: {
      transport: () =>
        new StreamableHTTPClientTransport(new URL("https://mcp.example.com"), { authProvider: myOAuthProvider }),
    },
  },
});
```

## Devtools

```tsx
import { DevtoolsHub } from "mcp-query/devtools";
import { MCPDevtools } from "mcp-query/devtools";

const hub = new DevtoolsHub();
const client = new MCPClient({ servers, devtools: hub });
// …
<MCPDevtools hub={hub} />  // server states, live capability registry, cache+tags,
                           // event log (incl. server logs), pending interactions + audit
```
