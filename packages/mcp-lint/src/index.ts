// mcp-lint — "ESLint for MCP servers". Quality-lint a capability surface against a set of
// design rules (descriptions, annotations, typed inputs, naming). Complements mcp-contract:
// lint = absolute quality of one surface; contract = incompatible drift between two.

export { RULES, type Rule, type Severity } from "./rules.js";
export { lintContract, type Finding, type LintResult, type LintOptions } from "./lint.js";
export { formatLint } from "./report.js";
export { LIVE_RULES, runProbes, type LiveRule, type ProbeClient, type ProbeFinding, type ProbeViolation } from "./probes.js";
