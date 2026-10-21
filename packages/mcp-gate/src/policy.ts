// Standalone entry (`@johnhenry/mcp-gate/policy`): the declarative policy compiler and its
// types, with nothing else loaded. Pure logic, browser-safe.
export type { GatePolicy, GatePolicyRules, ApprovalConfig, ApprovalRequest, PolicyOptions, PolicyScope, PolicyRule, PolicyDecision } from "./config.js";
export { compilePolicy, explainPolicy, policyListAnnotator, policyListFilter } from "./config.js";
