# mcp-gate

A **config-driven MCP security/policy proxy**. Point it at one or more upstream MCP
servers and it re-exposes them as a *single, governed* MCP endpoint: authorization,
DLP redaction, rate-limiting, circuit-breaking, and audit — all declared in one config
file, enforced before anything reaches the agent.

```
        ┌────────────┐        ┌──────────────── mcp-gate ────────────────┐        ┌──────────────┐
 agent  │  MCP host  │ stdio  │  authorize → circuit-break → rate-limit   │        │  upstream A  │
 ◀────▶ │ (Claude,   │ ◀────▶ │            → redact            (gateway)   │ ◀────▶ │  upstream B  │
        │  Cursor…)  │        │  one namespaced endpoint, full audit log  │        │  upstream C  │
        └────────────┘        └───────────────────────────────────────────┘        └──────────────┘
```

It's a thin assembly over [`mcp-query`](../../README.md): an `MCPClient` fronting the
upstreams with a server-side interceptor stack, wrapped by `createGateway` so the whole
multiplexed, policy-enforced set is served as one `Server`. The only net-new code here is
**DLP redaction**, the **declarative policy compiler**, **config validation**, and the **CLI**.

## Why

A raw MCP server handed to an agent is ungoverned: every tool is callable, every result
flows back verbatim, nothing is logged, one slow/dead upstream stalls the agent. `mcp-gate`
is the choke point you put in front of it — the same role a reverse proxy / API gateway
plays for HTTP services.

| Concern | What the gate does |
|---|---|
| **Authorization** | Declarative allow/deny globs over `server.tool`; block tools flagged `destructiveHint`. Denied tools are also *hidden from discovery*. |
| **Data loss (DLP)** | Regex redaction rewrites secrets (SSNs, emails, keys) in every tool/resource/structured result before the agent sees them. |
| **Resilience** | Per-upstream circuit breaker + concurrency cap, so one bad server can't take down the agent. |
| **Audit** | Every call (allowed *and* denied) emitted to a pluggable sink — stderr by default, a DB/SIEM in production. |
| **Aggregation** | Many upstreams → one namespaced (`server.tool`) endpoint, with live `list_changed` propagation. |

## Install / run

```bash
npm install @johnhenry/mcp-gate
npx mcp-gate ./gate.config.ts   # serve a gate defined by a config module, over stdio
```

Wire it into an MCP host (e.g. Claude Desktop) in place of the raw upstream:

```jsonc
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["mcp-gate", "./gate.config.ts"]
    }
  }
}
```

## Configuration

Config is **code** — a `.ts`/`.js` module that default-exports a `GateConfig` — but both
the *policy* and the *upstreams* can be fully declarative. An upstream is either the
`.mcp.json` shape (`{ command, args?, env? }` for stdio, `{ url, headers? }` for
Streamable HTTP — the gate builds the transport) or a full mcp-query `ConnectionConfig`
(`transport: () => Transport` factory) when you need custom transports or reconnect tuning.

The config is **validated at load time**: unknown/typo'd keys, malformed upstreams, and
wrong basic types make `createGate` throw with a message naming the bad key and the valid ones.

```ts
import type { GateConfig } from "@johnhenry/mcp-gate";

const config: GateConfig = {
  // 1. Upstreams to front (name → declarative spec or ConnectionConfig). The name becomes the namespace.
  upstreams: {
    everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
    context7: { url: "https://mcp.context7.com/mcp" },
  },

  // 2. Policy — declarative globs over `server.tool`, or a function for custom logic.
  policy: {
    denyDestructive: true,   // block anything annotated destructiveHint
    deny: ["*.get-env"],     // explicit deny (wins over allow)
    // allow: ["everything.echo", "everything.add"], // if set, allow-list mode: deny everything else
  },

  // 3. DLP — rewrite matches in every result before the agent sees them.
  redact: [
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[EMAIL]" },
  ],

  // 4. Resilience.
  rateLimit: { concurrency: 8 },
  circuitBreaker: { threshold: 5, cooldownMs: 10_000 },

  // 5. Audit sink (default: one line per call to stderr).
  audit: (e) => log.info({ msg: "mcp-call", ...e }),
};

export default config;
```

### `GateConfig`

| Field | Type | Default | Notes |
|---|---|---|---|
| `upstreams` | `Record<string, GateUpstream>` | — | `{ command, args?, env? }` (stdio) \| `{ url, headers?, getToken? }` (Streamable HTTP) \| mcp-query `ConnectionConfig`; key = namespace. |
| `policy` | `GatePolicyRules \| (req) => "allow"\|"deny"\|"approve"` | none (allow all) | Declarative rules (`allow`/`deny`/`approve`/`denyDestructive`) or a custom function. |
| `approval` | `{ broker?, handler?, timeoutMs?, onTimeout?, discovery? }` | none | Decides `"approve"` verdicts — see [Human-in-the-loop approval](#human-in-the-loop-approval). Required with `policy.approve`. |
| `redact` | `RedactRule[]` | none | `{ pattern: RegExp\|string, replacement?: string }`. |
| `rateLimit` | `{ concurrency?: number }` | none | Concurrency cap per `(upstream, tenant)` pair — see `partitionFrom`. |
| `circuitBreaker` | `{ threshold?, cooldownMs? }` | none | Open/half-open breaker per `(upstream, tenant)` pair. |
| `partitionFrom` | `(meta) => string \| undefined` | `meta?.partition` | Derives the tenant key `rateLimit`/`circuitBreaker` isolate by. See [Multi-tenancy](#multi-tenancy). |
| `namespace` | `boolean` | `true` | Prefix re-exposed names with `server.`. |
| `audit` | `(entry: CallAuditEntry) => void` | stderr line | Sink for every op — see the field's TSDoc in `src/config.ts` for the full contract (fires after settle, not awaited, wrapped for crash-safety). |
| `clientInfo` | `ClientInfo` | `mcp-gate` | Identity sent to upstreams. |

`HttpUpstreamSpec.getToken?: () => string | undefined | Promise<string | undefined>` resolves
a bearer token fresh before every request (the SDK's own `AuthProvider.token()` hook — no
gate-side caching, no shared mutable state, safe under concurrent calls). Mutually exclusive
with `headers.Authorization`.

### Policy semantics

Evaluated per call against the id `server.tool`; the first rule that matches wins:

1. `deny` glob match → **deny** (highest precedence).
2. `denyDestructive` and the tool is `destructiveHint` → **deny**.
3. `allow` is set and *no* glob matches → **deny** (allow-list mode).
4. `approve` glob match → **approve** (needs a human/handler decision, see below).
5. otherwise → **allow**.

A function policy may return `"allow"`, `"deny"` or `"approve"` directly.

Globs use `*` as a wildcard. Name-based denials (`deny`/`allow`) are **also applied to tool
and prompt *listings***, so the agent never discovers a tool it can't call. `denyDestructive`
is enforced at **call time only** (the listing filter doesn't carry tool annotations).

## How it maps to mcp-query

`createGate(config)` builds the interceptor onion (outermost first) and serves it:

```
populatePartition(partitionFrom)   // resolve the tenant key first
  → authorize(compilePolicy(policy))   // deny early
    → circuitBreaker(...)              // protect upstreams, per (upstream, tenant)
      → rateLimit(...)                 // cap concurrency, per (upstream, tenant)
        → redact(...)                  // scrub the result on the way back
          → MCPClient → upstreams
```

then `createGateway(client, { namespace, filter })` re-exposes it as one `Server`. So the
gate inherits mcp-query's reconnection, aggregation, `_meta` propagation, dynamic
`addServer`/`removeServer`, and audit hook for free; `mcp-gate` only adds the DLP
interceptor, the tenant-aware `rateLimit`/`circuitBreaker` fork (see [Multi-tenancy](#multi-tenancy)),
the policy compiler, and the CLI.

## Human-in-the-loop approval

A policy verdict is `allow | deny | approve`. `approve` means "allowed, but only if someone
says so": the call is held until the approval backend decides, then runs (approved) or fails
with JSON-RPC `-32003` (denied; audited as `"denied"`). Approval **fails closed** — a timeout,
a throwing handler, or a broker that auto-denies all refuse the call.

```ts
const gate = await createGate({
  upstreams: { fs: { command: "mcp-fs" } },
  policy: {
    deny: ["fs.shell_*"],
    approve: ["fs.write_*", "fs.delete_*"], // humans sign off on these
  },
  approval: {
    timeoutMs: 60_000,   // no answer in a minute -> denied
    onTimeout: "deny",   // the only mode; approval never fails open
    // Either drive it programmatically ...
    handler: async (req) => (await askOnSlack(req)) ? "allow" : "deny",
    // ... or omit `handler` and resolve from a UI: gate.approvals.list() / .resolve(id, { action })
    // ... or share your own InteractionBroker (its `policy` can auto-allow/auto-deny some requests):
    // broker: myBroker,
  },
});

// UI-driven flow (no handler): the held call shows up in the broker's queue.
gate.approvals!.subscribe(() => {
  for (const it of gate.approvals!.list()) gate.approvals!.resolve(it.id, { action: "approve" });
});
```

- **Where it runs.** Right after the policy's allow/deny decision and *before* the circuit
  breaker, rate limiter and redaction. Denied calls never reach a human; a human wait doesn't hold
  a rate-limit slot or count against the breaker; redaction still applies to whatever the
  approved call returns.
- **`approve` never widens access.** An id outside `allow` is denied even if it matches `approve`,
  and `deny` always wins.
- **`denyDestructive` interplay.** `denyDestructive: true` is a hard deny - destructive tools are
  refused outright, not routed to a human. To send destructive tools to approval instead, leave it
  off and list them in `approve`, or use a function policy: `(req) => req.destructive ? "approve" : "allow"`.
- **Discovery (`approval.discovery`).** By default (`"visible"`) an `approve`-listed tool shows up in
  `tools/list` like any other and is only held when called. Set `discovery: "annotated"` to keep it
  listed but flag it with `_meta.requiresApproval: true` (a badge hook for UIs; MCP tool `annotations`
  is a closed set of behavior hints, so `_meta` is used), or `"hidden"` to drop it from
  `tools/list` / `prompts/list` / `resources/list`. **Trade-off:** hidden is de-cluttering, not
  access control - a caller that already knows the name can still call it, and the call still goes
  through the full approval flow; agents just won't discover it on their own. Use `deny`/`allow` to
  actually forbid a tool. Only declarative `policy.approve` globs are listed this way; a function
  policy's `"approve"` verdicts are call-time only. `deny`/`allow` hiding applies in every mode.
- **Without `approval`.** `policy.approve` is rejected at config validation; a function policy that
  returns `"approve"` is denied at call time (there is nobody to ask).
- **Broker semantics.** The gate calls `broker.gate("tool-call", server, { tool, args, destructive, request }, { autoApprove, autoDeny, timeoutMs })`
  for you (`autoApprove`/`autoDeny` are required by the broker's `gate()` when its own `policy`
  returns `"allow"`/`"deny"`, and the gate supplies them). A broker `policy` returning `"ask"`
  (the default) parks the call in `broker.list()` until `broker.resolve(id, decision)`.
- `ApprovalRequest` (what `handler` receives): `{ id, kind, server, target, args?, destructive, readOnly, context? }` -
  `target` is the upstream's own tool name (un-namespaced).

Browser note: approval lives in the Node entry only (`createGate`); the browser entry still exports
`compilePolicy`, which now returns `"approve"` for `approve` rules.

## Multi-tenancy

A single gate can serve many tenants/principals without one `Gate` instance per tenant.
`rateLimit`/`circuitBreaker` isolate their state by `(upstream, partition)`, not just
`upstream` — one tenant hammering an upstream or tripping its breaker doesn't throttle or
fast-fail every other tenant sharing the gate. The partition comes from `partitionFrom`
(default: `meta?.partition`), applied to `context.meta` before `policy` runs, so a function
policy can branch on it too. Two ways to set it:

- **Behind the gateway** (`gate.server` connected to a transport): the caller sets
  `_meta.partition` on a raw `tools/call` — the gateway already forwards `_meta` through.
- **Library mode**: `gate.client.scope({ partition, meta })` sets it directly — see below.

With no partition ever set anywhere (the default), every key collapses to the same string,
so this is behaviorally identical to a single shared bucket per upstream — no config needed
to keep today's behavior.

## Library mode

`createGate()` always returns a connected `client` — wiring `gate.server` to a transport is
**optional**, only needed if you want to expose a standalone governed MCP endpoint. To embed
governance (authz/redact/rateLimit/circuitBreaker/audit) directly inside your own process —
an agent host, a backend job — call `gate.client` directly and skip `server`/transport
entirely:

```ts
import { createGate } from "@johnhenry/mcp-gate";

const gate = await createGate(config);
const result = await gate.client.callTool("docs.echo", { message: "hi" });

// Multi-tenant embedding, ties to partitionFrom above:
const tenant = gate.client.scope({ partition: "acme", meta: { principal: "alice" } });
await tenant.callTool("docs.echo", { message: "scoped" });

await gate.close(); // no server.close() needed — it was never connected to a transport
```

Runnable version: `examples/01-library-mode.ts` (`npm run example:01`).

## API

```ts
import { createGate } from "@johnhenry/mcp-gate";

const gate = await createGate(config);
await gate.server.connect(transport); // gate.server is an SDK Server; gate.client is the MCPClient — optional, see Library mode
await gate.addUpstream("newServer", { url: "https://example.com/mcp" }); // connect + register live, no restart
await gate.updateUpstream("newServer", { url: "https://example.com/v2/mcp" }); // atomic remove+add
await gate.removeUpstream("newServer"); // disconnect + prune its rateLimit/circuitBreaker state + push list_changed
await gate.close();
```

`gate.approvals` is the `InteractionBroker` holding pending approvals (set when `config.approval` is).

Also exported: `redact(rules)`, `compilePolicy(policy)`, `policyListFilter(policy)`,
`resolveUpstream(spec)` (declarative spec → `ConnectionConfig`), `validateGateConfig(config)`,
`CircuitOpenError`, and the `GateConfig` / `GatePolicy` / `ApprovalConfig` / `ApprovalRequest` / `GateUpstream` / `StdioUpstreamSpec` /
`HttpUpstreamSpec` / `RedactRule` types.

### Browser usage

`createGate`/`resolveUpstream` actually spawn/connect an upstream MCP server process, so they
only make sense in Node — but `compilePolicy`, `redact`, `policyListFilter`, and
`validateGateConfig` are pure logic with no such dependency, and are genuinely useful client-side
(e.g. a policy/redaction-rule preview in a config-authoring dashboard). A bundler that sets the
`browser` condition (Vite, webpack, esbuild `--platform=browser` all do this by default for a
client build) resolves `import ... from "@johnhenry/mcp-gate"` to a subset entry exposing exactly
those four functions plus the pure types — with zero Node-only imports anywhere in its graph, so
it builds and runs in a browser bundle. `createGate`/`resolveUpstream` aren't part of that subset;
use them from a Node-run process as usual.

## MCP SDK versions

`mcp-gate` depends only on `@modelcontextprotocol/client@2.0.0` and
`@modelcontextprotocol/server@2.0.0` (the v2-split packages — same lineage `@johnhenry/mcp-query`
itself peer-depends on). It does **not** depend on the v1 monolith `@modelcontextprotocol/sdk`
at all. A consumer pinning `@modelcontextprotocol/sdk@^1.x` for its own MCP client code has no
version conflict with gate — these are separate npm package names, so npm/pnpm install both
side by side with no peer-dependency collision. Wire compatibility across the two generations
is real and already exercised in CI: `test/gate.test.ts` connects a v1-SDK `Client` to a gate
`server` built on v2 `@modelcontextprotocol/server`, and every test passes.

## Tests

```bash
npx vitest run    # routing, policy, discovery hiding, redaction, audit, dynamic upstreams, multi-tenancy
```

All tests drive a real consumer SDK `Client` over `InMemoryTransport` against `gate.server`,
fronting an in-memory `MockMCPServer` — no network, no subprocess.

## Status

Published as `@johnhenry/mcp-gate` on npm. Roadmap: streaming-result redaction, metrics
endpoint, hot config reload, per-`(upstream, partition)` connections for true per-tenant
credentials on one upstream URL (today's `getToken` resolves one credential for the whole
upstream connection, refreshed per call — not per-tenant on a shared URL; see `getToken`'s
TSDoc in `src/config.ts`).
