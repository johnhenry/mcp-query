#!/usr/bin/env node
// mcp-docs CLI — generate Markdown reference docs from a live MCP server or a pinned
// contract. "Redoc for MCP".
//
//   mcp-docs --command npx --args "-y @modelcontextprotocol/server-everything" --out API.md
//   mcp-docs --contract mcp.contract.json --title "My Server" > API.md

import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { captureContract, type Contract } from "../../mcp-contract/src/contract.js";
import { renderMarkdown } from "./render.js";

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
  const client = new Client({ name: "mcp-docs", version: "0.0.1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: flags.command, args: flags.args ? flags.args.split(" ").filter(Boolean) : [] }));
  const contract = await captureContract(client);
  await client.close();
  return contract;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const contract = await loadContract(flags);
  const md = renderMarkdown(contract, flags.title ? { title: flags.title } : {});
  if (flags.out) {
    await writeFile(flags.out, md, "utf8");
    console.error(`wrote ${flags.out} (${contract.tools.length} tools, ${contract.prompts.length} prompts, ${contract.resources.length} resources)`);
  } else {
    process.stdout.write(md);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[mcp-docs]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
