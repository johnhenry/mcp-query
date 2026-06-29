#!/usr/bin/env node
// mcp-record CLI — record a live MCP server's traffic to a cassette, then replay it
// offline as a deterministic mock.
//
//   mcp-record record  --command npx --args "-y server-everything" --out tape.json \
//                      --call echo:'{"message":"hi"}' --call get-sum:'{"a":1,"b":2}'
//   mcp-record replay  --cassette tape.json          # serve the cassette over stdio
//   mcp-record inspect tape.json                     # summarize a cassette
//
// `record` always captures the capability surface (tools/resources/prompts listings);
// each --call additionally records that tool's real result.

import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCassette, type Cassette } from "./cassette.js";
import { recordTransport } from "./record.js";
import { replayServer } from "./replay.js";

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string>; calls: string[] } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  const calls: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--call") calls.push(argv[++i] ?? "");
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else _.push(a);
  }
  return { _, flags, calls };
}

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

async function recordSession(command: string, argsStr: string | undefined, calls: string[]): Promise<Cassette> {
  const cassette = createCassette();
  const inner = new StdioClientTransport({ command, args: argsStr ? argsStr.split(" ").filter(Boolean) : [] });
  const client = new Client({ name: "mcp-record", version: "0.0.1" }, { capabilities: {} });
  await client.connect(recordTransport(inner, cassette)); // initialize captured here

  const caps = client.getServerCapabilities() ?? {};
  if (caps.tools) await client.listTools().catch(() => {});
  if (caps.resources) {
    await client.listResources().catch(() => {});
    await client.listResourceTemplates().catch(() => {});
  }
  if (caps.prompts) await client.listPrompts().catch(() => {});

  for (const spec of calls) {
    const i = spec.indexOf(":");
    const name = i === -1 ? spec : spec.slice(0, i);
    const args = i === -1 ? {} : (JSON.parse(spec.slice(i + 1)) as Record<string, unknown>);
    await client.callTool({ name, arguments: args }).catch((e) => console.error(`  call ${name} failed: ${e instanceof Error ? e.message : e}`));
  }

  await client.close();
  return cassette;
}

function summarize(c: Cassette): string {
  const byMethod = new Map<string, number>();
  for (const it of c.interactions) byMethod.set(it.method, (byMethod.get(it.method) ?? 0) + 1);
  const lines = [...byMethod.entries()].sort().map(([m, n]) => `  ${m}: ${n}`);
  return [
    `recorded from: ${c.recordedFrom?.name ?? "?"}@${c.recordedFrom?.version ?? "?"}`,
    `capabilities: ${Object.keys(c.capabilities ?? {}).join(", ") || "(none)"}`,
    `interactions: ${c.interactions.length}`,
    ...lines,
  ].join("\n");
}

async function main(): Promise<void> {
  const { _, flags, calls } = parseArgs(process.argv.slice(2));
  switch (_[0]) {
    case "record": {
      const cassette = await recordSession(required(flags, "command"), flags.args, calls);
      const json = JSON.stringify(cassette, null, 2);
      if (flags.out) {
        await writeFile(flags.out, json + "\n", "utf8");
        console.error(`wrote ${flags.out}\n${summarize(cassette)}`);
      } else {
        process.stdout.write(json + "\n");
      }
      break;
    }
    case "replay": {
      const cassette = JSON.parse(await readFile(required(flags, "cassette"), "utf8")) as Cassette;
      const server = replayServer(cassette);
      await server.connect(new StdioServerTransport());
      console.error(`[mcp-record] replaying ${cassette.interactions.length} interactions on stdio`);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void Promise.resolve(server.close()).then(() => process.exit(0)));
      break;
    }
    case "inspect": {
      const cassette = JSON.parse(await readFile(_[1] ?? required(flags, "cassette"), "utf8")) as Cassette;
      console.error(summarize(cassette));
      break;
    }
    default:
      console.error("usage: mcp-record <record|replay|inspect> [options]");
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[mcp-record]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
