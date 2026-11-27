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

// Skills over MCP (`io.modelcontextprotocol/skills`). Everything lives under
// [ns, server, "skills", ...] so the `skills:<server>` tag (resources list_changed) maps to one prefix.
// `partition` (a `client.scope({ partition })` tenant) is appended only when set: two partitions must
// never share a TanStack entry.
const part = (partition?: string): readonly unknown[] => (partition === undefined ? [] : ["@partition", partition]);

export function skillsQueryKey(server: string, partition?: string): readonly unknown[] {
  return [MCP_QUERY_NS, server, "skills", "list", ...part(partition)] as const;
}

export function skillQueryKey(server: string, uri: string, partition?: string): readonly unknown[] {
  return [MCP_QUERY_NS, server, "skills", "get", uri, ...part(partition)] as const;
}

/** `digest` is the manifest digest of the file ("dynamic" for a skill whose files are unlisted). */
export function skillFileQueryKey(server: string, uri: string, digest: string, partition?: string): readonly unknown[] {
  return [MCP_QUERY_NS, server, "skills", "file", uri, digest, ...part(partition)] as const;
}

/**
 * Pure fn: mcp-query Tag -> the queryKey prefix `invalidateQueries` should target.
 * Used by the bridge (via `cache.onExternalInvalidate`) for tag-wide invalidation of
 * TanStack-inactive queries that have no live per-key subscription.
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
  if (tag.startsWith("skills:")) {
    return [MCP_QUERY_NS, tag.slice("skills:".length), "skills"]; // list + every get beneath it
  }
  if (tag.startsWith("server:")) {
    return [MCP_QUERY_NS, tag.slice("server:".length)]; // blunt: everything from this server
  }
  // entityTag / unrecognized: best-effort, still namespaced.
  return [MCP_QUERY_NS, ...tag.split(":")];
}
