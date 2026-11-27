// The linter: run the rule set over a contract, applying per-rule severity overrides.

import type { Contract } from "../../mcp-contract/src/contract.js";
import { RULES, isModern, type Severity } from "./rules.js";

export interface Finding {
  rule: string;
  severity: "error" | "warn";
  target: string;
  message: string;
  /** Set on findings from live probes (`--probe`); contract-only findings leave it unset. */
  probe?: true;
}

/** A rule that did not run, and why (never a pass: the capture could not answer the question). */
export interface SkippedRule {
  rule: string;
  reason: string;
}

export interface LintResult {
  findings: Finding[];
  /** Rules not evaluated because the capture lacks what they inspect (a legacy-era capture has no cache hints). */
  skipped?: SkippedRule[];
  errors: number;
  warnings: number;
}

export interface LintOptions {
  /** Override a rule's severity by id, e.g. `{ "naming-consistency": "off" }`. */
  rules?: Record<string, Severity>;
}

export function lintContract(contract: Contract, opts: LintOptions = {}): LintResult {
  const findings: Finding[] = [];
  const skipped: SkippedRule[] = [];
  for (const rule of RULES) {
    const severity = opts.rules?.[rule.id] ?? rule.defaultSeverity;
    if (severity === "off") continue;
    if (rule.modernOnly && !isModern(contract)) {
      const era = contract.protocol?.era === "legacy" ? "the legacy initialize handshake" : "no recorded handshake era";
      skipped.push({ rule: rule.id, reason: `not evaluated: this capture used ${era}, which carries no cache hints; capture with --era auto against a 2026-07-28 server to check it` });
      continue;
    }
    for (const v of rule.check(contract)) {
      findings.push({ rule: rule.id, severity, target: v.target, message: v.message });
    }
  }
  return {
    findings,
    ...(skipped.length ? { skipped } : {}),
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
  };
}
