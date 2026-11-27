// mcp-contract — contract testing / drift detection for MCP capability surfaces.
// The dual of mcp-query codegen: codegen turns a server into types; mcp-contract
// verifies a server still *honors* those types, classifying every change as
// breaking or compatible with proper input/output variance.

export { diffSchema, type Variance, type SchemaChange, type JSONSchema } from "./schema.js";
export {
  captureContract,
  captureEra,
  cardForContract,
  diffContract,
  upgradeContract,
  SKILLS_EXTENSION,
  DEPRECATED_CAPABILITIES,
  EVENTS_EXTENSION,
  type Contract,
  type ContractV1,
  type ContractIcon,
  type ContractProtocol,
  type ContractCard,
  type ContractCardRemote,
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
export { captureFrom, connectClient, buildTransport, connectFromFlags, connectEra, parseEra, versionNegotiationFor, DEFAULT_ERA, ERA_PROBE_TIMEOUT_MS, ERA_FLAG_HELP, withEra, type ConnectOptions, type Era } from "./connect.js";
export {
  resolveConnect,
  resolveServer,
  loadRegistry,
  listServers,
  addServer,
  removeServer,
  getServer,
  importFrom,
  entryToConnectOptions,
  findProjectConfig,
  expandEnv,
  USER_CONFIG,
  type RegistryEntry,
  type RegistryOptions,
  type ServerListing,
  type Scope,
} from "./registry.js";
export { DEFAULT_CLIENT_METADATA_URL, CLIENT_METADATA_URL_ENV, resolveClientMetadataUrl } from "./clientMetadata.js";
export { dpopSupported, DPOP_MIN_SDK } from "./dpop.js";
export { authenticate, FileOAuthProvider, captureProvider, tokenCachePath, hasCachedAuth, type AuthenticateOptions } from "./oauth.js";
export { parseCallSpec, parseCallExpr, looksLikeCallExpr, splitKeyValue, parseLiteral, type ParsedCall } from "./callspec.js";
export { rejectUnknownFlags } from "./flags.js";
export { coerceArgs, parseAnswers, answerFor, runRounds, describeRequests, InputRequiredError, type PendingRequests } from "./answers.js";
export { mockFromContract } from "./mock.js";
export { usedFromSource } from "./used.js";
export { formatDiff } from "./report.js";
