// Shared tool-call spec parsing for the CLIs. Two accepted spellings:
//
//   colon + JSON      echo:'{"message":"hi"}'
//   function-call     'echo(message: "hi", n: 2)'
//
// `mcp-query call` historically used the function-call form while `mcp-bench --call` /
// `mcp-record --call` used colon+JSON — every CLI now accepts both. The parser lives
// here (not in packages/cli) because the dependency direction is cli → tools, and
// mcp-contract is the de-facto shared library for the tool CLIs.

export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

/** Does `s` look like a `name(...)` function-call expression? */
export function looksLikeCallExpr(s: string): boolean {
  return /^\s*[A-Za-z_][\w.-]*\s*\(/.test(s);
}

/**
 * Parse a `name(a: 1, b: "x", c: true, d: [1,2])` function-call string into `{ name, args }`.
 * Values are parsed as JSON where possible (so numbers/booleans/objects keep their type);
 * bareword values fall back to strings. Returns undefined if `s` isn't a call expression.
 */
export function parseCallExpr(s: string): ParsedCall | undefined {
  const m = /^\s*([A-Za-z_][\w.-]*)\s*\(([\s\S]*)\)\s*$/.exec(s);
  if (!m) return undefined;
  const name = m[1]!;
  const inner = m[2]!.trim();
  const args: Record<string, unknown> = {};
  if (!inner) return { name, args };
  for (const part of splitTopLevel(inner)) {
    const eq = splitKeyValue(part);
    if (!eq) continue;
    args[eq.key] = parseLiteral(eq.value);
  }
  return { name, args };
}

/** Split on top-level commas, respecting quotes and bracket/brace nesting. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      buf += c;
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** Split `key: value` or `key=value` on the first top-level separator. */
export function splitKeyValue(part: string): { key: string; value: string } | undefined {
  const trimmed = part.trim();
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (quote) {
      if (c === quote && trimmed[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
    else if (depth === 0 && (c === ":" || c === "=")) {
      return { key: trimmed.slice(0, i).trim(), value: trimmed.slice(i + 1).trim() };
    }
  }
  return undefined;
}

/** Parse a single literal: JSON if it parses, else a bareword/quoted string. */
export function parseLiteral(v: string): unknown {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const body = s.slice(1, -1);
    try {
      return JSON.parse(`"${body.replace(/"/g, '\\"')}"`);
    } catch {
      return body;
    }
  }
  try {
    return JSON.parse(s);
  } catch {
    return s; // bareword → string (the caller may retype it from a schema)
  }
}

/**
 * Parse a `--call` spec in EITHER accepted form:
 *   • colon + JSON:    `tool:{"arg":"value"}`  (bare `tool` = no args)
 *   • function-call:   `tool(arg: value, …)`
 * Throws (naming both forms) when the spec parses as neither.
 */
export function parseCallSpec(spec: string): ParsedCall {
  const trimmed = spec.trim();
  if (looksLikeCallExpr(trimmed)) {
    const parsed = parseCallExpr(trimmed);
    if (parsed) return parsed;
    throw invalidCallSpec(spec);
  }
  const i = trimmed.indexOf(":");
  if (i === -1) {
    // bare tool name → call with no arguments (long-standing bench/record behavior)
    if (/^[A-Za-z_][\w.-]*$/.test(trimmed)) return { name: trimmed, args: {} };
    throw invalidCallSpec(spec);
  }
  const name = trimmed.slice(0, i);
  try {
    const args = JSON.parse(trimmed.slice(i + 1)) as unknown;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be a JSON object");
    return { name, args: args as Record<string, unknown> };
  } catch {
    throw invalidCallSpec(spec);
  }
}

function invalidCallSpec(spec: string): Error {
  return new Error(
    `invalid call spec ${JSON.stringify(spec)} — use colon+JSON 'tool:{"arg":"value"}' or a function-call string 'tool(arg: "value", …)'`,
  );
}
