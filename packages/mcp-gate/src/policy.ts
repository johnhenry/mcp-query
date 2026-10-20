// Standalone entry (`@johnhenry/mcp-gate/policy`): the declarative policy compiler and its
// types, with nothing else loaded. Pure logic, browser-safe.
export type { GatePolicy, GatePolicyRules, ApprovalConfig, ApprovalRequest } from "./config.js";
export { compilePolicy, policyListAnnotator, policyListFilter } from "./config.js";
