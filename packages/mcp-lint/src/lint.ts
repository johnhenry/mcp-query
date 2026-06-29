// The linter: run the rule set over a contract, applying per-rule severity overrides.

import type { Contract } from "../../mcp-contract/src/contract.js";
import { RULES, type Severity } from "./rules.js";

export interface Finding {
  rule: string;
  severity: "error" | "warn";
  target: string;
  message: string;
}

export interface LintResult {
  findings: Finding[];
  errors: number;
  warnings: number;
}

export interface LintOptions {
  /** Override a rule's severity by id, e.g. `{ "naming-consistency": "off" }`. */
  rules?: Record<string, Severity>;
}

export function lintContract(contract: Contract, opts: LintOptions = {}): LintResult {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const severity = opts.rules?.[rule.id] ?? rule.defaultSeverity;
    if (severity === "off") continue;
    for (const v of rule.check(contract)) {
      findings.push({ rule: rule.id, severity, target: v.target, message: v.message });
    }
  }
  return {
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
  };
}
