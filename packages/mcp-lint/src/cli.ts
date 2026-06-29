#!/usr/bin/env node
// mcp-lint CLI — quality-lint an MCP server's capability surface.
//
//   mcp-lint --command npx --args "-y @modelcontextprotocol/server-everything"
//   mcp-lint --contract mcp.contract.json [--max-warnings 0] [--off naming-consistency,no-open-input]
//
// Exits non-zero on any error-level finding, or when warnings exceed --max-warnings.

import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { captureContract, type Contract } from "../../mcp-contract/src/contract.js";
import { lintContract, type LintOptions } from "./lint.js";
import { formatLint } from "./report.js";
import { RULES, type Severity } from "./rules.js";

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return flags;
}

async function loadContract(flags: Record<string, string>): Promise<Contract> {
  if (flags.contract) return JSON.parse(await readFile(flags.contract, "utf8")) as Contract;
  if (!flags.command) throw new Error("provide --command <cmd> [--args ...] for a live server, or --contract <file.json>");
  const client = new Client({ name: "mcp-lint", version: "0.0.1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: flags.command, args: flags.args ? flags.args.split(" ").filter(Boolean) : [] }));
  const contract = await captureContract(client);
  await client.close();
  return contract;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if ("list-rules" in flags) {
    console.error(RULES.map((r) => `  ${r.id} (${r.defaultSeverity}) — ${r.description}`).join("\n"));
    return;
  }
  const contract = await loadContract(flags);

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
  main().catch((e) => {
    console.error("[mcp-lint]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
