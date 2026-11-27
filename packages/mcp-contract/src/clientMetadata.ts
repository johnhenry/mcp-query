// The CLI's Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document).
//
// The document is checked in at `oauth/client-metadata.json` and published by GitHub
// Pages at the URL below. raw.githubusercontent.com is NOT used: it serves every file as
// `text/plain`, while the draft requires the response to be JSON (`application/json` or
// `application/<AS-defined>+json`). GitHub Pages serves `.json` as `application/json`.
// The repository owner must enable Pages for this URL to resolve: Settings -> Pages ->
// Build and deployment -> Deploy from a branch -> `main` / `/ (root)`.
//
// Until it resolves (or if an authorization server does not advertise
// `client_id_metadata_document_supported`), the SDK falls back to Dynamic Client
// Registration, so an unpublished document degrades to the old behaviour.

/** The single constant for the document's public URL (its `client_id`). */
export const DEFAULT_CLIENT_METADATA_URL = "https://johnhenry.github.io/mcp-query/oauth/client-metadata.json";

/** Env override. A URL replaces the default; `off` (or `0`/`false`/empty) disables CIMD. */
export const CLIENT_METADATA_URL_ENV = "MCPQ_CLIENT_METADATA_URL";

/** Loopback callback port the checked-in document lists in `redirect_uris`. */
export const DEFAULT_CALLBACK_PORT = 8976;

/** The `redirect_uris` the checked-in document registers (keep in sync with the JSON file). */
export const DEFAULT_CLIENT_METADATA_REDIRECT_URIS: readonly string[] = [
  `http://localhost:${DEFAULT_CALLBACK_PORT}/callback`,
  `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`,
];

/** CIMD requires an https URL with a path component (not just "/"). */
export function isValidClientMetadataUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.pathname !== "/" && u.pathname !== "" && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective CIMD URL: explicit option (flag) > env > default. `false`, `"off"`
 * and friends disable it (DCR only). Throws on an explicitly supplied invalid URL.
 */
export function resolveClientMetadataUrl(
  explicit?: string | false,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = explicit !== undefined ? explicit : env[CLIENT_METADATA_URL_ENV];
  if (raw === false) return undefined;
  if (raw === undefined) return DEFAULT_CLIENT_METADATA_URL;
  const v = raw.trim();
  if (v === "" || /^(off|false|0|none)$/i.test(v)) return undefined;
  if (!isValidClientMetadataUrl(v)) {
    throw new Error(`client metadata URL must be an https URL with a path (got "${v}")`);
  }
  return v;
}
