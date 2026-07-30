// Pluggable L2 cache store — re-exported from @johnhenry/agent-query-core (issue #18: the
// shared core's version is byte-identical to what used to live here; the pub/sub-backed
// MemoryCacheStore and the CacheStore/StoredEntry contract are fully protocol-agnostic).

export { MemoryCacheStore } from "@johnhenry/agent-query-core";
export type { CacheStore, StoredEntry } from "@johnhenry/agent-query-core";
