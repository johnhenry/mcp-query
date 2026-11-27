// Zod schemas for Server Cards (SEP-2127) and the AI Catalog envelope that points at them.
//
// Sources (read in full, see the PR description for exact revisions):
//   - Server Card shape: modelcontextprotocol/experimental-ext-server-card `schema.ts`
//     (the SEP names it the single source of truth). Required: `$schema`, `name`,
//     `version`, `description`. Everything else optional. Unknown members are kept
//     (extension repo: `_meta` and namespaced vendor data are expected).
//   - Catalog + entry shape: Agent-Card/ai-catalog `specification/ai-catalog.md`
//     (release candidate, `specVersion` "0.9"; MCP's discovery doc examples use "1.0").
//
// Everything parsed here is UNTRUSTED display data: a card is fetched before the
// client connects and is advisory, never authoritative for security decisions.

import * as z from "zod";

/** Media type of a Server Card (extension repo `docs/discovery.md`). */
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
/** Media type of an AI Catalog (AI Catalog spec, "Media Type"). */
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";
/** Catalog entry `type` that marks an MCP Server Card. */
export const SERVER_CARD_ENTRY_TYPE = SERVER_CARD_MEDIA_TYPE;
/** Domain-level discovery location (RFC 8615), relative to the domain root. */
export const AI_CATALOG_WELL_KNOWN_PATH = "/.well-known/ai-catalog.json";
/** Suffix MCP reserves for hosting a card next to its streamable-HTTP endpoint. */
export const SERVER_CARD_PATH_SUFFIX = "/server-card";
/** The only `$schema` value a v1 card may carry. */
export const SERVER_CARD_SCHEMA_URI = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

const IconSchema = z.looseObject({
  src: z.string(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

const RepositorySchema = z.looseObject({
  url: z.string(),
  source: z.string(),
  subfolder: z.string().optional(),
  id: z.string().optional(),
});

const InputSchema = z.looseObject({
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  format: z.enum(["string", "number", "boolean", "filepath"]).optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

const KeyValueInputSchema = InputSchema.extend({
  name: z.string(),
  variables: z.record(z.string(), InputSchema).optional(),
});

const RemoteSchema = z.looseObject({
  type: z.enum(["streamable-http", "sse"]),
  /** URL template: `https://…`, `http://…`, or starting with a `{variable}`. */
  url: z.string().regex(/^(https?:\/\/\S+|\{[a-zA-Z_][a-zA-Z0-9_]*\}\S*)$/),
  headers: z.array(KeyValueInputSchema).optional(),
  variables: z.record(z.string(), InputSchema).optional(),
  supportedProtocolVersions: z.array(z.string()).optional(),
});

export const ServerCardSchema = z.looseObject({
  $schema: z.string().regex(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/v1\/server-card\.schema\.json$/),
  /** Reverse-DNS name with exactly one slash, e.g. `com.example/weather`. */
  name: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
  version: z.string().max(255),
  description: z.string().min(1).max(100),
  title: z.string().min(1).max(100).optional(),
  websiteUrl: z.string().optional(),
  repository: RepositorySchema.optional(),
  icons: z.array(IconSchema).optional(),
  remotes: z.array(RemoteSchema).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
  /** Added on the extension repo's `main` after the SEP snapshot; informational only. */
  extensionsInfo: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type ServerCard = z.infer<typeof ServerCardSchema>;
export type ServerCardRemote = z.infer<typeof RemoteSchema>;
export type ServerCardInput = z.infer<typeof InputSchema>;

/**
 * An AI Catalog entry, parsed leniently: only the members MCP discovery needs. A catalog
 * with one malformed entry is still usable, so entries are validated one by one in
 * `discoverFromDomain` rather than failing the whole document here.
 */
export const AiCatalogEntryShape = z.looseObject({
  identifier: z.string(),
  type: z.string(),
  url: z.string().optional(),
  data: z.unknown().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
});

export const AiCatalogSchema = z.looseObject({
  /** "Major.Minor". The RC spec is "0.9"; MCP's own examples use "1.0". */
  specVersion: z.string().regex(/^\d+\.\d+$/),
  /** Entries are `unknown` here and validated individually. */
  entries: z.array(z.unknown()),
  host: z.looseObject({ displayName: z.string().optional(), documentationUrl: z.string().optional() }).optional(),
});

export type AiCatalog = z.infer<typeof AiCatalogSchema>;
export type AiCatalogEntry = z.infer<typeof AiCatalogEntryShape>;

/** Highest AI Catalog major version this client understands (higher majors are rejected). */
export const SUPPORTED_CATALOG_MAJOR_MAX = 1;
