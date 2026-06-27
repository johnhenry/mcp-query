// Public, framework-agnostic surface.
export { MCPClient } from "./core/client.js";
export type {
  MCPClientConfig,
  ReadResourceOpts,
  CallToolOpts,
  QueryToolOpts,
  RequestTimeoutOpts,
} from "./core/client.js";
export {
  isReadOnly,
  isDestructive,
  isIdempotent,
  contentAnnotations,
  structuredContent,
  isToolError,
} from "./core/annotations.js";
export { MCPCache, structuralEqual } from "./core/cache.js";
export type { CacheEntry, CachePatch, CacheWriteOpts } from "./core/cache.js";
export { persistCache } from "./core/persist.js";
export type { SyncStorage, PersistOptions } from "./core/persist.js";
export { instrumentTransport } from "./core/instrument.js";
export type { TrafficEvent, TrafficDirection } from "./core/instrument.js";
export { instrumentAuthProvider } from "./core/authDebug.js";
export type { AuthStep } from "./core/authDebug.js";
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
export type { ServerState, MCPError, HostHandlers, Tool, Resource, Prompt, ClientInfo } from "./core/types.js";
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
