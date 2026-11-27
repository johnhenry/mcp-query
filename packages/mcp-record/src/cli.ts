#!/usr/bin/env node
// mcp-record CLI — record a live MCP server's traffic to a cassette, then replay it
// offline as a deterministic mock.
//
//   mcp-record record  --command npx --args "-y server-everything" --out tape.json \
//                      --call 'echo(message: "hi")' --call get-sum:'{"a":1,"b":2}'
//   mcp-record record  --url https://host/mcp --out tape.json   # hosted (Streamable HTTP)
//   mcp-record record  --url https://host/mcp --out tape.json   # --era auto is the default: server/discover first, initialize as the fallback
//   mcp-record replay  --cassette tape.json          # serve the cassette over stdio (a 2026-07-28 cassette to a modern client, a 2025 one with initialize)
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

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { buildTransport, resolveConnect, parseCallSpec, rejectUnknownFlags, parseEra, versionNegotiationFor, runRounds, parseAnswers, InputRequiredError, DEFAULT_ERA, type ConnectOptions, type Era } from "@johnhenry/mcp-contract";
import { createCassette, loadCassette, sealCassette, type Cassette } from "./cassette.js";
import { recordTransport, redactPaths } from "./record.js";
import { replayOverStdio } from "./replayStdio.js";

const KNOWN_FLAGS = ["server", "config", "command", "args", "url", "bearer", "header", "call", "out", "cassette", "redact", "era", "answer"] as const;

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string>; headers: string[]; calls: string[]; redact: string[]; answers: string[] } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  const calls: string[] = [];
  const redact: string[] = [];
  const answers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--call") calls.push(argv[++i] ?? "");
    else if (a === "--answer") answers.push(argv[++i] ?? "");
    else if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a === "--redact") redact.push(argv[++i] ?? "");
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else _.push(a);
  }
  return { _, flags, headers, calls, redact, answers };
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
 *
 * `era` `auto` (the default) probes `server/discover` first. The probe runs on the recording transport
 * itself (so it is captured), which means a legacy server that dies on the unrecognised probe cannot be
 * retried in place; a failed `auto` connect is therefore retried once, from scratch, as `legacy`.
 *
 * `answers` are `--answer key=value` tokens for an `input_required` round during a --call (2026-07-28
 * connections). A round with a question nobody answered aborts the recording with the question printed.
 */
export async function recordSession(opts: ConnectOptions, calls: string[], redactPathList: string[] = [], era: Era = DEFAULT_ERA, answers: string[] = []): Promise<Cassette> {
  const parsedCalls = calls.map((spec) => parseCallSpec(spec)); // fail fast, before connecting
  parseAnswers(answers); // fail fast on a malformed --answer, before connecting
  if (answers.length && era === "legacy") throw new Error("--answer needs a 2026-07-28 connection (the multi round-trip pattern); drop --era legacy");
  if (era === "legacy") return recordOnce(opts, parsedCalls, redactPathList, "legacy", answers);
  try {
    return await recordOnce(opts, parsedCalls, redactPathList, "auto", answers);
  } catch (e) {
    if (e instanceof InputRequiredError || (e as { recordPhase?: string } | null)?.recordPhase !== "connect") throw e;
    console.error(`[mcp-record] could not negotiate with server/discover (${e instanceof Error ? e.message : e}); recording again as legacy (initialize)`);
    return recordOnce(opts, parsedCalls, redactPathList, "legacy", answers);
  }
}

async function recordOnce(opts: ConnectOptions, parsedCalls: Array<{ name: string; args: Record<string, unknown> }>, redactPathList: string[], era: Era, answers: string[]): Promise<Cassette> {
  const cassette = createCassette();
  const inner = buildTransport(opts);
  // Declare elicitation only when we can actually answer it (from --answer).
  const client = new Client({ name: opts.clientName ?? "mcp-record", version: "0.0.1" }, { capabilities: answers.length ? { elicitation: { form: {}, url: {} } } : {}, ...versionNegotiationFor(era) });
  const recordOpts = redactPathList.length ? { redact: redactPaths(redactPathList) } : {};
  try {
    await client.connect(recordTransport(inner, cassette, recordOpts)); // initialize (or server/discover with --era auto) captured here
  } catch (e) {
    await client.close().catch(() => {});
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { recordPhase: "connect" });
  }

  try {
    const caps = client.getServerCapabilities() ?? {};
    if (caps.tools) await client.listTools().catch(() => {});
    if (caps.resources) {
      await client.listResources().catch(() => {});
      await client.listResourceTemplates().catch(() => {});
    }
    if (caps.prompts) await client.listPrompts().catch(() => {});

    const rounds = answers.length > 0 || client.getProtocolEra?.() === "modern";
    for (const { name, args } of parsedCalls) {
      try {
        if (rounds) {
          // Manual round loop: every round (the `input_required` result and each retry) is recorded as its own interaction.
          await runRounds((retry) => client.callTool({ name, arguments: args, ...retry } as never, { allowInputRequired: true } as never) as Promise<unknown>, answers);
        } else {
          await client.callTool({ name, arguments: args });
        }
      } catch (e) {
        if (e instanceof InputRequiredError) throw e; // not recordable without an answer: fail clearly instead of sealing a half cassette
        if (!answers.length && ((e as { code?: unknown } | null)?.code === -32021 || /required capability/i.test(e instanceof Error ? e.message : ""))) {
          // A server that needs to ask the user something refuses a client that did not declare elicitation.
          throw new Error(`call ${name} needs a capability this recording client did not declare (${e instanceof Error ? e.message : e}); if it asks the user questions, re-run with --answer key=value for each`);
        }
        console.error(`  call ${name} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
  return cassette;
}

function summarize(c: Cassette): string {
  const byMethod = new Map<string, number>();
  for (const it of c.interactions) byMethod.set(it.method, (byMethod.get(it.method) ?? 0) + 1);
  const lines = [...byMethod.entries()].sort().map(([m, n]) => `  ${m}: ${n}`);
  const byKind = new Map<string, number>();
  for (const it of c.interactions) if (it.kind) byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
  if (byKind.size) lines.push(`  (${[...byKind.entries()].sort().map(([k, n]) => `${k}: ${n}`).join(", ")})`);
  return [
    `recorded from: ${c.recordedFrom?.name ?? "?"}@${c.recordedFrom?.version ?? "?"}`,
    `format: ${c.version}${c.protocol ? `, ${c.protocol.era} era${c.protocol.version ? ` (${c.protocol.version})` : ""}` : ""}`,
    `capabilities: ${Object.keys(c.capabilities ?? {}).join(", ") || "(none)"}`,
    `interactions: ${c.interactions.length}`,
    ...lines,
  ].join("\n");
}

const HELP = `mcp-record: record a live MCP server's traffic to a cassette, replay it offline

usage:
  mcp-record record  (--command CMD [--args "A B"] | --url URL [--bearer T] [--header "K: V"] | --server NAME)
                     [--out tape.json] [--call 'tool(arg: 1)']... [--redact path]... [--era auto|legacy]
                     [--answer key=value]...
  mcp-record replay  --cassette tape.json     serve the cassette over stdio as a mock MCP server
                                              (a 2026-07-28 cassette is served to a modern client, a 2025 one with initialize)
  mcp-record inspect tape.json                summarize a cassette and verify its integrity hash
  mcp-record --help

--era auto (default) probes server/discover first, bounded by a timeout, and falls back to initialize; a stdio
server is started again for the probe. --era legacy skips the probe (a registry entry's \`era\` applies when unset).
--answer key=value (repeatable) answers an input_required round during a --call; without it such a round fails
the recording. Cassettes are sealed with a SHA-256 integrity hash; edit with care. Captured traffic is verbatim: use
--redact to mask fields before writing. Docs: https://github.com/johnhenry/mcp-query/tree/main/packages/mcp-record`;

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const { _, flags, headers, calls, redact, answers } = parseArgs(argv);
  rejectUnknownFlags("mcp-record", flags, KNOWN_FLAGS);
  switch (_[0]) {
    case "record": {
      const opts: ConnectOptions = { ...resolveConnect(flags, headers), clientName: "mcp-record" };
      if (opts.url) console.error("⚠  recording a hosted server sends real traffic — mind rate limits & ToS.\n");
      const era = parseEra(flags.era) ?? (answers.length ? "auto" : opts.era) ?? DEFAULT_ERA;
      const cassette = sealCassette(await recordSession(opts, calls, redact, era, answers));
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
      const server = await replayOverStdio(cassette);
      console.error(`[mcp-record] replaying ${cassette.interactions.length} interactions on stdio (${server.era === "modern" ? "2026-07-28: server/discover" : "classic: initialize"})`);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void server.close().then(() => process.exit(0)));
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

// Compare realpaths, not raw import.meta.url/process.argv[1] strings: an npm bin
// (node_modules/.bin/mcp-record, what `npx` / a global install runs) is a symlink, so the
// two would otherwise never match and this file would silently no-op for every real install.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run().catch((e) => {
    console.error("[mcp-record]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
