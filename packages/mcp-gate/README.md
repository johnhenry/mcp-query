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
| **Audit** | Every call (allowed *and* denied) emitted to a pluggable sink — stderr by default, a DB/SIEM in production. Covers `tools/call`, `resources/read`, `prompts/get`, the skills calls and catalog (`list`) views. |
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
| `answerPolicy` | `AnswerPolicy` (rules or function) | none (answers allowed) | allow / deny / approve for the consumer's answers to forwarded input requests (and to task input requests) — see [Answers going upstream](#answers-going-upstream). |
| `extensions` | `{ allow?, deny?, passthrough?, tasksSecret?, taskResolveMs? }` | tasks, skills, MCP Apps allowed; no pass-through | Which MCP extensions the gate offers and forwards — see [Extensions](#extensions). |
| `card` | `{ url, name, version, description?, title?, websiteUrl?, supportedProtocolVersions?, listUpstreams? }` | none | Server Card for the gate's own endpoint — see [Server Card](#server-card-sep-2127). |
| `policy.skills` | `{ allow?, deny?, approve? }` | none (skills allowed) | Whole-skill globs on `server.<skill-path>` — see [Skills](#skills). |

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

### What the policy sees: operation kinds

Policy, redaction, rate-limit, circuit-breaker and `audit` run on every operation of the governed
client, and the audit entry's `kind` says which: `read` (resources/read), `call`/`query` (tools),
`prompt` (prompts/get, `target` = prompt name), `skill` (skills list/get/read; `target` = `skills`, a
skill URI or a file), `task` (`tasks/get|update|cancel`; `target` = the tool that started the task),
`extension` (an allowlisted pass-through method; `target` = the method) and `list` (the catalog behind `listTools()`/`listResources()`/`listPrompts()`;
`target` = `tools`, `resources`, `resourceTemplates` or `prompts`).

- **Declarative policy.** Globs apply to tool calls, resource reads and `prompts/get` (by prompt name,
  the same ids `policyListFilter` already used to hide prompts from discovery). `list` operations are
  always allowed by a declarative policy, so existing `allow`/`deny` configs do not start refusing
  catalogs; skills are allowed unless `policy.skills` says otherwise ([Skills](#skills)). Name-denied
  items are hidden from the client's own `listTools()` / `listResources()` / `listPrompts()` the way they
  are from the gateway's `*/list` (library mode included), and `approval.discovery: "annotated"` stamps
  `_meta.requiresApproval` there too.
- **Function policy.** Receives every kind, including `list`, `prompt`, `skill`, `task` and `extension`;
  `req.method` says which MCP method (`skills/read`, `tasks/cancel`, ...). An `"approve"` verdict on a
  `list` is treated as allow (a catalog view is not an action and must not wait for a human); on
  `prompt`/`skill` it goes through approval.
- **Redaction.** `redact` rules scrub `prompts/get` results, and the content of a task (see [Tasks](#tasks)).
  They never touch a **skill** (see [Skills](#skills): a digest covers the bytes) and not catalog views
  (a pattern must not rewrite a tool name the router resolves).
- **Rate-limit / circuit-breaker.** Apply to every kind that reaches the upstream; skip `list`
  (a local view).

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

## Extensions

The gate carries the MCP extensions (SEP-2133) a consumer behind it would get from an upstream directly,
with policy, redaction and audit applied. The rule for all of them: an extension is **offered to a consumer
only when** (1) an upstream advertises it, (2) `extensions` allows it (default: tasks, skills, MCP Apps),
and (3) the consumer **declared** it, in per-request client capabilities on the 2026-07-28 era or in
`initialize` on the 2025 era. The gate's `capabilities.extensions` is computed that way, per consumer
(a 2026 `server/discover` that carries no declaration shows the full computed set), and what the consumer
declared is what reaches the upstream: on a 2026-07-28 upstream connection it is sent as that request's
client capabilities, never more. A 2025-era upstream has fixed capabilities from its `initialize`, so only
the gate's own declaration applies there.

```ts
createGate({
  upstreams: { /* ... */ },
  extensions: {
    deny: ["io.modelcontextprotocol/ui"],                          // never offer / forward MCP Apps
    passthrough: { "io.modelcontextprotocol/events": { methods: ["events/poll"] } }, // see below
    tasksSecret: process.env.GATE_TASKS_SECRET,                    // >= 16 bytes; share it across gate instances
  },
});
```

### Tasks

`io.modelcontextprotocol/tasks` (SEP-2663). A consumer that declared the extension and calls a task-capable
tool gets the task handle; `tasks/get`, `tasks/update` and `tasks/cancel` are served by the gate and routed
to the upstream that owns the task. A consumer that did **not** declare it gets the old behaviour: the
upstream is not told tasks are acceptable (or, if it returns a handle anyway, the gate polls it to the end,
up to `taskResolveMs`) and the consumer receives the final result.

- **Task ids are namespaced and signed**: `gw1.<payload>.<HMAC>`. The payload names the upstream, the tool
  and the upstream's own id, and binds them to the **partition** (`partitionFrom`, default `_meta.partition`)
  and `_meta.principal` that created the task. The gate holds no per-task state, so any instance with the same
  `tasksSecret` can route an id (default: a random secret per instance, ids die with the process). An altered
  id, one minted by another secret, or one presented by another tenant or principal is refused as `unknown task`
  (-32602), the same message for all three, and the foreign-tenant case is audited as `denied`. The partition and
  principal are read from request `_meta`, exactly as for every other gate decision: bind them to your
  authenticated caller in front of the gate, or a tenant can claim another's.
- **Policy and audit** run on every poll, answer and cancel as `kind: "task"` with `target` = the tool that
  started the task and `method` = the task method. A declarative policy applies the tool's `deny`/`allow`
  rules (a denied tool cannot be polled) but does not ask for approval again at each poll; a function policy
  sees everything.
- **Redaction** applies to what the consumer reads: the inlined `result` of a `completed` task, the
  `inputRequests` of an `input_required` one, `error` and `statusMessage`. Ids, status and timestamps are never rewritten.
- **Input requests inside a task** follow the same rules as forwarded MRTR rounds: a URL-mode elicitation is
  judged against `urlElicitation` (fails closed), and the consumer's `tasks/update` answers go through
  `answerPolicy` and `redact` before they reach the upstream (`AnswerInfo.surface` is `"task"`).
- Modern-era (2026-07-28) upstream connections need an SDK that can send `tasks/*` there (>= 2.3.0, see
  `@johnhenry/mcp-query`'s capability probe); on older SDKs the gate surfaces the SDK's error.

### Skills

`io.modelcontextprotocol/skills` (SEP-2640). `skills/list` and `skills/get` aggregate every upstream's skills, and
a skill file is served for `resources/read` from the upstream it came from. The originating server stays attached:
with `namespace` (the default) each `skill://` URI, the entry's and every manifest file's, gets the server as its first
path segment (`skill://git-commit/SKILL.md` on `github` becomes `skill://github/git-commit/SKILL.md`), so same-named
skills on two upstreams do not collide and a file read routes back to its own upstream; `_meta["io.johnhenry.mcp-query/server"]`
names the origin either way. Needs a skills-capable SDK (`@modelcontextprotocol/client` >= 2.4.0, or `skillsSdk` on the client).

**The gate never redacts or rewrites a skill.** A skill's manifest digest covers its exact bytes; rewriting a file would
make every consumer's verification fail. So `redact` skips skill files, and a skill file read as a plain resource is the same
file. (An earlier version scrubbed skill text on the client side and marked the file `verified: false`; that is gone.) The gate
serves the upstream's SDK-verified bytes untouched, so an upstream that lies about a digest is refused at the gate. What you
control is whole skills: `policy.skills` globs match `server.<skill-path>` (`github.git-commit`, `a.team/*`); `deny` wins, then
`allow` (if set) must match, then `approve` holds the skill for a human at `get` and at file reads. A denied skill is hidden from
`skills/list`. Function policies see `kind: "skill"` with `method` `skills/list`, `skills/get` or `skills/read` (and `args.skill`, the
skill's URI, on file reads). List, get and file reads are audited.

### MCP Apps (UI)

`io.modelcontextprotocol/ui`. A host that connects through the gate as its MCP endpoint can negotiate the UI extension: the gate's own
connection to upstreams declares it (so upstreams send tool `_meta.ui` and `ui://` resources), and the gateway hands that metadata on
only to a consumer that declared it too, whose declaration (`mimeTypes`, ...) is what a 2026-07-28 upstream sees on the calls and reads
made for it. A consumer that did not declare it sees no `_meta.ui` and no `ui://` resources. `extensions.deny` it to turn all of this off,
including the gate's own declaration.

### Unknown extensions (opt-in pass-through)

Off by default. List an extension's request methods under `extensions.passthrough` and the gate re-serves exactly those methods to a consumer
that declared the extension, through the interceptor chain (`kind: "extension"`, so `policy`, `redact`, rate-limit and `audit` apply) and to the one
upstream that advertises it, or the one named by `_meta["io.johnhenry.mcp-query/server"]` when several do. Request/response methods only (no
notifications), and the extension's own semantics are the upstream's job. This is how a new extension works through an existing gate release.

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

### Server Card (SEP-2127)

The gate can publish a [Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards) for its own
endpoint, so clients (and `mcp-query add --from-card`) can find where to connect and which protocol versions it
speaks. The gate has no HTTP server of its own (you mount `gate.server` on a transport), so the card is a
web-standard request handler you put in front of your MCP handler:

```ts
import { createGate, createGateCardHandler } from "@johnhenry/mcp-gate";

const config = {
  upstreams: { github: { url: "https://example.com/mcp" } },
  card: { url: "https://gate.example.com/mcp", name: "com.example/gate", version: "1.0.0" },
};
const card = createGateCardHandler(config); // (req: Request) => Response | undefined
// in your fetch-style server: serve GET https://gate.example.com/mcp/server-card
const respond = (req: Request) => card(req) ?? mcpHandler(req);
```

`gateServerCard(config)` returns the card object itself (for a static file or an AI Catalog entry), and
`gateCardUrl(url)` the location the SEP reserves, `<streamable-http-url>/server-card`. The card describes **only the
gate**: identity, its transport endpoint, supported protocol versions. It does not mention upstream names, URLs or
how many there are. Set `card.listUpstreams: true` to publish the upstream *names* (never URLs, commands or headers)
under `_meta["me.johnhenry/mcp-gate"].upstreams`. Supported versions default to what the installed
`@modelcontextprotocol/server` supports; set `card.supportedProtocolVersions` to be exact. A card is advisory: clients
prefer a live `server/discover` when the two disagree. The response carries `Access-Control-Allow-Origin: *` (the
SEP allows it for public metadata) so browser clients can read it.

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

## Upstream OAuth (client credentials, enterprise-managed)

Instead of pasting a bearer token, an HTTP upstream can carry its own identity. Secrets are **references**
(an env var name or a callback), never inline: `validateGateConfig` rejects a plain string.

```ts
upstreams: {
  billing: {
    url: "https://mcp.billing.example/mcp",
    auth: {
      type: "client_credentials",            // io.modelcontextprotocol/oauth-client-credentials
      issuer: "https://auth.billing.example", // required: credentials go only to this authorization server
      clientId: "gate-svc",
      clientSecret: { env: "BILLING_CLIENT_SECRET" },   // or { get: async () => vault.read(...) }
      scope: "mcp:read",
    },
  },
  hr: {
    url: "https://mcp.hr.example/mcp",
    auth: {
      type: "enterprise",                    // io.modelcontextprotocol/enterprise-managed-authorization
      issuer: "https://auth.hr.example",
      idToken: { get: () => sso.currentIdToken() },      // the user's identity assertion
      idp: { tokenEndpoint: "https://idp.corp.example/oauth2/token", clientId: "gate-at-idp", clientSecret: { env: "IDP_SECRET" } },
      clientId: "gate-at-hr", clientSecret: { env: "HR_CLIENT_SECRET" },
    },
  },
}
```

The token endpoint is discovered from the upstream (RFC 9728, then RFC 8414) and its `issuer` must equal the
configured one, otherwise nothing is sent; set `tokenEndpoint` to skip discovery. Tokens are cached in memory
until 30 seconds before `expires_in` (60 s assumed when absent), concurrent calls share one fetch, and a 401 from
the upstream drops the cached token. Neither secrets nor tokens appear in audit entries or in this module's
error messages. `auth` excludes `getToken` and an `Authorization` header.

> **Enterprise-managed authorization is untested against a real identity provider.** It is built on the SDK's
> RFC 8693 token-exchange and RFC 7523 jwt-bearer helpers and verified only against a mock IdP and a mock
> authorization server in this repo's tests. Treat it as experimental.

## Inbound authentication

To require OAuth from the gate's own consumers, front its HTTP handler with the SDK's `requireBearerAuth`
(or call `verifyBearerToken` yourself), pass the verified `AuthInfo` through, and turn on `inboundAuth`:

```ts
import { requireBearerAuth } from "@modelcontextprotocol/server";

const gate = await createGate({
  upstreams,
  inboundAuth: true,                        // or { required: true, principal: (a) => ... }
  policy: (req) => (req.context?.meta?.principal === "alice" ? "allow" : "deny"),
  partitionFrom: (meta) => meta?.principal as string | undefined,   // per-principal cache + rate limits
});
const handler = gate.handler();
const guard = requireBearerAuth({ verifier, requiredScopes: ["mcp"], resourceMetadataUrl });
export default async (request: Request) => {
  const auth = await guard(request);
  return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
};
```

The verified principal (`extra.sub`, else `clientId`) lands in the call's `_meta.principal`, with `partition` (defaults to the principal), `authScopes` and
`authClientId`, so `policy`, `partitionFrom`, `rateLimit`/`circuitBreaker` keys and audit entries all see it. Those
four keys belong to the verifier, on every handler the gateway registers (tools, prompts, resources, tasks, skills, extension pass-through): whatever a caller puts under them in its own `_meta` is dropped, so a client
cannot claim someone else's identity. Without `inboundAuth` nothing is mapped. The access token itself is never copied
into the context.

## MCP SDK versions

`mcp-gate` depends only on `@modelcontextprotocol/client@2.0.0` and
`@modelcontextprotocol/server@2.0.0` (the v2-split packages — same lineage `@johnhenry/mcp-query`
itself peer-depends on). It does **not** depend on the v1 monolith `@modelcontextprotocol/sdk`
at all. A consumer pinning `@modelcontextprotocol/sdk@^1.x` for its own MCP client code has no
version conflict with gate — these are separate npm package names, so npm/pnpm install both
side by side with no peer-dependency collision. Wire compatibility across the two generations
is real and already exercised in CI: `test/gate.test.ts` connects a v1-SDK `Client` to a gate
`server` built on v2 `@modelcontextprotocol/server`, and every test passes.

Minimum SDK per auth feature (the peer range stays `^2.0.0`):

| Feature | Minimum |
| --- | --- |
| Upstream `auth: client_credentials` and `auth: enterprise` (uses `requestJwtAuthorizationGrant`, `exchangeJwtAuthGrant`, `discoverOAuthServerInfo`) | client 2.0.0 |
| Inbound `requireBearerAuth` / `verifyBearerToken` and `inboundAuth` | server 2.0.0 |
| DPoP-bound tokens (`OAuthClientProvider.dpop()`, `withDpop`): not used by the gate's upstream auth yet; used by the CLI `login --dpop` | client 2.1.0 |
| SDK `expectedIssuer` on its own credential providers | client 2.0.0 for `ClientCredentialsProvider`; the gate pins issuers itself via the required `issuer` field |

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
