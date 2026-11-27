// `@johnhenry/mcp-query/discovery` — Server Cards (SEP-2127) and AI Catalog discovery.
// Fetches are hardened (https, size cap, timeout, same-origin redirects, content-type check)
// and everything returned is untrusted display data: nothing is registered or connected.

export {
  AI_CATALOG_MEDIA_TYPE,
  AI_CATALOG_WELL_KNOWN_PATH,
  AiCatalogEntryShape,
  AiCatalogSchema,
  SERVER_CARD_ENTRY_TYPE,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_PATH_SUFFIX,
  SERVER_CARD_SCHEMA_URI,
  ServerCardSchema,
  type AiCatalog,
  type AiCatalogEntry,
  type ServerCard,
  type ServerCardInput,
  type ServerCardRemote,
} from "./schemas.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  DiscoveryError,
  assertFetchableUrl,
  isLoopbackHost,
  safeFetchJson,
  type DiscoveryErrorCode,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./safeFetch.js";
export {
  compareCardToLive,
  connectableRemoteUrl,
  discoverFromCatalogUrl,
  discoverFromDomain,
  fetchServerCard,
  normalizeDomain,
  parseServerCard,
  recommendedCardUrl,
  resolveRemote,
  sanitizeForDisplay,
  selectRemote,
  type CardFinding,
  type DiscoveredEntry,
  type DiscoverFromDomainOptions,
  type DiscoveryOptions,
  type DomainDiscovery,
  type FetchedServerCard,
  type LiveServerFacts,
  type ResolvedRemote,
} from "./discovery.js";
