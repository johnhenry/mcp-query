// One-time developer warnings for features the 2026-07-28 revision deprecates (SEP-2577: Sampling,
// Roots, Logging; minimum twelve-month window before removal, SEP-2596). They stay functional, so the
// warning is a nudge, not an error: printed once per feature per process, only in development, and
// easy to silence. Nothing here changes behaviour.

export type DeprecatedFeature = "sampling" | "roots" | "logging";

const ADVICE: Record<DeprecatedFeature, string> = {
  sampling: "integrate LLM provider APIs directly instead",
  roots: "pass directories or files via tool parameters, resource URIs or configuration instead",
  logging: "log to stderr (stdio) or use OpenTelemetry instead",
};

const warned = new Set<DeprecatedFeature>();
let silenced = false;

/** Silence (or re-enable) the deprecation warnings for this process. Also: `MCP_QUERY_SILENCE_DEPRECATIONS=1`. */
export function silenceDeprecationWarnings(silence = true): void {
  silenced = silence;
}

/** Forget which warnings were shown (tests). */
export function resetDeprecationWarnings(): void {
  warned.clear();
}

function env(name: string): string | undefined {
  try {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Development mode: a Node process that is not production and not a test run. A browser has no
 * `process`, so it counts as development only if the page sets `globalThis.__MCP_QUERY_DEV__ = true`.
 */
export function isDevelopment(): boolean {
  if ((globalThis as { __MCP_QUERY_DEV__?: unknown }).__MCP_QUERY_DEV__ === true) return true;
  if (typeof process === "undefined") return false;
  const mode = env("NODE_ENV");
  return mode !== "production" && mode !== "test" && !env("VITEST");
}

/**
 * Warn that a modern-era server asked for a deprecated feature. No-op when silenced, outside
 * development (production, tests), or once the feature has already been reported.
 */
export function warnDeprecatedFeature(feature: DeprecatedFeature, server?: string): void {
  if (silenced || warned.has(feature) || env("MCP_QUERY_SILENCE_DEPRECATIONS") === "1" || !isDevelopment()) return;
  warned.add(feature);
  console.warn(
    `[mcp-query] ${server ? `server "${server}" used` : "a server used"} ${feature}, which MCP 2026-07-28 deprecates (SEP-2577). ` +
      `It keeps working for at least twelve months (SEP-2596); ${ADVICE[feature]}. ` +
      `Silence this with MCP_QUERY_SILENCE_DEPRECATIONS=1 or silenceDeprecationWarnings().`,
  );
}
