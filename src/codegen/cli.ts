#!/usr/bin/env node
// Codegen CLI. Connects to an MCP server (stdio), drains tools/list, and writes a
// typed module. Usage:
//   mcp-query-codegen --command mcp-server-filesystem --args "/work" --out src/mcp.gen.ts
//
// The pure generator (generate.ts) is what carries the test weight; this is the
// thin I/O wrapper around it.

import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateToolTypes, type ToolLike } from "./generate.js";

/** Drain tools/list from a connected SDK Client (also used by tests). */
export async function generateFromClient(client: Client): Promise<string> {
  const tools: ToolLike[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as ToolLike[]));
    cursor = page.nextCursor;
  } while (cursor);
  return generateToolTypes(tools);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (k?.startsWith("--")) out[k.slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.command) {
    console.error("usage: mcp-query-codegen --command <cmd> [--args <space-separated>] --out <file.ts>");
    process.exit(1);
  }
  const client = new Client({ name: "mcp-query-codegen", version: "0.0.1" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({ command: a.command, args: a.args ? a.args.split(" ").filter(Boolean) : [] }),
  );
  const code = await generateFromClient(client);
  await client.close();
  if (a.out) {
    await writeFile(a.out, code, "utf8");
    console.error(`wrote ${a.out}`);
  } else {
    process.stdout.write(code);
  }
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
