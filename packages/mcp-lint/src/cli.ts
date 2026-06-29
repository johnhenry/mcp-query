#!/usr/bin/env node
// mcp-lint CLI — quality-lint an MCP server's capability surface.
//
//   mcp-lint --command npx --args "-y @modelcontextprotocol/server-everything"
//   mcp-lint --url https://host/mcp --bearer "$TOKEN"
//   mcp-lint --contract mcp.contract.json [--max-warnings 0] [--off naming-consistency,no-open-input]
//
// A live server is reached over stdio (--command) or Streamable HTTP (--url, with optional
// --bearer / repeated --header "K: V"). Exits non-zero on any error, or warnings over --max-warnings.

import { readFile } from "node:fs/promises";
import { captureFrom, resolveConnect, type Contract } from "../../mcp-contract/src/index.js";
import { lintContract, type LintOptions } from "./lint.js";
import { formatLint } from "./report.js";
import { RULES, type Severity } from "./rules.js";

function parseArgs(argv: string[]): { flags: Record<string, string>; headers: string[] } {
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return { flags, headers };
}

async function loadContract(flags: Record<string, string>, headers: string[]): Promise<Contract> {
  if (flags.contract) return JSON.parse(await readFile(flags.contract, "utf8")) as Contract;
  return captureFrom({ ...resolveConnect(flags, headers), clientName: "mcp-lint" });
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { flags, headers } = parseArgs(argv);
  if ("list-rules" in flags) {
    console.error(RULES.map((r) => `  ${r.id} (${r.defaultSeverity}) — ${r.description}`).join("\n"));
    return;
  }
  const contract = await loadContract(flags, headers);

  const overrides: Record<string, Severity> = {};
  for (const id of (flags.off ?? "").split(",").map((s) => s.trim()).filter(Boolean)) overrides[id] = "off";
  for (const id of (flags.error ?? "").split(",").map((s) => s.trim()).filter(Boolean)) overrides[id] = "error";
  const opts: LintOptions = { rules: overrides };

  const result = lintContract(contract, opts);
  console.error(formatLint(result, { color: process.stderr.isTTY }));

  const maxWarnings = flags["max-warnings"] !== undefined ? Number(flags["max-warnings"]) : Infinity;
  process.exit(result.errors > 0 || result.warnings > maxWarnings ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error("[mcp-lint]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
