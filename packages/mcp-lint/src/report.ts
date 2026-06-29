// Human-readable lint output.

import type { LintResult } from "./lint.js";

export function formatLint(result: LintResult, opts: { color?: boolean } = {}): string {
  if (!result.findings.length) return "✓ no lint findings";
  const c = opts.color ?? false;
  const red = (s: string) => (c ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[0m` : s);

  const lines = result.findings
    .slice()
    .sort((a, b) => (a.severity === b.severity ? a.target.localeCompare(b.target) : a.severity === "error" ? -1 : 1))
    .map((f) => {
      const tag = f.severity === "error" ? red("error") : yellow("warn ");
      return `  ${tag}  ${f.target}  ${f.message}  ${c ? `\x1b[2m(${f.rule})\x1b[0m` : `(${f.rule})`}`;
    });

  const summary = `${result.errors} error${result.errors === 1 ? "" : "s"}, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}`;
  return [...lines, "", result.errors ? red(`✗ ${summary}`) : yellow(`~ ${summary}`)].join("\n");
}
