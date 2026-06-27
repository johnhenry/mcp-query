#!/usr/bin/env node
// A generic inspect CLI (MCP Inspector's CLI-mode analog) for scripting / CI. Dogfoods
// MCPClient against any server and prints JSON. Examples:
//
//   mcp-query-inspect --command npx --args "-y @modelcontextprotocol/server-everything" --method tools/list
//   mcp-query-inspect --command … --method tools/call --tool echo --arg message=hi
//   mcp-query-inspect --url https://mcp.example.com --transport http --method resources/list
//   mcp-query-inspect --command … --method ping

import { MCPClient } from "../core/client.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

function parse(argv: string[]): { flags: Record<string, string>; args: Record<string, string> } {
  const flags: Record<string, string> = {};
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--arg") {
      const [name, ...rest] = (argv[++i] ?? "").split("=");
      args[name!] = rest.join("=");
    } else if (k?.startsWith("--")) {
      flags[k.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i]!;
    }
  }
  return { flags, args };
}

function coerce(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function buildTransport(f: Record<string, string>): () => Transport {
  if (f.url) {
    const url = new URL(f.url);
    return f.transport === "sse"
      ? () => new SSEClientTransport(url)
      : () => new StreamableHTTPClientTransport(url);
  }
  if (!f.command) throw new Error("provide --command (stdio) or --url (http/sse)");
  const args = f.args ? f.args.split(" ").filter(Boolean) : [];
  return () => new StdioClientTransport({ command: f.command!, args });
}

async function main(): Promise<void> {
  const { flags, args } = parse(process.argv.slice(2));
  const client = new MCPClient({ servers: { s: { transport: buildTransport(flags) } } });
  await client.connect();
  try {
    process.stdout.write(JSON.stringify(await dispatch(client, flags, args), null, 2) + "\n");
  } finally {
    await client.close();
  }
}

/** Run one `--method` against a connected client (server alias "s"). Testable core of main(). */
export async function dispatch(
  client: MCPClient,
  flags: Record<string, string>,
  args: Record<string, string>,
): Promise<unknown> {
  const method = flags.method ?? "tools/list";
  const toolArgs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, coerce(v)]));
  switch (method) {
    case "tools/list": return client.listTools("s");
    case "tools/call": return client.callTool(`s.${flags.tool}`, toolArgs);
    case "resources/list": return client.listResources("s");
    case "resources/templates/list": return client.listResourceTemplates("s");
    case "resources/read": return client.readResource(flags.uri!, { server: "s" });
    case "prompts/list": return client.listPrompts("s");
    case "prompts/get": return client.getPrompt(flags.prompt!, toolArgs, "s");
    case "ping": return client.ping("s");
    case "complete":
      return client.complete(
        flags.uri ? { type: "ref/resource", uri: flags.uri } : { type: "ref/prompt", name: flags.prompt! },
        { name: flags["arg-name"]!, value: flags["arg-value"] ?? "" },
        "s",
      );
    default:
      throw new Error(`unknown --method ${method}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

export { main, parse, coerce };
