// DLP redaction — a RequestInterceptor that rewrites matching substrings in every result
// (tool content, resource text, structured output) before it reaches the agent. This is
// the one piece the gate adds beyond mcp-query's stock interceptors.

import type { RequestInterceptor } from "@johnhenry/mcp-query";

export interface RedactRule {
  /** A RegExp (use the `g` flag) or a string compiled to a global RegExp. */
  pattern: RegExp | string;
  /** Replacement. Default "[REDACTED]" (or `RedactOptions.defaultReplacement`). */
  replacement?: string;
  /**
   * RegExp flags (`g`, `i`, `m`, `s`, `u`, ...). Replaces a RegExp pattern's own flags; `g` is
   * always added (rules are global). Validated with `new RegExp` by `validateGateConfig`.
   */
  flags?: string;
}

export interface RedactOptions {
  /** Replacement for rules without their own `replacement`. Default "[REDACTED]". */
  defaultReplacement?: string;
}

interface Compiled {
  re: RegExp;
  replacement: string;
}

function compile(rules: RedactRule[], options?: RedactOptions): Compiled[] {
  const fallback = options?.defaultReplacement ?? "[REDACTED]";
  return rules.map((r) => {
    const source = typeof r.pattern === "string" ? r.pattern : r.pattern.source;
    let re: RegExp;
    if (r.flags !== undefined) re = new RegExp(source, r.flags.includes("g") ? r.flags : r.flags + "g");
    else re = typeof r.pattern === "string" ? new RegExp(source, "g") : r.pattern;
    return { re, replacement: r.replacement ?? fallback };
  });
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

/**
 * Redact a value (string, array, plain object, nested) with the same rules the `redact`
 * interceptor applies to results. Pure and synchronous: e.g. scrub a recorded cassette or a
 * log payload before it is stored (#65).
 */
export function redactValue<T = unknown>(rules: RedactRule[], value: T, options?: RedactOptions): T {
  return redactDeep(value, compile(rules, options)) as T;
}

export function redact(rules: RedactRule[], options?: RedactOptions): RequestInterceptor {
  const compiled = compile(rules, options);
  return async (op, next) => redactDeep(await next(op), compiled);
}
