// Public, framework-agnostic surface.
export { MCPClient } from "./core/client.js";
export type { MCPClientConfig, ReadResourceOpts, CallToolOpts } from "./core/client.js";
export { MCPCache } from "./core/cache.js";
export type { CacheEntry, CachePatch, CacheWriteOpts } from "./core/cache.js";
export { ServerConnection } from "./core/connection.js";
export type { ConnectionConfig } from "./core/connection.js";
export { Router, AmbiguousCapability, CapabilityNotFound } from "./core/router.js";
export { InteractionBroker } from "./core/interactions.js";
export type {
  Interaction,
  InteractionDecision,
  InteractionType,
  InteractionPhase,
  InteractionBrokerOptions,
  PolicyContext,
  PolicyVerdict,
  AuditEntry,
} from "./core/interactions.js";
export { resourceTag, capsTag, serverTag, entityTag } from "./core/tags.js";
export type { Tag } from "./core/tags.js";
export type { CacheKey } from "./core/keys.js";
export { argsHash, serializeKey } from "./core/keys.js";
export type { ServerState, MCPError, HostHandlers, Tool, Resource, Prompt } from "./core/types.js";
export {
  chromeBuiltinAISampling,
  ModelUnavailableError,
  SamplingDeclinedError,
} from "./handlers/chromeAI.js";
export type {
  ChromeSamplingOptions,
  LanguageModelLike,
  PromptSession,
  SamplingRequest,
  SamplingResult,
} from "./handlers/chromeAI.js";
