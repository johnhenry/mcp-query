# mcp-query as a backend library

mcp-query's core is framework-agnostic and ships as a real built package, so it works
server-side as the resilient, cached, governed layer over your MCP upstreams. Server
features live in optional subpath exports (`mcp-query/server`, `/metrics`, `/session`,
`/redis`) so the core stays small.

```bash
npm i @johnhenry/mcp-query @modelcontextprotocol/client
```

The shape it fits: a **long-lived aggregator / server-side agent runtime** (BFF, gateway,
worker) over a fixed/moderate set of upstreams. For per-user isolation, give each principal
its own client (see SessionManager) rather than sharing one across tenants.

## Multi-tenant calls — `CallContext` + `scope`

```ts
const tenant = client.scope({ partition: tenantId, meta: { principal: userId } });
await tenant.readResource(uri);          // cache isolated per tenant
await tenant.callTool("svc.do", args);   // principal forwarded to the server as _meta
```

`partition` namespaces cache *storage* (no cross-tenant reads); `meta` rides along as the
request `_meta`. True per-user *auth* on a shared connection isn't an MCP concept — use one
client per principal for that.

## Interceptor chain — the seam

Every operation in the table below runs through a Koa-style onion. Interceptors short-circuit, mutate
(args/context), or observe (timing/errors):

```ts
const client = new MCPClient({ servers, interceptors: [authz, breaker, limiter, metrics.interceptor()] });
```

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

`OperationKind` is `"read" | "call" | "query" | "list" | "prompt" | "skill"` (the last three were added
in #90). An interceptor that handles only the original kinds keeps working: it passes the others to
`next(op)`. `op.method` names the MCP method where the kind alone is ambiguous.

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

## Authorization + audit (`mcp-query/server`)

```ts
import { authorize, denyDestructiveUnless } from "@johnhenry/mcp-query/server";

interceptors: [authorize(({ context, destructive }) =>
  context?.meta?.role === "admin" || !destructive ? "allow" : "deny")]
// or: authorize(denyDestructiveUnless((req) => req.context?.meta?.confirmed === true))

new MCPClient({ servers, interceptors, onCall: (e) => auditDb.write(e) }); // durable audit of every op
```

`authorize` finally *enforces* `destructiveHint`; `onCall` records `{ at, ms, server, kind,
target, principal, outcome }` (outcome ∈ ok | denied | error).

## Resilience (`mcp-query/server`)

```ts
import { circuitBreaker, rateLimit } from "@johnhenry/mcp-query/server";
interceptors: [
  circuitBreaker({ threshold: 5, cooldownMs: 10_000 }).interceptor,
  rateLimit({ concurrency: 8 }).interceptor,
]
```

Per-key (default: per-server) open/half-open + a concurrency cap with backpressure. Pass
`keyFn: (op) => \`${op.server}::${op.context?.partition ?? ""}\`` to isolate state per tenant
instead of sharing one budget/breaker across everyone hitting the same server. Both return
`{ interceptor, dropServer(server) }` — call `dropServer` when a server is removed at runtime
(e.g. after `client.removeServer`) to avoid leaking per-key state. For richer policies, plug
cockatiel/bottleneck onto the same interceptor seam.

## Observability — metrics + health (`mcp-query/metrics`)

```ts
import { MetricsCollector } from "@johnhenry/mcp-query/metrics";
const metrics = new MetricsCollector();
new MCPClient({ servers, interceptors: [metrics.interceptor()] });
app.get("/metrics", (_, res) => res.type("text/plain").send(metrics.prometheus()));
app.get("/healthz", async (_, res) => res.json(await client.health())); // per-server state + live ping
```

For OpenTelemetry, wrap `@opentelemetry/api` as a tracing interceptor (propagate
`traceparent` via `context.meta`).

## Gateway — re-serve upstreams as one MCP endpoint (`mcp-query/server`)

```ts
import { createGateway } from "@johnhenry/mcp-query/server";
const gateway = createGateway(client, { namespace: true });   // an SDK Server
await gateway.connect(transport);   // expose over stdio / Streamable HTTP
```

Aggregates + namespaces tools/resources/prompts, routes calls/reads/gets to upstreams, and
propagates `*_list_changed`. The deployable "single endpoint fronting many."

**Extensions** (`GatewayOptions.extensions`). The gateway also carries MCP extensions: tasks
(`tasks/get|update|cancel`, with namespaced, HMAC-signed `taskId`s bound to the caller's partition and
`_meta.principal`), skills (`skills/list|get` aggregated across upstreams, the origin in each `skill://` URI,
file bytes forwarded untouched so digests still verify), MCP Apps (`_meta.ui`, `ui://`), and an opt-in
`passthrough` allowlist for unknown extension methods. An extension is offered to a consumer only when an
upstream advertises it, `extensions` allows it and the consumer declared it; the consumer's declaration is what
a 2026-07-28 upstream sees. Everything goes through the interceptor chain (`client.forward()` for the raw
methods). See the mcp-gate README, "Extensions", for the full rules.

## Per-principal sessions + graceful shutdown (`mcp-query/session`)

```ts
import { SessionManager } from "@johnhenry/mcp-query/session";
const sessions = new SessionManager({
  ttl: 5 * 60_000,
  create: async (principal) => { const c = new MCPClient({ servers: serversFor(principal) }); await c.connect(); return c; },
});
const client = await sessions.get(userId);   // one isolated client per principal
setInterval(() => sessions.sweep(), 60_000);  // evict idle (drains them)

process.on("SIGTERM", async () => { await sessions.closeAll(); }); // or client.drain()
```

`client.drain()` refuses new ops, awaits in-flight, and closes — for SIGTERM.

## Multi-node cache (`mcp-query/redis`)

L1 stays synchronous in-process (the hooks need it); an optional async **L2** shares cache
across instances and broadcasts invalidations.

```ts
import { createRedisCacheStore } from "@johnhenry/mcp-query/redis";
const cacheStore = createRedisCacheStore(redis, redisSubscriber); // bring your own ioredis
new MCPClient({ servers, cacheStore });
```

Reads consult L2 on an L1 miss (skipping the network on a hit) and write through; *declared*
invalidations fan out to other nodes (protocol-driven ones stay local). `MemoryCacheStore`
is the in-process equivalent (tests / single process).

**SEP-2549 `cacheScope` (2026-07-28):** results a modern-era server marks
`cacheScope: "private"` are never written to a shared L2 *unless* the cache key
carries a `partition` — the partition IS the authorization context, so a
partitioned private entry is already isolated in the shared store. Note the v2
SDK's server-side default stamp is `private`, so cross-instance sharing against
modern servers requires either servers that stamp `public` or partitioned
`CallContext`s. Legacy-era (unhinted) results keep the old always-share behavior.

## Not yet (honest)

- **Lazy-connect / idle eviction** of upstream connections (eager today) — a small follow-up.
- A dedicated OpenTelemetry peer-dep module (the tracing interceptor pattern works now).
