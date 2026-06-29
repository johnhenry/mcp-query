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
**DLP redaction**, the **declarative policy compiler**, and the **CLI**.

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

In this monorepo it runs straight from source via `tsx`:

```bash
# serve a gate defined by a config module, over stdio
npx tsx packages/mcp-gate/src/cli.ts packages/mcp-gate/examples/gate.config.ts
```

Wire it into an MCP host (e.g. Claude Desktop) in place of the raw upstream:

```jsonc
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["tsx", "packages/mcp-gate/src/cli.ts", "packages/mcp-gate/examples/gate.config.ts"]
    }
  }
}
```

## Configuration

Config is **code** — a `.ts`/`.js` module that default-exports a `GateConfig` — because
transports are functions. The *policy*, though, is declarative.

```ts
import type { GateConfig } from "@mcp-query/gate";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config: GateConfig = {
  // 1. Upstreams to front (name → mcp-query ConnectionConfig). The name becomes the namespace.
  upstreams: {
    everything: {
      transport: () => new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }),
    },
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
| `upstreams` | `Record<string, ConnectionConfig>` | — | mcp-query connection configs; key = namespace. |
| `policy` | `GatePolicyRules \| (req) => "allow"\|"deny"` | none (allow all) | Declarative rules or a custom function. |
| `redact` | `RedactRule[]` | none | `{ pattern: RegExp\|string, replacement?: string }`. |
| `rateLimit` | `{ concurrency?: number }` | none | Per-gate concurrency cap. |
| `circuitBreaker` | `{ threshold?, cooldownMs? }` | none | Per-upstream open/half-open breaker. |
| `namespace` | `boolean` | `true` | Prefix re-exposed names with `server.`. |
| `audit` | `(entry: CallAuditEntry) => void` | stderr line | Sink for every op. |
| `clientInfo` | `ClientInfo` | `mcp-gate` | Identity sent to upstreams. |

### Policy semantics

Evaluated per call against the id `server.tool`:

1. `deny` glob match → **deny** (highest precedence).
2. `denyDestructive` and the tool is `destructiveHint` → **deny**.
3. `allow` is set and *no* glob matches → **deny** (allow-list mode).
4. otherwise → **allow**.

Globs use `*` as a wildcard. Name-based denials (`deny`/`allow`) are **also applied to tool
and prompt *listings***, so the agent never discovers a tool it can't call. `denyDestructive`
is enforced at **call time only** (the listing filter doesn't carry tool annotations).

## How it maps to mcp-query

`createGate(config)` builds the interceptor onion (outermost first) and serves it:

```
authorize(compilePolicy(policy))   // deny early
  → circuitBreaker(...)            // protect upstreams
    → rateLimit(...)               // cap concurrency
      → redact(...)                // scrub the result on the way back
        → MCPClient → upstreams
```

then `createGateway(client, { namespace, filter })` re-exposes it as one `Server`. So the
gate inherits mcp-query's reconnection, aggregation, `_meta` propagation, and audit hook for
free; `mcp-gate` only adds the DLP interceptor, the policy compiler, and the CLI.

## API

```ts
import { createGate } from "@mcp-query/gate";

const gate = await createGate(config);
await gate.server.connect(transport); // gate.server is an SDK Server; gate.client is the MCPClient
await gate.close();
```

Also exported: `redact(rules)`, `compilePolicy(policy)`, `policyListFilter(policy)`, and the
`GateConfig` / `GatePolicy` / `RedactRule` types.

## Tests

```bash
npx vitest run    # routing, policy (deny + destructive), discovery hiding, redaction, audit
```

All tests drive a real consumer SDK `Client` over `InMemoryTransport` against `gate.server`,
fronting an in-memory `MockMCPServer` — no network, no subprocess.

## Status

MVP. Not yet published (`private: true`). Roadmap: per-principal policy (`req.context.meta`),
streaming-result redaction, metrics endpoint, hot config reload.
