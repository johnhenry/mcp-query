// DLP redaction — a RequestInterceptor that rewrites matching substrings in every result
// (tool content, resource text, structured output) before it reaches the agent. This is
// the one piece the gate adds beyond mcp-query's stock interceptors.

import { isInputRequiredResult, type RequestInterceptor } from "@johnhenry/mcp-query";

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
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value; // raw bytes: see redact() for skill files
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, rules);
    return out;
  }
  return value;
}

function redactTrackedDeep(value: unknown, rules: Compiled[], path: string, changed: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of rules) s = s.replace(r.re, r.replacement);
    if (s !== value) changed.push(path);
    return s;
  }
  if (Array.isArray(value)) return value.map((v, i) => redactTrackedDeep(v, rules, `${path}[${i}]`, changed));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactTrackedDeep(v, rules, path ? `${path}.${k}` : k, changed);
    return out;
  }
  return value;
}

/**
 * Like `redactValue`, but also reports WHERE it changed something: dotted paths (`q0.content.token`,
 * `a[2]`), never the values. For audit trails that must say what was scrubbed without leaking it.
 */
export function redactTracked<T = unknown>(rules: RedactRule[], value: T, options?: RedactOptions): { value: T; paths: string[] } {
  const paths: string[] = [];
  const out = redactTrackedDeep(value, compile(rules, options), "", paths) as T;
  return { value: out, paths };
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
  return async (op, next) => {
    const result = await next(op);
    // Catalog views are not content (a pattern must not rewrite a tool name the router resolves).
    if (op.kind === "list") return result;
    // A verified skill file: scrub its text, and drop the (now different) bytes' claim to be verified.
    if (op.kind === "skill" && result && typeof result === "object" && (result as { bytes?: unknown }).bytes instanceof Uint8Array) {
      const file = result as { bytes: Uint8Array; text?: string; body?: string };
      const scrubbed = redactDeep({ ...file, bytes: undefined }, compiled) as Record<string, unknown>;
      const changed = scrubbed.text !== file.text || scrubbed.body !== file.body;
      return { ...scrubbed, bytes: changed && typeof scrubbed.text === "string" ? new TextEncoder().encode(scrubbed.text) : file.bytes, ...(changed ? { verified: false } : {}) };
    }
    // An MRTR `input_required` round: redact what the consumer will be shown (`inputRequests`)
    // but never `requestState` -- it is opaque upstream state echoed byte-for-byte on retry.
    if (isInputRequiredResult(result)) {
      return result.inputRequests ? { ...result, inputRequests: redactDeep(result.inputRequests, compiled) } : result;
    }
    return redactDeep(result, compiled);
  };
}
