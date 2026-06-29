// Consumer-driven scoping helper: infer which contract symbols a consumer actually
// uses by scanning source text for their names. Pair with diffContract({ used }) so
// `verify` only fails on drift that would break *this* consumer — the provider can
// churn anything unreferenced. Cheap and conservative: a name counts as "used" if it
// appears as a quoted string literal anywhere in the source.

import type { Contract } from "./contract.js";

/** Return the contract ids (tool/prompt names, resource/template uris) referenced in `source`. */
export function usedFromSource(source: string, contract: Contract): string[] {
  const ids = [
    ...contract.tools.map((t) => t.name),
    ...contract.prompts.map((p) => p.name),
    ...contract.resources.map((r) => r.uri),
    ...contract.templates.map((t) => t.uriTemplate),
  ];
  const quoted = new Set<string>();
  // Collect every quoted string literal once, then intersect with known ids — avoids
  // false positives from short ids appearing inside unrelated identifiers.
  for (const m of source.matchAll(/['"`]([^'"`]+)['"`]/g)) quoted.add(m[1]!);
  return ids.filter((id) => quoted.has(id));
}
