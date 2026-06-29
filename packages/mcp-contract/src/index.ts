// mcp-contract — contract testing / drift detection for MCP capability surfaces.
// The dual of mcp-query codegen: codegen turns a server into types; mcp-contract
// verifies a server still *honors* those types, classifying every change as
// breaking or compatible with proper input/output variance.

export { diffSchema, type Variance, type SchemaChange, type JSONSchema } from "./schema.js";
export {
  captureContract,
  diffContract,
  type Contract,
  type ContractTool,
  type ContractResource,
  type ContractTemplate,
  type ContractPrompt,
  type ContractChange,
  type ContractDiff,
  type DiffOptions,
} from "./contract.js";
export { captureFrom, buildTransport, connectFromFlags, type ConnectOptions } from "./connect.js";
export { authenticate, FileOAuthProvider, captureProvider, tokenCachePath, hasCachedAuth, type AuthenticateOptions } from "./oauth.js";
export { mockFromContract } from "./mock.js";
export { usedFromSource } from "./used.js";
export { formatDiff } from "./report.js";
