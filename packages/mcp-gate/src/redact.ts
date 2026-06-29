// DLP redaction — a RequestInterceptor that rewrites matching substrings in every result
// (tool content, resource text, structured output) before it reaches the agent. This is
// the one piece the gate adds beyond mcp-query's stock interceptors.

import type { RequestInterceptor } from "../../mcp-query/src/index.js";

export interface RedactRule {
  /** A RegExp (use the `g` flag) or a string compiled to a global RegExp. */
  pattern: RegExp | string;
  /** Replacement. Default "[REDACTED]". */
  replacement?: string;
}

interface Compiled {
  re: RegExp;
  replacement: string;
}

function compile(rules: RedactRule[]): Compiled[] {
  return rules.map((r) => ({
    re: typeof r.pattern === "string" ? new RegExp(r.pattern, "g") : r.pattern,
    replacement: r.replacement ?? "[REDACTED]",
  }));
}

function redactDeep(value: unknown, rules: Compiled[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of rules) s = s.replace(r.re, r.replacement);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, rules));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, rules);
    return out;
  }
  return value;
}

export function redact(rules: RedactRule[]): RequestInterceptor {
  const compiled = compile(rules);
  return async (op, next) => redactDeep(await next(op), compiled);
}
