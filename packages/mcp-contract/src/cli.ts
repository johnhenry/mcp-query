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

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { MCPClient } from "@johnhenry/mcp-query";
import { createGateway } from "@johnhenry/mcp-query/server";
import { fetchServerCard, recommendedCardUrl } from "@johnhenry/mcp-query/discovery";
import { cardForContract, diffContract, upgradeContract, type Contract, type ContractCard } from "./contract.js";
import { captureFrom } from "./connect.js";
import { resolveConnect } from "./registry.js";
import { authenticate, tokenCachePath } from "./oauth.js";
import { mockFromContract } from "./mock.js";
import { usedFromSource } from "./used.js";
import { formatDiff } from "./report.js";
import { rejectUnknownFlags } from "./flags.js";

const KNOWN_FLAGS = ["server", "config", "command", "args", "url", "bearer", "header", "out", "contract", "used", "used-by", "scope", "open", "port", "dpop", "client-metadata-url", "expected-issuer", "card"] as const;

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string>; headers: string[] } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a === "--dpop") flags.dpop = "true"; // boolean flag
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else _.push(a);
  }
  return { _, flags, headers };
}

async function readContract(path: string): Promise<Contract> {
  return upgradeContract(JSON.parse(await readFile(path, "utf8"))); // reads v1 and v2
}

const HELP = `mcp-contract: pin, verify, diff and mock an MCP server's capability surface

usage:
  mcp-contract snapshot (--command CMD [--args "A B"] | --url URL [--bearer T] [--header "K: V"] | --server NAME) [--out mcp.contract.json]
                        [--card URL|auto]   also pin the server's Server Card (auto: <url>/server-card); on verify/diff too, to compare it
  mcp-contract verify   <same connection flags> --contract mcp.contract.json [--used "a,b"] [--used-by src/mcp.gen.ts]
  mcp-contract diff     old.contract.json new.contract.json
  mcp-contract mock     --contract mcp.contract.json     serve the contracted surface over stdio
  mcp-contract auth     --url URL                         run the OAuth flow and cache tokens
  mcp-contract --help

verify exits non-zero on any BREAKING change. Docs: https://github.com/johnhenry/mcp-query/tree/main/packages/mcp-contract`;

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const { _, flags, headers } = parseArgs(argv);
  rejectUnknownFlags("mcp-contract", flags, KNOWN_FLAGS);
  const cmd = _[0];
  const isLive = !!(flags.url || flags.command || flags.server);
  const live = async () => {
    const target = { ...resolveConnect(flags, headers), clientName: "mcp-contract" };
    return captureFrom(target, flags.card ? { card: await fetchCard(flags.card, target.url) } : {});
  };
  const liveOrFile = (fileArg?: string) => (isLive ? live() : fileArg ? readContract(fileArg) : Promise.reject(new Error("provide --url/--command/--server for a live server, or a contract file path")));

  switch (cmd) {
    case "snapshot": {
      const contract = await live();
      const json = JSON.stringify(contract, null, 2);
      if (flags.out) {
        await writeFile(flags.out, json + "\n", "utf8");
        console.error(`wrote ${flags.out} (${contract.tools.length} tools, ${contract.prompts.length} prompts, ${contract.resources.length} resources${contract.card ? `, card ${contract.card.name}` : ""})`);
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
      const tokens = await authenticate(url, { scope: flags.scope, out: flags.out, open: flags.open !== "false", port: flags.port ? Number(flags.port) : undefined, dpop: flags.dpop === "true", expectedIssuer: flags["expected-issuer"], clientMetadataUrl: flags["client-metadata-url"] });
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

/**
 * `--card <url|auto>`: fetch the server's Server Card (SEP-2127) so the contract pins where and how to connect.
 * `auto` reads the recommended location, `<--url>/server-card`. Only identity and remotes are kept (see `cardForContract`).
 * A plain-http card is accepted only on a loopback host.
 */
async function fetchCard(card: string, serverUrl: string | undefined): Promise<ContractCard> {
  let cardUrl = card;
  if (card === "auto") {
    if (!serverUrl) throw new Error("--card auto reads <url>/server-card, so it needs --url (or a registered http server); pass --card <card url> for a stdio server");
    cardUrl = recommendedCardUrl(serverUrl);
  }
  const fetched = await fetchServerCard(cardUrl, { allowInsecureLocalhost: true });
  return cardForContract(fetched.card, fetched.url);
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

// Compare realpaths, not raw import.meta.url/process.argv[1] strings: an npm bin
// (node_modules/.bin/mcp-contract, what `npx` / a global install runs) is a symlink, so the
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
    console.error("[mcp-contract]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
