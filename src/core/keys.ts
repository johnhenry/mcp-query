// Cache keys — TanStack Query's model: every cacheable thing is a *document*
// under a structured, serializable key. No normalization, no entity graph.

import type { ListKind } from "./types.js";

/**
 * Optional cache namespace, e.g. a tenant/session id, so one shared client can
 * isolate entries across principals (server-side / multi-tenant use). Omitted in the
 * single-user (browser) case, which keeps keys byte-identical to before.
 */
type Partitioned = { partition?: string };

export type CacheKey =
  | ({ kind: "resource"; server: string; uri: string } & Partitioned)
  | ({ kind: "resourceList"; server: string } & Partitioned)
  | ({ kind: "templateList"; server: string } & Partitioned)
  | ({ kind: "toolList"; server: string } & Partitioned)
  | ({ kind: "promptList"; server: string } & Partitioned)
  | ({ kind: "toolResult"; server: string; tool: string; argsHash: string } & Partitioned)
  | ({ kind: "prompt"; server: string; name: string; argsHash: string } & Partitioned);

/**
 * Stable string form, used only as a Map key and a devtools label. Code never
 * parses this back — the structured CacheKey is carried on each cache entry.
 */
export function serializeKey(k: CacheKey): string {
  const p = k.partition ? `@${k.partition} ` : ""; // absent → identical to pre-partition keys
  switch (k.kind) {
    case "resource":
      return `${p}resource ${k.server} ${k.uri}`;
    case "toolResult":
      return `${p}toolResult ${k.server} ${k.tool} ${k.argsHash}`;
    case "prompt":
      return `${p}prompt ${k.server} ${k.name} ${k.argsHash}`;
    default:
      return `${p}${k.kind} ${k.server}`;
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
