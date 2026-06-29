#!/usr/bin/env node
// mcp-contract CLI — pin, verify, diff, and mock an MCP server's capability surface.
//
//   mcp-contract snapshot --command npx --args "-y server-everything" --out mcp.contract.json
//   mcp-contract snapshot --url https://host/mcp --bearer "$TOKEN" --out mcp.contract.json
//   mcp-contract verify   --url https://host/mcp --contract mcp.contract.json [--used "a,b"] [--used-by src/mcp.gen.ts]
//   mcp-contract diff      old.contract.json new.contract.json
//   mcp-contract mock     --contract mcp.contract.json     # serve the contracted surface over stdio
//
// A live server is reached over stdio (--command) or Streamable HTTP (--url, with
// optional --bearer / repeated --header "K: V"). `verify` exits non-zero on any BREAKING change.

import { readFile, writeFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCPClient } from "../../mcp-query/src/index.js";
import { createGateway } from "../../mcp-query/src/server/index.js";
import { diffContract, type Contract } from "./contract.js";
import { captureFrom } from "./connect.js";
import { resolveConnect } from "./registry.js";
import { authenticate, tokenCachePath } from "./oauth.js";
import { mockFromContract } from "./mock.js";
import { usedFromSource } from "./used.js";
import { formatDiff } from "./report.js";

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string>; headers: string[] } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else _.push(a);
  }
  return { _, flags, headers };
}

async function readContract(path: string): Promise<Contract> {
  return JSON.parse(await readFile(path, "utf8")) as Contract;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { _, flags, headers } = parseArgs(argv);
  const cmd = _[0];
  const isLive = !!(flags.url || flags.command);
  const live = () => captureFrom({ ...resolveConnect(flags, headers), clientName: "mcp-contract" });
  const liveOrFile = (fileArg?: string) => (isLive ? live() : fileArg ? readContract(fileArg) : Promise.reject(new Error("provide --url/--command for a live server, or a contract file path")));

  switch (cmd) {
    case "snapshot": {
      const contract = await live();
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
      const candidate = await liveOrFile(_[1]);
      const used = await resolveUsed(flags, pinned);
      const diff = diffContract(pinned, candidate, used ? { used } : {});
      console.error(formatDiff(diff, { color: process.stderr.isTTY }));
      process.exit(diff.breaking ? 1 : 0);
      break;
    }

    case "diff": {
      const a = _[1] ? await readContract(_[1]) : await live();
      const b = _[2] ? await readContract(_[2]) : await liveOrFile(_[1]);
      const diff = diffContract(a, b);
      console.error(formatDiff(diff, { color: process.stderr.isTTY }));
      break;
    }

    case "auth": {
      const url = required(flags, "url");
      const tokens = await authenticate(url, { scope: flags.scope, out: flags.out, open: flags.open !== "false", port: flags.port ? Number(flags.port) : undefined });
      console.error(`\n✓ authorized ${url}`);
      console.error(`  token cached: ${tokenCachePath(url)}${flags.out ? ` (also → ${flags.out})` : ""}`);
      console.error(`  scopes: ${tokens.scope ?? "(server default)"}${tokens.refresh_token ? " · refresh token obtained" : ""}`);
      console.error(`  now run, e.g.:  mcp-lint --url ${url}`);
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
      console.error("usage: mcp-contract <snapshot|verify|diff|mock|auth> [options]");
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
  run().catch((e) => {
    console.error("[mcp-contract]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
