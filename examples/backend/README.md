# Backend examples

mcp-query server-side, end to end. All runnable with no network (in-memory mock server) —
`npx tsx examples/backend/<file>`. Conceptual guide: [docs/backend.md](../../docs/backend.md).

| # | File | Shows |
|---|------|-------|
| 01 | [`01-multitenant.ts`](./01-multitenant.ts) | `CallContext` partition + meta + `scope()` — per-tenant cache isolation, principal via `_meta` |
| 02 | [`02-interceptor.ts`](./02-interceptor.ts) | custom interceptors — logging/timing + a short-circuit memoizer |
| 03 | [`03-authorization.ts`](./03-authorization.ts) | `authorize` + `denyDestructiveUnless` + `onCall` durable audit |
| 04 | [`04-resilience.ts`](./04-resilience.ts) | `circuitBreaker` (open → fast-fail → half-open) + `rateLimit` (concurrency cap) |
| 05 | [`05-metrics-health.ts`](./05-metrics-health.ts) | `MetricsCollector` → Prometheus + `client.health()` |
| 06 | [`06-gateway.ts`](./06-gateway.ts) | `createGateway` — aggregate upstreams as one MCP endpoint; a plain SDK Client consumes it |
| 07 | [`07-sessions.ts`](./07-sessions.ts) | `SessionManager` — one isolated client per principal + idle eviction + drain |
| 08 | [`08-l2-cache.ts`](./08-l2-cache.ts) | `MemoryCacheStore` — node B serves from L2; declared invalidation fans out |
| 09 | [`09-lazy.ts`](./09-lazy.ts) | lazy connect + idle eviction (connect on first use; re-wake) |
| 10 | [`10-otel.ts`](./10-otel.ts) | OpenTelemetry `tracing` interceptor (spans + trace-context via `_meta`) |
| 11 | [`11-kitchen-sink.ts`](./11-kitchen-sink.ts) | a production-shaped client wiring **everything** together |

The client/UI-side examples live one level up in [`../`](../) (`01`–`08`, `node-everything`,
`react-app`, `webmcp-bridge`).
