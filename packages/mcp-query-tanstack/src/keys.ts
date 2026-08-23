// queryKey construction + tag->prefix translation for mcp-query. Namespaced
// server-first (["mcp-query", server, ...]) so a blunt server-scoped invalidation's
// prefix (["mcp-query", server]) catches everything beneath it — mirrors mcp-query's own
// bluntest tag, serverTag(server).

import type { Tag } from "@johnhenry/mcp-query";

export const MCP_QUERY_NS = "mcp-query" as const;

export function toolResultQueryKey(server: string, tool: string, argsHash: string): readonly unknown[] {
  return [MCP_QUERY_NS, server, "toolResult", tool, argsHash] as const;
}

export function resourceQueryKey(server: string, uri: string): readonly unknown[] {
  return [MCP_QUERY_NS, server, "resource", uri] as const;
}

export function listQueryKey(server: string, what: "tools" | "resources" | "prompts"): readonly unknown[] {
  const kind = what === "tools" ? "toolList" : what === "resources" ? "resourceList" : "promptList";
  return [MCP_QUERY_NS, server, kind] as const;
}

/**
 * Pure fn: mcp-query Tag -> the queryKey prefix `invalidateQueries` should target.
 * For v1.1 (tag-wide invalidation of TanStack-inactive queries) — not wired to
 * anything yet; see the package README for why v1 doesn't need this at all.
 */
export function tagToQueryKeyPrefix(tag: Tag): readonly unknown[] {
  if (tag.startsWith("res:")) {
    const [, server, ...rest] = tag.split(":");
    return [MCP_QUERY_NS, server, "resource", rest.join(":")];
  }
  if (tag.startsWith("caps:")) {
    const [, server, what] = tag.split(":");
    const kind = what === "tools" ? "toolList" : what === "resources" ? "resourceList" : "promptList";
    return [MCP_QUERY_NS, server, kind];
  }
  if (tag.startsWith("server:")) {
    return [MCP_QUERY_NS, tag.slice("server:".length)]; // blunt: everything from this server
  }
  // entityTag / unrecognized: best-effort, still namespaced.
  return [MCP_QUERY_NS, ...tag.split(":")];
}
