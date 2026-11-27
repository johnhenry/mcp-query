// Browser-safe subset of mcp-contract. Resolved in place of ./index.ts by bundlers that set the
// `browser` export condition (Vite, webpack, esbuild --platform=browser do this by default for
// a client build; see the `browser` key under `.` in package.json).
//
// Pure contract logic only: capture from an already-connected `Client`, diff, upgrade, report,
// schema variance, call-spec parsing and the contract-backed mock. The Node-only modules
// (./connect.ts stdio transports, ./registry.ts and ./oauth.ts file access, ./cli.ts) are
// deliberately NOT re-exported; test/browser.test.ts bundles this file for a browser platform
// and fails if any `node:` builtin or Node-only package is pulled in.
export { diffSchema, type Variance, type SchemaChange, type JSONSchema } from "./schema.js";
export {
  captureContract,
  diffContract,
  upgradeContract,
  SKILLS_EXTENSION,
  DEPRECATED_CAPABILITIES,
  EVENTS_EXTENSION,
  type Contract,
  type ContractV1,
  type ContractIcon,
  type ContractProtocol,
  type ContractCacheHints,
  type CacheHint,
  type ContractSkill,
  type ContractSkillFile,
  type ContractEvent,
  type ContractExtensionSettings,
  type ChangeCategory,
  type ChangeLevel,
  type ContractTool,
  type ContractResource,
  type ContractTemplate,
  type ContractPrompt,
  type ContractChange,
  type ContractDiff,
  type DiffOptions,
} from "./contract.js";
export { parseCallSpec, parseCallExpr, looksLikeCallExpr, splitKeyValue, parseLiteral, type ParsedCall } from "./callspec.js";
export { rejectUnknownFlags } from "./flags.js";
export { mockFromContract } from "./mock.js";
export { usedFromSource } from "./used.js";
export { formatDiff } from "./report.js";
