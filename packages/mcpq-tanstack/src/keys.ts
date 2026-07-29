// queryKey construction + tag->prefix translation for mcpq. Namespaced
// server-first (["mcpq", server, ...]) so a blunt server-scoped invalidation's
// prefix (["mcpq", server]) catches everything beneath it — mirrors mcpq's own
// bluntest tag, serverTag(server).

import type { Tag } from "@johnhenry/mcpq";

export const MCPQ_NS = "mcpq" as const;

export function toolResultQueryKey(server: string, tool: string, argsHash: string): readonly unknown[] {
  return [MCPQ_NS, server, "toolResult", tool, argsHash] as const;
}

export function resourceQueryKey(server: string, uri: string): readonly unknown[] {
  return [MCPQ_NS, server, "resource", uri] as const;
}

export function listQueryKey(server: string, what: "tools" | "resources" | "prompts"): readonly unknown[] {
  const kind = what === "tools" ? "toolList" : what === "resources" ? "resourceList" : "promptList";
  return [MCPQ_NS, server, kind] as const;
}

/**
 * Pure fn: mcpq Tag -> the queryKey prefix `invalidateQueries` should target.
 * For v1.1 (tag-wide invalidation of TanStack-inactive queries) — not wired to
 * anything yet; see the package README for why v1 doesn't need this at all.
 */
export function tagToQueryKeyPrefix(tag: Tag): readonly unknown[] {
  if (tag.startsWith("res:")) {
    const [, server, ...rest] = tag.split(":");
    return [MCPQ_NS, server, "resource", rest.join(":")];
  }
  if (tag.startsWith("caps:")) {
    const [, server, what] = tag.split(":");
    const kind = what === "tools" ? "toolList" : what === "resources" ? "resourceList" : "promptList";
    return [MCPQ_NS, server, kind];
  }
  if (tag.startsWith("server:")) {
    return [MCPQ_NS, tag.slice("server:".length)]; // blunt: everything from this server
  }
  // entityTag / unrecognized: best-effort, still namespaced.
  return [MCPQ_NS, ...tag.split(":")];
}
