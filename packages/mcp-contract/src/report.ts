// Human-readable rendering of a ContractDiff for `verify` / `diff` output.

import type { ContractDiff } from "./contract.js";

/** Format a diff as a grouped, signed report. Breaking changes are marked ✗, compatible ~, content drift ≈. */
export function formatDiff(diff: ContractDiff, opts: { color?: boolean } = {}): string {
  if (!diff.changes.length) return "✓ no changes — live surface matches the contract";

  const c = opts.color ?? false;
  const red = (s: string) => (c ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[0m` : s);

  const rank = { breaking: 0, drift: 1, compatible: 2 } as const;
  const lines = diff.changes
    .slice()
    .sort((a, b) => (a.level === b.level ? a.target.localeCompare(b.target) : rank[a.level] - rank[b.level]))
    .map((ch) => {
      const mark = ch.level === "breaking" ? red("✗ BREAKING") : ch.level === "drift" ? yellow("≈ drift") : yellow("~ compatible");
      return `  ${mark}  ${ch.category} ${ch.target} — ${ch.detail}`;
    });

  const summary = `${diff.breaking} breaking, ${diff.compatible} compatible${diff.drift ? `, ${diff.drift} content drift` : ""}`;
  return [...lines, "", diff.breaking ? red(`✗ ${summary}`) : yellow(`~ ${summary} (no breaking changes)`)].join("\n");
}
