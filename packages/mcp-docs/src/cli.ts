#!/usr/bin/env node
// mcp-docs CLI — generate Markdown reference docs from a live MCP server or a pinned
// contract. "Redoc for MCP".
//
//   mcp-docs --command npx --args "-y @modelcontextprotocol/server-everything" --out API.md
//   mcp-docs --url https://host/mcp --bearer "$TOKEN" --out API.md
//   mcp-docs --contract mcp.contract.json --title "My Server" > API.md
//
// A live server is reached over stdio (--command) or Streamable HTTP (--url, with optional
// --bearer / repeated --header "K: V").

import { readFile, writeFile } from "node:fs/promises";
import { captureFrom, connectFromFlags, type Contract } from "../../mcp-contract/src/index.js";
import { renderMarkdown } from "./render.js";

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
  return captureFrom({ ...connectFromFlags(flags, headers), clientName: "mcp-docs" });
}

async function main(): Promise<void> {
  const { flags, headers } = parseArgs(process.argv.slice(2));
  const contract = await loadContract(flags, headers);
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
