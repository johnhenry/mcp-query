// Pure policy logic — the brains behind the InteractionBroker `policy` callback.
//
// A policy is an ordered list of rules. Each rule matches on interaction type
// and/or server (glob-ish: "*" = any) and yields a verdict (allow/deny/ask).
// The first matching rule wins; if nothing matches we fall back to `fallback`.
//
// This module is intentionally framework-free so it can be unit-tested and reused
// from both the React UI and the broker wiring.

import type { PolicyContext, PolicyVerdict, InteractionType } from "mcp-query";

export type { PolicyVerdict, PolicyContext } from "mcp-query";

/** A single policy rule. "*" matches anything for that dimension. */
export interface PolicyRule {
  /** Stable id for React keys / editing. */
  id: string;
  /** Interaction type to match, or "*" for any. */
  type: InteractionType | "*";
  /** Server name to match, or "*" for any. */
  server: string;
  /** Verdict to apply when this rule matches. */
  verdict: PolicyVerdict;
}

export interface PolicyConfig {
  rules: PolicyRule[];
  /** Verdict when no rule matches. Defaults to "ask" (safest — a human reviews). */
  fallback: PolicyVerdict;
}

export const DEFAULT_POLICY: PolicyConfig = {
  rules: [],
  fallback: "ask",
};

/** True when `pattern` ("*" or an exact string) matches `value`. */
function matches(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === value;
}

/** Does a rule apply to the given interaction context? */
export function ruleMatches(rule: PolicyRule, ctx: { type: InteractionType; server: string }): boolean {
  return matches(rule.type, ctx.type) && matches(rule.server, ctx.server);
}

/**
 * Evaluate a policy config against an interaction context.
 * First matching rule wins; otherwise the fallback verdict is returned.
 */
export function evaluatePolicy(config: PolicyConfig, ctx: PolicyContext): PolicyVerdict {
  for (const rule of config.rules) {
    if (ruleMatches(rule, ctx)) return rule.verdict;
  }
  return config.fallback;
}

/** Build a broker-compatible `policy(ctx)` function from a config object. */
export function makePolicyVerdict(getConfig: () => PolicyConfig): (ctx: PolicyContext) => PolicyVerdict {
  return (ctx) => evaluatePolicy(getConfig(), ctx);
}

// ── persistence (localStorage) ─────────────────────────────────────────────

const STORAGE_KEY = "mcp-query.approvals.policy";

export function loadPolicy(): PolicyConfig {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_POLICY };
    const parsed = JSON.parse(raw) as Partial<PolicyConfig>;
    return {
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      fallback: parsed.fallback ?? "ask",
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function savePolicy(config: PolicyConfig): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore quota / unavailable storage */
  }
}
