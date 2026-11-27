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
| `interactions` | `"answer" \| "forward" \| "deny" \| { default?, upstreams? }` | `"answer"` | What an upstream's `input_required` (MRTR) round does — see [Forwarding upstream interactions](#forwarding-upstream-interactions). |
| `urlElicitation` | `{ allowHosts?, denyHosts? }` | none (URL mode denied) | Host globs for a forwarded URL-mode elicitation. |
| `answerPolicy` | `AnswerPolicy` (rules or function) | none (answers allowed) | allow / deny / approve for the consumer's answers to forwarded input requests — see [Answers going upstream](#answers-going-upstream). |

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

#### Policy and redact options (embedders)

`compilePolicy`, `policyListFilter` and `policyListAnnotator` take an optional options object
(also exported from `@johnhenry/mcp-gate/policy`); every default is the behaviour above.

- `emptyAllow: "deny" | "ignore"` (default `"deny"`): `allow: []` denies everything; `"ignore"`
  treats an empty list as no allow list.
- `scope: "qualified" | "tool" | { [server]: scope }` (default `"qualified"`): `"tool"` matches
  globs against the bare tool name instead of `server.tool`; a map sets it per server.
- `explainPolicy(policy, options?)` is `compilePolicy` returning `{ decision, rule? }`, where
  `rule` is `{ list: "deny" | "approve" | "allow" | "denyDestructive", glob? }`: the list (and
  glob as written) that decided. `rule` is absent when the default applied; an allow-list miss
  is `{ list: "allow" }` with no glob.
- Redact rules accept `flags` (`g`, `i`, `m`, `s`, `u`, ...; `g` is always added; a RegExp
  pattern's own flags are replaced), and `redact(rules, { defaultReplacement })` /
  `redactValue(rules, value, { defaultReplacement })` change the `"[REDACTED]"` default.

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

Browser note: approval works in `createGateClient` too (see "Browser usage"); only the gateway
`Server` and stdio upstreams are Node-only.

## Forwarding upstream interactions

On the 2026-07-28 protocol a tool (or prompt) can answer with an `input_required` result
instead of a final one: it carries `inputRequests` (typically an elicitation: "really delete
this repo?") and an opaque `requestState`, and the caller retries with `inputResponses` and
the same `requestState`. A plain gate answers those rounds itself (with its own host
handlers) or fails, so the person at the far end of the gate never sees the question. That is
the default, and it is unchanged. `interactions` makes it a choice:

| `interactions` | An upstream `input_required` round... |
|---|---|
| `"answer"` (default) | is answered by the gate's own `MCPClient` handlers, or fails. The consumer never sees it. |
| `"forward"` | is returned to the consumer. `inputRequests` pass through the gate's `redact` rules; `requestState` is forwarded byte-for-byte (never redacted); the consumer's retry (`inputResponses` + `requestState`) is routed back to the same upstream call, with the answers redacted and checked against `answerPolicy` first ([Answers going upstream](#answers-going-upstream)). Each hop goes through `authorize`, rate-limit, circuit-breaker and `audit`. |
| `"deny"` | is refused: the upstream is told the gate cannot ask anyone, and an `input_required` result anyway fails with `-32003`. |

Set one mode for every upstream, or a default plus per-upstream overrides:

```ts
export default {
  upstreams: { github: { url: "https://example.com/mcp" }, notes: { command: "notes-mcp" } },
  interactions: { default: "deny", upstreams: { github: "forward" } },
  urlElicitation: { allowHosts: ["github.com", "*.github.com"] },
} satisfies GateConfig;
```

What forwarding does and does not do:

- **Elicitation only.** A `sampling/createMessage` or `roots/list` request in a round is
  refused (`-32003`); only `elicitation/create` is relayed.
- **The upstream is told the truth.** Per request, the gate declares to the upstream exactly
  the elicitation capability the consumer declared (and none when denying). A consumer that
  declared none gets `MissingRequiredClientCapability` (`-32021`) rather than a question it
  cannot answer.
- **Both consumer eras.** A modern consumer receives the `input_required` result itself; a
  2025-era consumer receives it as a server-initiated `elicitation/create` (the SDK carries
  the round) and the answer is retried for it.
- **Modern upstreams only.** Forwarding applies to upstreams on a 2026-07-28 connection (set
  `versions` on the upstream's `ConnectionConfig`). A 2025-era upstream asks with a
  server-initiated `elicitation/create` on the gate's own connection and is not relayed.
- **Never cached.** An interim `input_required` result is not a tool result and is never
  written to the cache, even for a `readOnlyHint` tool.
- **`requestState` is the upstream's.** The gate neither inspects nor signs it. An upstream
  that lets it influence authorization must protect its integrity itself, as the spec requires.
- **Audit.** A `CallAuditEntry` for a call that was one hop of a round carries
  `interaction: { phase: "request", methods, urlHosts? }` (the call returned `input_required`)
  or `{ phase: "response", redactedFields?, declined? }` (the call carried the consumer's
  answers; see [Answers going upstream](#answers-going-upstream)). Payloads are not logged.
  A refused round is an ordinary `"denied"` / `"error"` entry.
- **There is no server capability flag for MRTR** in the 2026-07-28 spec, so nothing new is
  advertised to the consumer in `initialize`/`server/discover`; the advertisement happens in
  the per-request client capabilities sent to the upstream, as above, and only when forwarding is on.

### Answers going upstream

A forwarded form elicitation is a person typing into a field, and what they type travels
back through the gate. The consumer's retry carries `inputResponses`, and the gate treats
them as data leaving the organisation:

- **Redaction.** Every `redact` rule is applied to every string in `inputResponses` before the
  retry goes upstream, so a password or key typed into a form is scrubbed on the way out (the
  same rules that scrub results and `inputRequests`). **`requestState` is never touched**:
  the gate passes it through byte-for-byte, so a redact rule can't corrupt the upstream's own
  token.
- **Policy.** `answerPolicy` gives authorization a say on the answer hop, with the usual
  allow / deny / approve. Each `accept`ed answer is judged on its own (declined and cancelled
  answers carry no data and pass). A denied answer is **replaced by `{ action: "decline" }`**,
  so the upstream sees that the person declined and the call carries on. An `approve` verdict
  waits for the `approval` backend, and a refusal, timeout or missing backend declines the
  answer (it never fails open). If an answer is not an elicitation result at all (so a decline
  can't stand in for it), the retry is refused with `-32003` and audited as `"denied"`.
- **No policy, no change.** Without `answerPolicy`, answers are allowed, so a gate that
  already forwards rounds keeps working; they are still redacted.

```ts
export default {
  upstreams: { github: { url: "https://example.com/mcp" } },
  interactions: "forward",
  redact: [{ pattern: "ghp_\\w+", replacement: "[TOKEN]" }],
  // Never let a typed password through; ask a person before an SSN goes upstream.
  answerPolicy: { denyFields: ["password"], approveFields: ["ssn"] },
  approval: { handler: askOnSlack },
} satisfies GateConfig;
```

`AnswerPolicy` is either rules, matched in this order (first match wins): `deny` (globs on the
`server.tool` / `server.prompt` id), `denyFields` (globs on field names: the dotted path or its
last segment), `approve`, `approveFields`, otherwise allow. Or it is a function receiving an
`AuthzRequest` with `kind: "answer"`, `target` (the tool or prompt name) and
`answer: { surface: "tool" | "prompt", key, action, fields }`: field **names**, never values.
There is no elicitation `mode` in it: an answer does not say whether it answers a form or a
URL request, and the gate is stateless between rounds.

**Audit.** The answer hop's `CallAuditEntry.interaction` is
`{ phase: "response", redactedFields?: string[], declined?: string[] }`: dotted paths such as
`q0.content.password` that were redacted, and the request keys (`q0`) that were declined.
Names only, never values. Caveats: a prompt's round (`prompts/get`) is guarded the same way
but, like every `prompts/get` today, does not produce an audit entry; and the field names come
from the consumer, so they are as trustworthy as the consumer is.

### URL-mode elicitation

A URL-mode elicitation sends the person to a URL the *upstream* chose. When forwarding, each
one is checked against `urlElicitation` before the consumer sees it: `denyHosts` first, then
`allowHosts`. Globs match the lowercased hostname, `*` matches any run of characters
(`*.example.com` matches `a.example.com`, not `example.com`). **It fails closed**: forwarding
with no `allowHosts` denies every URL-mode elicitation (form mode is unaffected). A denied
round is `-32003` and an audit entry with `outcome: "denied"` naming the host.

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

Also exported: `redact(rules)`, `compilePolicy(policy)`, `explainPolicy(policy)`, `policyListFilter(policy)`,
`resolveUpstream(spec)` (declarative spec → `ConnectionConfig`), `validateGateConfig(config)`,
`CircuitOpenError`, and the `GateConfig` / `GatePolicy` / `ApprovalConfig` / `ApprovalRequest` / `GateUpstream` / `StdioUpstreamSpec` /
`HttpUpstreamSpec` / `RedactRule` types.

### Browser usage

`createGate`/`resolveUpstream` spawn processes and serve a gateway `Server`, so they are
Node-only. A bundler that sets the `browser` condition (Vite, webpack, esbuild
`--platform=browser` do by default) resolves `@johnhenry/mcp-gate` to a browser-safe entry with
zero Node-only imports in its graph (a test bundles it for a browser platform and fails on any
`node:` builtin):

- `createGateClient(config)`: **library mode in the browser.** The full governed interceptor
  stack (policy, approval, circuit breaker, rate limit, redaction, audit) around an `MCPClient`,
  with no gateway server. Upstreams are a `ConnectionConfig` (any transport factory, for example
  a WebSocket bridge) or an `{ url }` Streamable HTTP spec; a stdio `{ command }` spec throws.
  Returns `{ client, approvals, addUpstream, removeUpstream, updateUpstream, close }`.
- `compilePolicy`, `policyListFilter`, `policyListAnnotator`, `validateGateConfig`.
- `redact(rules)` (the interceptor) and `redactValue(rules, value)` (redact any string, array
  or object directly, for example before saving a recorded session).
- `resolveHttpUpstream`, `CircuitOpenError`, and the config types.

The pieces are also importable on their own, loading nothing else:
`@johnhenry/mcp-gate/policy` (policy compiler) and `@johnhenry/mcp-gate/redact` (redactors).

```ts
import { createGateClient, redactValue } from "@johnhenry/mcp-gate";

const gate = await createGateClient({
  upstreams: { docs: { url: "https://example.com/mcp" } },
  policy: { denyDestructive: true, approve: ["docs.publish_*"] },
  approval: { timeoutMs: 60_000 },       // pending approvals appear in gate.approvals.list()
  redact: [{ pattern: /sk-[a-z0-9]+/g }],
});
await gate.client.callTool("search", { q: "hello" });
```

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
