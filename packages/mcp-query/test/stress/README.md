# Stress suite

Opt-in load/chaos scenarios for the core client. Not part of `npm test` — files are named
`*.stress.ts`, which the default vitest include never matches.

```bash
npm run test:stress                    # hermetic run (MockMCPServer / in-process fakes only)
STRESS_REAL=1 npm run test:stress      # + scenarios that spawn a real server-everything child
REDIS_URL=redis://localhost:6379 npm run test:stress   # redis-l2 against a real Redis
```

## Philosophy

Budgets here are **generous regression ceilings**, not benchmarks — they exist to catch
order-of-magnitude regressions (a 25MB read taking 5s, a leak that survives GC), while
staying robust to slow CI machines. Real performance numbers belong to `@mcp-query/bench`.

Scenarios run **sequentially** (`fileParallelism: false`) so one file's load doesn't skew
another's timings, in a fork with `--expose-gc` so memory scenarios can force full GCs
around heap measurements. Chaos randomness is seeded (`helpers.seededRng`) — failures replay.

## Scenarios

| File | What it pins down |
|---|---|
| `subscribers.stress.ts` | 1k cache subscribers × 500 `resources/updated` bursts; final-version convergence; subscription ref-count returns to 0 |
| `parallel-calls.stress.ts` | 500 concurrent `callTool` settle distinctly; 500 identical-key `queryTool` dedupe to ONE upstream call |
| `reconnect-chaos.stress.ts` | 20 forced transport drops → `reconnecting → ready`; capability downgrade → `degraded` and back; `STRESS_REAL=1`: SIGKILL a real child ×5, no orphans |
| `list-changed-storm.stress.ts` | 1k `tools/list_changed` with a mutating spec → converges on the final surface; logs the re-list fan-in ratio |
| `cancel-progress.stress.ts` | 200 in-flight calls with progress, 100 aborted mid-flight; abort errors, post-abort progress silence, survivors complete |
| `large-payloads.stress.ts` | 25MB read under budget; structural sharing keeps identical payloads reference-equal; 50 superseding 5MB writes don't accumulate |
| `partition-isolation.stress.ts` | 50 `scope({partition})` views: zero cross-tenant observations; tag invalidation fans out to every partition |
| `interceptor-failure.stress.ts` | seeded chaos layer (throw/short-circuit) stays per-call; `op.state` never bleeds; rateLimit cap holds; circuitBreaker opens/fast-fails/half-opens |
| `memory.stress.ts` | 10k sub/unsub churn, 100 connect/close cycles, 10k distinct cache keys — heap returns to (near) baseline |
| `redis-l2.stress.ts` | L2 hydration across two nodes without touching the second upstream; 1k-tag invalidation storm lossless; JSON round-trip + PX TTL |
