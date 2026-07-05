// Shared unknown-flag rejection for the tool CLIs. Every CLI uses the same minimal
// `--flag value` parser; before this check, a typo'd flag was silently swallowed
// (and its value discarded). Each CLI declares its allowlist and calls this right
// after parsing.

/**
 * Throw when `flags` contains a key outside `known`. `known` should include flags
 * the parser handles specially (e.g. `header`, `call`) so the error's "known:" list
 * is complete documentation for the CLI.
 */
export function rejectUnknownFlags(tool: string, flags: Record<string, unknown>, known: readonly string[]): void {
  const set = new Set(known);
  const unknown = Object.keys(flags).filter((k) => !set.has(k));
  if (!unknown.length) return;
  const plural = unknown.length > 1 ? "s" : "";
  throw new Error(
    `unknown flag${plural} ${unknown.map((k) => `--${k}`).join(", ")} for ${tool} (known: ${known.map((k) => `--${k}`).join(", ")})`,
  );
}
