#!/usr/bin/env node
// mcp-record CLI — record a live MCP server's traffic to a cassette, then replay it
// offline as a deterministic mock.
//
//   mcp-record record  --command npx --args "-y server-everything" --out tape.json \
//                      --call 'echo(message: "hi")' --call get-sum:'{"a":1,"b":2}'
//   mcp-record record  --url https://host/mcp --out tape.json   # hosted (Streamable HTTP)
//   mcp-record replay  --cassette tape.json          # serve the cassette over stdio
//   mcp-record inspect tape.json                     # summarize a cassette
//
// `record` reaches a live server over stdio (--command), Streamable HTTP (--url, with
// optional --bearer / repeated --header "K: V"), or a registered name (--server).
// Replay is always stdio — it's a local mock server. `record` always captures the
// capability surface (tools/resources/prompts listings); each --call additionally
// records that tool's real result. --call accepts colon+JSON ('tool:{"a":1}') or a
// function-call string ('tool(a: 1)').
//
// Recorded cassettes are stamped with a SHA-256 integrity hash over their interactions;
// `replay`/`inspect` verify it and refuse to load a cassette that's been hand-edited or
// corrupted since recording. Params/results are captured verbatim (no automatic secret
// scrubbing) — pass repeated --redact "path" (e.g. --redact params.apiKey --redact
// "result.content.0.text") to mask specific fields with "[REDACTED]" before they're written.

import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildTransport, resolveConnect, parseCallSpec, rejectUnknownFlags, type ConnectOptions } from "../../mcp-contract/src/index.js";
import { createCassette, loadCassette, sealCassette, type Cassette } from "./cassette.js";
import { recordTransport, redactPaths } from "./record.js";
import { replayServer } from "./replay.js";

const KNOWN_FLAGS = ["server", "config", "command", "args", "url", "bearer", "header", "call", "out", "cassette", "redact"] as const;

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string>; headers: string[]; calls: string[]; redact: string[] } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  const calls: string[] = [];
  const redact: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--call") calls.push(argv[++i] ?? "");
    else if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a === "--redact") redact.push(argv[++i] ?? "");
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else _.push(a);
  }
  return { _, flags, headers, calls, redact };
}

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

/**
 * Connect (stdio or Streamable HTTP), capture the surface + any --call results, close.
 * `redactPathList` is an opt-in list of dot-paths (e.g. "params.apiKey") masked in the
 * cassette before each interaction is recorded — see `redactPaths` in record.ts.
 */
export async function recordSession(opts: ConnectOptions, calls: string[], redactPathList: string[] = []): Promise<Cassette> {
  const parsedCalls = calls.map((spec) => parseCallSpec(spec)); // fail fast, before connecting
  const cassette = createCassette();
  const inner = buildTransport(opts);
  const client = new Client({ name: opts.clientName ?? "mcp-record", version: "0.0.1" }, { capabilities: {} });
  const recordOpts = redactPathList.length ? { redact: redactPaths(redactPathList) } : {};
  await client.connect(recordTransport(inner, cassette, recordOpts)); // initialize captured here

  const caps = client.getServerCapabilities() ?? {};
  if (caps.tools) await client.listTools().catch(() => {});
  if (caps.resources) {
    await client.listResources().catch(() => {});
    await client.listResourceTemplates().catch(() => {});
  }
  if (caps.prompts) await client.listPrompts().catch(() => {});

  for (const { name, args } of parsedCalls) {
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

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { _, flags, headers, calls, redact } = parseArgs(argv);
  rejectUnknownFlags("mcp-record", flags, KNOWN_FLAGS);
  switch (_[0]) {
    case "record": {
      const opts: ConnectOptions = { ...resolveConnect(flags, headers), clientName: "mcp-record" };
      if (opts.url) console.error("⚠  recording a hosted server sends real traffic — mind rate limits & ToS.\n");
      const cassette = sealCassette(await recordSession(opts, calls, redact));
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
      const cassette = loadCassette(await readFile(required(flags, "cassette"), "utf8"));
      const server = replayServer(cassette);
      await server.connect(new StdioServerTransport());
      console.error(`[mcp-record] replaying ${cassette.interactions.length} interactions on stdio`);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void Promise.resolve(server.close()).then(() => process.exit(0)));
      break;
    }
    case "inspect": {
      const cassette = loadCassette(await readFile(_[1] ?? required(flags, "cassette"), "utf8"));
      console.error(summarize(cassette));
      break;
    }
    default:
      console.error("usage: mcp-record <record|replay|inspect> [options]");
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error("[mcp-record]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
