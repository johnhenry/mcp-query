#!/usr/bin/env node
// mcp-contract CLI — pin, verify, diff, and mock an MCP server's capability surface.
//
//   mcp-contract snapshot --command npx --args "-y server-everything" --out mcp.contract.json
//   mcp-contract verify   --command npx --args "-y server-everything" --contract mcp.contract.json [--used "echo,add"] [--used-by src/mcp.gen.ts]
//   mcp-contract diff      old.contract.json new.contract.json
//   mcp-contract mock     --contract mcp.contract.json     # serve the contracted surface over stdio
//
// `verify` exits non-zero on any BREAKING change — the CI gate.

import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCPClient } from "../../mcp-query/src/index.js";
import { createGateway } from "../../mcp-query/src/server/index.js";
import { captureContract, diffContract, type Contract } from "./contract.js";
import { mockFromContract } from "./mock.js";
import { usedFromSource } from "./used.js";
import { formatDiff } from "./report.js";

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string> } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else _.push(a);
  }
  return { _, flags };
}

async function captureFromStdio(command: string, argsStr?: string): Promise<Contract> {
  const client = new Client({ name: "mcp-contract", version: "0.0.1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command, args: argsStr ? argsStr.split(" ").filter(Boolean) : [] }));
  const contract = await captureContract(client);
  await client.close();
  return contract;
}

async function readContract(path: string): Promise<Contract> {
  return JSON.parse(await readFile(path, "utf8")) as Contract;
}

async function liveOrFile(flags: Record<string, string>, fileArg?: string): Promise<Contract> {
  if (flags.command) return captureFromStdio(flags.command, flags.args);
  if (fileArg) return readContract(fileArg);
  throw new Error("provide --command <cmd> [--args ...] for a live server, or a contract file path");
}

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];

  switch (cmd) {
    case "snapshot": {
      const contract = await captureFromStdio(required(flags, "command"), flags.args);
      const json = JSON.stringify(contract, null, 2);
      if (flags.out) {
        await writeFile(flags.out, json + "\n", "utf8");
        console.error(`wrote ${flags.out} (${contract.tools.length} tools, ${contract.prompts.length} prompts, ${contract.resources.length} resources)`);
      } else {
        process.stdout.write(json + "\n");
      }
      break;
    }

    case "verify": {
      const pinned = await readContract(required(flags, "contract"));
      const live = await liveOrFile(flags, _[1]);
      const used = await resolveUsed(flags, pinned);
      const diff = diffContract(pinned, live, used ? { used } : {});
      console.error(formatDiff(diff, { color: process.stderr.isTTY }));
      process.exit(diff.breaking ? 1 : 0);
      break;
    }

    case "diff": {
      const a = _[1] ? await readContract(_[1]) : await liveOrFile(flags);
      const b = _[2] ? await readContract(_[2]) : await liveOrFile(flags, _[1]);
      const diff = diffContract(a, b);
      console.error(formatDiff(diff, { color: process.stderr.isTTY }));
      break;
    }

    case "mock": {
      const contract = await readContract(required(flags, "contract"));
      const mock = mockFromContract(contract);
      const client = new MCPClient({ servers: { contract: { transport: mock.transport } } });
      await client.connect();
      const server = createGateway(client, { namespace: false });
      await server.connect(new StdioServerTransport());
      console.error(`[mcp-contract] mock serving ${contract.tools.length} tools on stdio`);
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => void Promise.resolve(server.close()).then(() => client.close()).then(() => process.exit(0)));
      }
      break;
    }

    default:
      console.error("usage: mcp-contract <snapshot|verify|diff|mock> [options]");
      process.exit(1);
  }
}

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

async function resolveUsed(flags: Record<string, string>, contract: Contract): Promise<string[] | undefined> {
  const out: string[] = [];
  if (flags.used) out.push(...flags.used.split(",").map((s) => s.trim()).filter(Boolean));
  if (flags["used-by"]) out.push(...usedFromSource(await readFile(flags["used-by"], "utf8"), contract));
  return out.length ? out : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[mcp-contract]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
