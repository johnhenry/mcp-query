// List-filter interceptor: the chain's answer to the gateway's `filter`/`annotate` options (#90).
//
// `list` operations (the catalog a server advertises) run through the interceptor chain where the
// catalog is fetched, and what the chain returns is what `client.listTools()` / `listResources()` /
// `listPrompts()` / `discover()` show. This interceptor hides items and/or stamps `_meta` on them
// with the same `(server, kind, name)` callbacks `createGateway({ filter, annotate })` takes, so one
// predicate can serve both the client's view and a gateway's `tools/list`. Every other operation
// passes through untouched.

import type { CatalogName, RequestInterceptor } from "../core/interceptors.js";

/** The item kinds the gateway's `filter`/`annotate` use. */
export type ListItemKind = "tool" | "resource" | "prompt";

export interface ListFilterOptions {
  /** Return false to hide an item. `name` is the tool/prompt name or the resource URI. Resource templates are not filtered. */
  keep?: (server: string, kind: ListItemKind, name: string) => boolean;
  /** Extra `_meta` merged onto an item (the item is copied, never mutated). */
  annotate?: (server: string, kind: ListItemKind, name: string) => Record<string, unknown> | undefined;
}

const KIND: Partial<Record<CatalogName, [ListItemKind, string]>> = {
  tools: ["tool", "name"],
  resources: ["resource", "uri"],
  prompts: ["prompt", "name"],
};

/** An interceptor that filters/annotates `list` results; see {@link ListFilterOptions}. */
export function listFilter(opts: ListFilterOptions): RequestInterceptor {
  return async (op, next) => {
    const result = await next(op);
    const spec = op.kind === "list" ? KIND[op.target as CatalogName] : undefined;
    if (!spec || !Array.isArray(result)) return result;
    const [kind, field] = spec;
    const out: unknown[] = [];
    for (const item of result) {
      const name = (item as Record<string, unknown>)[field] as string;
      if (opts.keep && !opts.keep(op.peer, kind, name)) continue;
      const extra = opts.annotate?.(op.peer, kind, name);
      out.push(extra ? { ...(item as object), _meta: { ...((item as { _meta?: Record<string, unknown> })._meta ?? {}), ...extra } } : item);
    }
    return out;
  };
}
