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
import { MCPClient, InteractionBroker } from "@johnhenry/mcp-query";
import { StdioClientTransport } from "@johnhenry/mcp-query/transports";

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

`ConnectionConfig` per server: `{ transport: (ctx?) => Transport, versions?, versionNegotiation?,
inputRequired?, maxRetries?, retryDelay?, lazy?, idleMs?, sessionStore? }`.
The transport factory is re-invoked on reconnect.

### Protocol versions (MCP 2026-07-28)

Unconfigured connections speak the classic 2025-era protocol **byte-for-byte** —
no probe, no behavioral changes. Newer revisions are opt-in via the additive
`versions` preference list, client-wide or per connection (per-connection wins):

```ts
// Additive: probe via server/discover; speak 2026-07-28 where offered,
// fall back losslessly to the 2025 handshake otherwise.
const client = new MCPClient({ servers, versions: ["2026-07-28", "2025-11-25"] });

// Exclusive: a modern-only list PINS — a server that can't speak it fails the connect.
servers: { strict: { transport, versions: ["2026-07-28"] } }

// A legacy-only list is explicit v1 (same as absent, but constrains what
// the initialize handshake offers).
servers: { old: { transport, versions: ["2025-11-25"] } }
```

The mapping (`negotiationFromVersions()`, exported) is mechanical: a modern-only
list → the SDK's `{ mode: { pin } }` on the newest entry; a mixed list →
`{ mode: "auto" }`; a legacy-only list → `{ mode: "legacy" }` — and the list
itself becomes the SDK's `supportedProtocolVersions`, constraining exactly which
revisions either handshake offers. Unknown strings pass through to the SDK
verbatim, so future revisions need no library change. `versionNegotiation` (the
SDK's own option shape) remains the low-level escape hatch and takes precedence
over `versions` when both are set.

After connect, `client.connection(name).era` reports what was actually
negotiated (`"legacy" | "modern"`) — the request was a preference; the
connection is the truth. Era-dependent surfaces (the deprecated
`ping`/`setLogLevel`/roots-notify, the tasks extension (modern-era tasks need SDK >= 2.3.0; poll-only there), `subscriptions/listen`
vs `resources/subscribe`, SEP-2549 cache hints, per-request `CallContext.logLevel`)
switch on it automatically; app code using the hooks/broker/cache never branches.

CLI note: `mcp-query-inspect` and `mcp-query-codegen` keep the conservative v1 default and
expose `--negotiate auto|legacy|pin:<revision>` (spawn-per-invocation stdio tools
should not pay the probe by default).

### Session resumption (Streamable HTTP) — 2025-era only

Sessions were removed by the 2026-07-28 revision (SEP-2567); everything in this
section applies to legacy connections, where it keeps working through the
deprecation window (a modern connection never sets `transport.sessionId`, so a
configured store simply never writes).

Stateful Streamable HTTP servers key their state on `Mcp-Session-Id`. By default every
reload/reconnect re-`initialize`s into a *fresh* session, so the server forgets the client.
Opt in with a `sessionStore` and a factory that forwards the context:

```ts
import { webStorageSessionStore } from "@johnhenry/mcp-query";

servers: {
  api: {
    sessionStore: webStorageSessionStore("mcp-query:api"), // window.sessionStorage — same-tab lifetime
    transport: (ctx) => {
      const t = new StreamableHTTPClientTransport(url, { sessionId: ctx?.sessionId });
      if (ctx?.protocolVersion) t.setProtocolVersion(ctx.protocolVersion);
      return t;
    },
  },
}
```

After a fresh connect the store receives `{ sessionId, capabilities, protocolVersion, serverVersion }`.
On the next connect — page reload or mid-session reconnect — the stored id is passed to the
factory; the SDK sees `transport.sessionId` and skips `initialize`, so negotiated state is
restored from the record. The resumed session is *validated* with a `ping`: if the server has
forgotten it, the record is cleared and the connection falls back to a fresh `initialize`
(never an error). `ServerConnection.resumed` (and `useServerState().resumed`) reports which
path this connection took. `memorySessionStore()` gives resume-across-reconnects within one
process; sessionless transports (stdio, in-memory) never persist anything.

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
// per-caller cancel: rejects with AbortError; the shared request is cancelled only when all waiters abort
await client.queryTool("fs.search", { q: "todo" }, { signal: ac.signal });

// capability lists (kept live by list_changed)
client.listTools("fs"); client.listResources("fs");
client.listResourceTemplates("fs"); client.listPrompts("fs");
// no argument = union across every connected server, each entry tagged with its `server`:
client.listTools();                 // [{ name: "search", server: "fs", … }, …]
client.listTools("fz");             // throws MCPError: unknown server "fz"; configured: fs, git

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

## Interceptors (what runs through the chain)

`new MCPClient({ interceptors })` wraps these operations in an onion of `(op, next) => ...` functions.
`op.kind` is one of `read | call | query | list | prompt | skill`; `op.peer` is the server, `op.target`
what it acts on, `op.method` the MCP method where needed.

| Operation | Kind (`op.method`) | `op.target` |
|---|---|---|
| `readResource` | `read` | resource URI |
| `callTool`, `callToolTask` (initiation) | `call` | tool name |
| `queryTool` | `query` | tool name |
| `getPrompt` | `prompt` (`prompts/get`) | prompt name; `op.args` = its arguments |
| `listSkills` / `getSkill` / `readSkillFile` | `skill` (`skills/list`, `skills/get`, `skills/read`) | `skills` / skill URI / file ref or URI |
| the catalogs behind `listTools` / `listResources` / `listResourceTemplates` / `listPrompts`, and `discover()` | `list` (`tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`) | `tools` / `resources` / `resourceTemplates` / `prompts` |

Not wrapped (they still bypass the chain): `complete`, `ping`, `setLogLevel`, resource
subscribe/unsubscribe, task polling/cancel (`getTask`, `listTasks`, `getTaskResult`, `cancelTask`),
and `notifyRootsChanged`.

```ts
import { authorize, listFilter } from "@johnhenry/mcp-query/server";

const client = new MCPClient({
  servers,
  interceptors: [
    authorize((req) => (req.kind === "prompt" && req.target === "internal" ? "deny" : "allow")),
    listFilter({ keep: (_server, kind, name) => !(kind === "tool" && name.startsWith("admin_")) }),
  ],
  onCall: (e) => audit(e), // e.kind is any of the kinds above
});
client.listTools("fs");                      // still synchronous: the chain-vetted catalog
await client.discover("tools", "fs", { context: { meta: { principal } } }); // same chain, per caller
await client.getPrompt("greet", { who: "ann" }, "fs");                       // kind: "prompt"
```

### Lists: the chain runs where the catalog is fetched

`listTools()`, `listResources()`, `listResourceTemplates()` and `listPrompts()` are synchronous reads
of a catalog the connection already fetched, and they stay that way. With interceptors configured,
each catalog is run through the chain (`kind: "list"`, no caller context) **when it is fetched or
re-fetched** (connect, `list_changed`), before subscribers are told, and the accessors return what
the chain answered. So an interceptor can:

- **filter or annotate** the items: return a new array (`listFilter({ keep, annotate })` from
  `@johnhenry/mcp-query/server` does this with the same `(server, kind, name)` callbacks as the
  gateway's `filter`/`annotate`; copy an item before changing it, the chain hands you the live objects);
- **hide the whole catalog** by throwing (`AuthorizationError`): the view is empty and the denial is
  audited (`onCall`, `outcome: "denied"`). Until a catalog has been through the chain the accessors
  return `[]`, never an unvetted list;
- or do nothing: an answer that is not an array means "no opinion" and the catalog shows as fetched.

Only the *view* is filtered: routing (`callTool("s.name")`, `readResource`) still resolves against the
raw catalog, so a hidden tool is still refused by policy at call time, not "unknown".

Because that view has no caller, per-principal decisions use the async variant, which runs the same
chain now with a context:

```ts
const tools = await client.discover("tools", "fs", { context: { meta: { principal: "mcp-app:ui://x" } } });
await client.scope({ meta: { principal } }).discover("prompts");   // bound context
```

`discover(catalog, server?)` rejects when the list is denied; with no `server` it returns the union
(each item tagged `server`) and leaves out servers whose list is denied.

Notes for existing interceptors: `authorize()` treats an `"approve"` verdict on a `list` as allow (a
catalog view is not an action and a human wait would stall `connect()`); `rateLimit` and
`circuitBreaker` skip `list` operations (they are local); an `authorize` policy that denies every
kind it does not recognise will now also deny `list`, `prompt` and `skill`.

See [backend.md](./backend.md#interceptor-chain--the-seam) for authorization, resilience and audit.

## React hooks

```tsx
import {
  MCPProvider, useResource, useTool, useToolResult,
  useTools, useResourceList, usePromptList, useResourceTemplates, usePrompt,
  useServerState, useInteractions, useAuditLog,
} from "@johnhenry/mcp-query/react";

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

## Skills over MCP (`io.modelcontextprotocol/skills`, SEP-2640)

Skills are folders of instructions a server publishes (`SKILL.md` plus reference files). The
client lists them, fetches one, and reads its files **with the SDK's verification**: every file
is checked against the skill entry's manifest (size, sha256 digest, and for `SKILL.md` the
frontmatter) before you see its bytes. mcp-query adds caching, invalidation, hooks and the
server tag; it does not re-implement any check.

Needs `@modelcontextprotocol/client` **>= 2.4.0** (it provides `@modelcontextprotocol/client/ext/skills`).
The package's peer range stays `^2.0.0`: on an older SDK nothing else changes, and the skills
calls reject with an `MCPError` that names the minimum version.

```ts
client.connection("docs")!.supports("skills");          // server advertised the extension (and resources)

const all = await client.listSkills();                  // union across skills-capable servers, each tagged `server`
const mine = await client.listSkills("docs");           // one server; throws if it has no skills extension
const skill = await client.getSkill("skill://git-commit/SKILL.md", "docs");   // skills/get, listed or not

const md = await client.readSkillFile(skill);                         // SKILL.md: { text, body, frontmatter, verified }
const ref = await client.readSkillFile(skill, "references/STYLE.md"); // relative to the skill root, or an absolute URI
```

- **Verification.** A failed check throws an `MCPError` (`kind: "protocol"`, `server`, `uri`) whose
  `data.skillVerification` is `{ reason: "unlisted" | "size" | "digest" | "frontmatter", uri, differences }`;
  `skillVerificationReason(err)` returns the reason. A file the manifest does not list is rejected
  before any request. Bytes are never returned unverified, except for `"dynamic"` skills
  (`resources: "dynamic"`), whose files come back with `verified: false` and are never cached.
- **Origin.** Every `Skill` and `SkillFile` carries the `server` that published it. Skill content is
  instructions to a model: treat it like a tool description and keep the origin attached.
- **Caching.** `skills/list` and `skills/get` honor the server's `ttlMs` / `cacheScope` (SEP-2549)
  like every other cacheable result, keyed per server and per `client.scope({ partition })`
  (`scope()` has `listSkills` / `getSkill` / `readSkillFile`). Verified file bytes are cached under
  their manifest **digest**, so a changed manifest can never serve old bytes. `{ force: true }`
  bypasses the cache; `{ staleTime }` overrides the freshness window.
- **Invalidation.** `notifications/resources/list_changed` (legacy push or the modern
  `subscriptions/listen` stream) marks the catalog stale (tag `skillsTag(server)`); the next
  `listSkills` re-fetches and the hooks below do it for you.
- **Union errors.** `listSkills()` with no server skips a server whose listing fails and reports it to
  `opts.onError(server, error)`.
- **Bundlers.** The default loader imports the SDK subpath at runtime so older SDKs and bundlers never
  need it. A bundled browser app passes `skillsSdk: () => import("@modelcontextprotocol/client/ext/skills")`
  in the `MCPClient` config.
- **Not yet here:** routing "load this skill" through the `InteractionBroker` for approval (bound to the
  manifest digests), `skillsQueryOptions` in `@johnhenry/mcp-query-tanstack`, mcp-gate pass-through.

```tsx
import { useSkills, useSkill } from "@johnhenry/mcp-query/react";

const { skills, isLoading, error, refetch } = useSkills("docs");   // omit the server for the union
const { skill, readFile } = useSkill("skill://git-commit/SKILL.md", { server: "docs" });
const file = await readFile("references/STYLE.md");                // verified, fetched on demand
```

Testing: `MockMCPServer({ skills: [{ name, description, body?, files?, dynamic?, tamper? }] })` serves
spec-shaped skills (sha256 manifest, `skills/list`, `skills/get`, files over `resources/read`);
`tamper: "digest" | "size" | "frontmatter"` makes the entry lie so verification has something to
reject. `skillsCache: { ttlMs, cacheScope }` stamps the cache fields; `server.skillLog` records traffic.

## Cache

```ts
import { resourceTag, capsTag, serverTag, entityTag } from "@johnhenry/mcp-query";

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
import { persistCache } from "@johnhenry/mcp-query";

const stop = persistCache(client.cache, window.localStorage, { key: "myapp", debounce: 250 });
// or manually: const snap = client.cache.dehydrate(); newCache.hydrate(snap);
```

## Annotations & structured output

```ts
import { isReadOnly, isDestructive, isIdempotent, structuredContent, contentAnnotations, isToolError } from "@johnhenry/mcp-query";

if (isDestructive(tool)) confirmFirst();
const data = structuredContent<{ total: number }>(result); // the structuredContent field
const { audience, priority } = contentAnnotations(result.content[0]);
if (isToolError(result)) showToolError(result);
```

## Human-in-the-loop

```tsx
import { InteractionBroker, chromeBuiltinAISampling } from "@johnhenry/mcp-query";
import { useInteractions, useAuditLog } from "@johnhenry/mcp-query/react";

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
import { createTypedHooks } from "@johnhenry/mcp-query/react";
import type { GeneratedToolMap } from "./mcp.gen";

const { useTool, useToolResult } = createTypedHooks<GeneratedToolMap>();
const [createIssue] = useTool("github.create_issue"); // args + result fully typed
```

## Transports & auth

Any MCP SDK transport works — the per-server `transport` is a factory. Auth is configured
on the transport itself (OAuth 2.1 for Streamable HTTP), so no special client API is
needed:

```ts
import { StreamableHTTPClientTransport } from "@johnhenry/mcp-query/transports";

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
import { DevtoolsHub } from "@johnhenry/mcp-query/devtools";
import { MCPDevtools } from "@johnhenry/mcp-query/devtools";

const hub = new DevtoolsHub();
const client = new MCPClient({ servers, devtools: hub });
// …
<MCPDevtools hub={hub} />  // server states, live capability registry, cache+tags,
                           // event log (incl. server logs), pending interactions + audit
```
