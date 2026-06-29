// JSON Schema variance/subtyping engine — the valuable, reusable core of mcp-contract.
//
// MCP tool inputs and outputs are JSON Schemas. Whether a schema change is *breaking*
// depends on direction (variance):
//   • input  is CONTRAVARIANT — the provider may safely accept MORE than before
//     (widen). Accepting LESS (narrow) or demanding more (new required) breaks callers.
//   • output is COVARIANT — the provider must keep producing AT LEAST what it did
//     (so consumers' reads stay valid). Producing less, or widening a value's type,
//     breaks consumers.
//
// We classify each leaf change as "breaking" or "compatible" under the given variance.

export type Variance = "in" | "out";

export interface SchemaChange {
  /** Dotted path to the changed node, e.g. `properties.user.id`. */
  path: string;
  level: "breaking" | "compatible";
  detail: string;
}

export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JSONSchema;
}

function typeOf(s: JSONSchema): string | undefined {
  return Array.isArray(s.type) ? s.type[0] : s.type;
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** Diff two JSON Schemas under a variance, returning every classified change. */
export function diffSchema(
  prev: JSONSchema | undefined,
  next: JSONSchema | undefined,
  variance: Variance,
  path = "",
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  if (!prev || !next) return changes; // can't say anything useful about a missing side here

  diffType(prev, next, variance, path, changes);
  diffEnum(prev, next, variance, path, changes);
  diffObject(prev, next, variance, path, changes);
  if (typeOf(prev) === "array" && typeOf(next) === "array") {
    changes.push(...diffSchema(prev.items, next.items, variance, join(path, "items")));
  }
  return changes;
}

function diffType(prev: JSONSchema, next: JSONSchema, variance: Variance, path: string, out: SchemaChange[]): void {
  const a = typeOf(prev);
  const b = typeOf(next);
  if (!a || !b || a === b) return;

  // integer ⊂ number: integer is the narrower (smaller accepted/produced) set.
  const numeric = (t: string) => t === "number" || t === "integer";
  if (numeric(a) && numeric(b)) {
    const narrowed = a === "number" && b === "integer"; // accepted/produced set shrank
    const level = (variance === "in" ? narrowed : !narrowed) ? "breaking" : "compatible";
    out.push({ path, level, detail: `type ${a} → ${b}` });
    return;
  }
  out.push({ path, level: "breaking", detail: `type ${a} → ${b} (incompatible)` });
}

function diffEnum(prev: JSONSchema, next: JSONSchema, variance: Variance, path: string, out: SchemaChange[]): void {
  const pe = prev.enum;
  const ne = next.enum;
  if (!pe && !ne) return;

  // enum removed → widened to base type; enum added → narrowed from base type.
  if (pe && !ne) {
    out.push({ path, level: variance === "in" ? "compatible" : "breaking", detail: "enum constraint removed (widened)" });
    return;
  }
  if (!pe && ne) {
    out.push({ path, level: variance === "in" ? "breaking" : "compatible", detail: "enum constraint added (narrowed)" });
    return;
  }
  const prevSet = new Set(pe!.map((v) => JSON.stringify(v)));
  const nextSet = new Set(ne!.map((v) => JSON.stringify(v)));
  const added = [...nextSet].filter((v) => !prevSet.has(v));
  const removed = [...prevSet].filter((v) => !nextSet.has(v));
  // in: removing accepted values breaks callers. out: adding produced values breaks consumers.
  if (variance === "in" && removed.length) out.push({ path, level: "breaking", detail: `enum no longer accepts ${removed.join(", ")}` });
  if (variance === "in" && added.length && !removed.length) out.push({ path, level: "compatible", detail: `enum also accepts ${added.join(", ")}` });
  if (variance === "out" && added.length) out.push({ path, level: "breaking", detail: `enum may now produce ${added.join(", ")}` });
  if (variance === "out" && removed.length && !added.length) out.push({ path, level: "compatible", detail: `enum no longer produces ${removed.join(", ")}` });
}

function diffObject(prev: JSONSchema, next: JSONSchema, variance: Variance, path: string, out: SchemaChange[]): void {
  const pp = prev.properties;
  const np = next.properties;
  if (!pp && !np) return;
  const prevProps = pp ?? {};
  const nextProps = np ?? {};
  const prevReq = new Set(prev.required ?? []);
  const nextReq = new Set(next.required ?? []);
  const keys = new Set([...Object.keys(prevProps), ...Object.keys(nextProps)]);

  for (const key of keys) {
    const p = join(path, `properties.${key}`);
    const inPrev = key in prevProps;
    const inNext = key in nextProps;

    if (inPrev && !inNext) {
      // removed property — safe for input (provider stops reading it), breaks output reads.
      out.push({ path: p, level: variance === "in" ? "compatible" : "breaking", detail: "property removed" });
      continue;
    }
    if (!inPrev && inNext) {
      // added property — for input, a new REQUIRED field breaks callers; output adds are safe.
      const requiredNow = variance === "in" && nextReq.has(key);
      out.push({ path: p, level: requiredNow ? "breaking" : "compatible", detail: requiredNow ? "new required property" : "new optional property" });
      continue;
    }
    // present in both — required transitions, then recurse.
    if (variance === "in" && !prevReq.has(key) && nextReq.has(key)) {
      out.push({ path: p, level: "breaking", detail: "became required" });
    } else if (variance === "out" && prevReq.has(key) && !nextReq.has(key)) {
      out.push({ path: p, level: "breaking", detail: "no longer guaranteed (was required)" });
    }
    out.push(...diffSchema(prevProps[key], nextProps[key], variance, p));
  }
}
