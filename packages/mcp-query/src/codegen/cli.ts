#!/usr/bin/env node
// Codegen CLI. Connects to an MCP server (stdio), drains tools/list, and writes a
// typed module. Usage:
//   mcpq-codegen --command mcp-server-filesystem --args "/work" --out src/mcp.gen.ts
//
// The pure generator (generate.ts) is what carries the test weight; this is the
// thin I/O wrapper around it.

import { writeFile } from "node:fs/promises";
import { Client, type VersionNegotiationOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  generateToolTypes,
  generatePromptTypes,
  generateTemplateTypes,
  type ToolLike,
  type PromptLike,
  type TemplateLike,
} from "./generate.js";

/** Drain tools (and, when available, prompts + resource templates) and generate types. */
export async function generateFromClient(client: Client): Promise<string> {
  const caps = client.getServerCapabilities() ?? {};
  // v2 listTools auto-aggregates every page when called without a cursor.
  const tools: ToolLike[] = caps.tools ? ((await client.listTools()).tools as ToolLike[]) : [];

  let prompts: PromptLike[] = [];
  if (caps.prompts) prompts = (await client.listPrompts().catch(() => ({ prompts: [] }))).prompts as PromptLike[];

  let templates: TemplateLike[] = [];
  if (caps.resources) {
    templates = (await client.listResourceTemplates().catch(() => ({ resourceTemplates: [] })))
      .resourceTemplates as TemplateLike[];
  }

  return [generateToolTypes(tools), generatePromptTypes(prompts), generateTemplateTypes(templates)]
    .filter(Boolean)
    .join("\n");
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (k?.startsWith("--")) out[k.slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const a = parseArgs(argv);
  if (!a.command) {
    console.error("usage: mcpq-codegen --command <cmd> [--args <space-separated>] [--negotiate auto|legacy|pin:<rev>] --out <file.ts>");
    process.exit(1);
  }
  // CLIs keep the SDK's conservative 'legacy' negotiation default (spawn-per-invocation
  // stdio tools stall on the probe against servers that ignore pre-initialize requests);
  // opt in with --negotiate auto|legacy|pin:<revision>.
  const negotiate = a.negotiate ? parseNegotiate(a.negotiate) : undefined;
  const client = new Client(
    { name: "mcpq-codegen", version: "0.1.0" },
    { capabilities: {}, ...(negotiate ? { versionNegotiation: negotiate } : {}) },
  );
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

/** Parse --negotiate auto|legacy|pin:<revision>. */
export function parseNegotiate(v: string): VersionNegotiationOptions {
  if (v === "auto" || v === "legacy") return { mode: v };
  if (v.startsWith("pin:")) return { mode: { pin: v.slice(4) as "2026-07-28" } };
  throw new Error(`--negotiate: expected auto|legacy|pin:<revision>, got "${v}"`);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
