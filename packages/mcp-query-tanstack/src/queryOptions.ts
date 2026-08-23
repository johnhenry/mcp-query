// queryOptions() factories bridging mcp-query's own reads into TanStack Query.
// Sync propagation (attachMcpqSync, in bridge.ts) is what actually keeps a
// bridged query's TanStack cache entry fresh on protocol push / optimistic
// patch — the queryFn here only supplies the FIRST fetch + the type-safe
// queryKey/queryFn pairing queryOptions() exists for.

import { queryOptions, type UseQueryOptions } from "@tanstack/react-query";
import { argsHash, type CallToolOpts, type MCPClient, type QueryToolOpts, type ReadResourceOpts, type Tool } from "@johnhenry/mcp-query";
import { listQueryKey, resourceQueryKey, toolResultQueryKey } from "./keys.js";
import { ensureSynced } from "./bridge.js";

/**
 * Bridges a READ-ONLY tool (annotated `readOnlyHint`) as a query — the
 * TanStack-side analog of mcp-query's own `useToolResult` hook. Do not use for
 * side-effecting tool calls; see `mcpqToolMutationOptions` for those.
 */
export function mcpqToolQueryOptions<A extends Record<string, unknown>, R = unknown>(
  client: MCPClient,
  name: string,
  args: A,
  opts: QueryToolOpts & Partial<UseQueryOptions<R>> = {},
) {
  const server = opts.server ?? resolveServer(client, name);
  const tool = bareName(name);
  const hash = argsHash(args);
  const key = toolResultQueryKey(server, tool, hash);
  return queryOptions<R>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "toolResult", server, tool, argsHash: hash }, key);
      return client.queryTool<A, R>(name, args, opts);
    },
  });
}

/** Bridges `readResource` as a query. */
export function mcpqResourceQueryOptions<T = unknown>(
  client: MCPClient,
  uri: string,
  opts: ReadResourceOpts & Partial<UseQueryOptions<T>> = {},
) {
  const server = opts.server ?? resolveResourceServer(client, uri);
  const key = resourceQueryKey(server, uri);
  return queryOptions<T>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "resource", server, uri }, key);
      return client.readResource(uri, opts) as Promise<T>;
    },
  });
}

/** Bridges a server's tool list as a query. */
export function mcpqToolListQueryOptions(client: MCPClient, server: string, opts: Partial<UseQueryOptions<Tool[]>> = {}) {
  const key = listQueryKey(server, "tools");
  return queryOptions<Tool[]>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "toolList", server }, key);
      return client.listTools(server);
    },
  });
}

function bareName(name: string): string {
  return name.includes(".") ? name.split(".").slice(1).join(".") : name;
}

function resolveServer(client: MCPClient, name: string): string {
  if (name.includes(".")) return name.split(".")[0]!;
  for (const c of client.connections()) if (c.tools.has(name)) return c.name;
  return "default";
}

function resolveResourceServer(client: MCPClient, uri: string): string {
  for (const c of client.connections()) if (client.listResources(c.name).some((r) => r.uri === uri)) return c.name;
  return "default";
}
