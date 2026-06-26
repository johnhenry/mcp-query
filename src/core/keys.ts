// Cache keys — TanStack Query's model: every cacheable thing is a *document*
// under a structured, serializable key. No normalization, no entity graph.

import type { ListKind } from "./types.js";

export type CacheKey =
  | { kind: "resource"; server: string; uri: string }
  | { kind: "resourceList"; server: string }
  | { kind: "templateList"; server: string }
  | { kind: "toolList"; server: string }
  | { kind: "promptList"; server: string }
  | { kind: "toolResult"; server: string; tool: string; argsHash: string }
  | { kind: "prompt"; server: string; name: string; argsHash: string };

/**
 * Stable string form, used only as a Map key and a devtools label. Code never
 * parses this back — the structured CacheKey is carried on each cache entry.
 */
export function serializeKey(k: CacheKey): string {
  switch (k.kind) {
    case "resource":
      return `resource ${k.server} ${k.uri}`;
    case "toolResult":
      return `toolResult ${k.server} ${k.tool} ${k.argsHash}`;
    case "prompt":
      return `prompt ${k.server} ${k.name} ${k.argsHash}`;
    default:
      return `${k.kind} ${k.server}`;
  }
}

export function listKeyFor(server: string, what: ListKind): CacheKey {
  return what === "tools"
    ? { kind: "toolList", server }
    : what === "resources"
      ? { kind: "resourceList", server }
      : { kind: "promptList", server };
}

/** Stable, order-independent stringification for hashing tool/prompt arguments. */
export function argsHash(args: unknown): string {
  return stableStringify(args ?? null);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
