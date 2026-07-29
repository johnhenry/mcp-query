// @johnhenry/mcpq-tanstack — TanStack Query bridge for @johnhenry/mcpq.

export { MCPQ_NS, tagToQueryKeyPrefix, toolResultQueryKey, resourceQueryKey, listQueryKey } from "./keys.js";
export { mcpqToolQueryOptions, mcpqResourceQueryOptions, mcpqToolListQueryOptions } from "./queryOptions.js";
export { mcpqToolMutationOptions } from "./mutationOptions.js";
export type { McpqToolMutationExtra } from "./mutationOptions.js";
export { attachMcpqSync, ensureSynced } from "./bridge.js";
