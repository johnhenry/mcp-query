// mutationOptions() factories for side-effecting mcp-query tool calls. Optimistic
// updates are NOT reimplemented here on the TanStack side — call the
// adapter's own `optimistic`/`patch()` mechanism inside your own mutationFn
// (mcp-query's `CallToolOpts.optimistic`) and the sync bridge propagates it
// automatically, the same way it propagates a server-confirmed write. True
// TanStack-native optimistic APIs (onMutate + manual setQueryData + rollback
// context) are an explicit v2 candidate, not built here.

import { mutationOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { CallToolOpts, MCPClient, Tag } from "@johnhenry/mcp-query";
import { tagToQueryKeyPrefix } from "./keys.js";

export interface McpqToolMutationExtra {
  /** Tags to translate into `queryClient.invalidateQueries` on settle (declared invalidation). */
  invalidatesTags?: Tag[];
}

export function mcpqToolMutationOptions<A extends Record<string, unknown>, R = unknown>(
  client: MCPClient,
  queryClient: QueryClient,
  name: string,
  opts: CallToolOpts<A, R> & McpqToolMutationExtra = {},
) {
  return mutationOptions({
    mutationFn: (args: A) => client.callTool<A, R>(name, args, opts),
    onSettled: () => {
      for (const tag of opts.invalidatesTags ?? []) {
        void queryClient.invalidateQueries({ queryKey: tagToQueryKeyPrefix(tag) as unknown[] });
      }
    },
  });
}
