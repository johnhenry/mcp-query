// Public, framework-agnostic surface.
export { MCPClient } from "./core/client.js";
export type { MCPClientConfig, ReadResourceOpts, CallToolOpts } from "./core/client.js";
export { MCPCache } from "./core/cache.js";
export type { CacheEntry, CachePatch, CacheWriteOpts } from "./core/cache.js";
export { ServerConnection } from "./core/connection.js";
export type { ConnectionConfig } from "./core/connection.js";
export { Router, AmbiguousCapability, CapabilityNotFound } from "./core/router.js";
export { resourceTag, capsTag, serverTag, entityTag } from "./core/tags.js";
export type { Tag } from "./core/tags.js";
export type { CacheKey } from "./core/keys.js";
export { argsHash, serializeKey } from "./core/keys.js";
export type { ServerState, MCPError, HostHandlers, Tool, Resource, Prompt } from "./core/types.js";
