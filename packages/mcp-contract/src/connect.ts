// Shared connection helper for the capture-based tools (contract / lint / docs):
// connect to a live MCP server over stdio OR Streamable HTTP, capture its surface, close.
// HTTP support lets these tools target *hosted* MCP servers, not just locally-spawned ones.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { captureContract, type Contract } from "./contract.js";
import { captureProvider } from "./oauth.js";

export interface ConnectOptions {
  /** Local server: command to spawn (stdio). */
  command?: string;
  /** Space-separated args for `command`. */
  args?: string;
  /** Hosted server: Streamable HTTP endpoint URL. */
  url?: string;
  /** Extra HTTP headers (e.g. `Authorization: Bearer …`) for the `url` transport. */
  headers?: Record<string, string>;
  /** Environment for a stdio `command`. */
  env?: Record<string, string>;
  /** Working directory for a stdio `command`. */
  cwd?: string;
  /** clientInfo.name sent during initialize. */
  clientName?: string;
}

/** Build a client transport from connect options (url wins over command). */
export function buildTransport(opts: ConnectOptions): Transport {
  if (opts.url) {
    const headers = opts.headers && Object.keys(opts.headers).length ? opts.headers : undefined;
    const hasAuthHeader = !!headers && Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    const init: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
    if (headers) init.requestInit = { headers };
    // No explicit token → use the cached OAuth provider (auto-refresh; or a friendly
    // "run mcp-contract auth" if nothing is cached). An explicit --bearer/--header wins.
    if (!hasAuthHeader) init.authProvider = captureProvider(opts.url);
    return new StreamableHTTPClientTransport(new URL(opts.url), init);
  }
  if (opts.command) {
    return new StdioClientTransport({
      command: opts.command,
      args: opts.args ? opts.args.split(" ").filter(Boolean) : [],
      ...(opts.env ? { env: { ...getDefaultEnvironment(), ...opts.env } } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  }
  throw new Error("provide --url <https://…> or --command <cmd> [--args …], or a registered server name");
}

/** Connect a live SDK client from connect options; caller is responsible for `close()`. */
export async function connectClient(opts: ConnectOptions): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: opts.clientName ?? "mcp-query", version: "0.0.1" }, { capabilities: {} });
  await client.connect(buildTransport(opts));
  return { client, close: () => client.close().catch(() => {}) };
}

/** Connect, capture the capability surface, and close. */
export async function captureFrom(opts: ConnectOptions): Promise<Contract> {
  const { client, close } = await connectClient(opts);
  try {
    return await captureContract(client);
  } finally {
    await close();
  }
}

/** Derive ConnectOptions from CLI flags + repeated `--header "K: V"` values. */
export function connectFromFlags(flags: Record<string, string>, headerArgs: string[] = []): ConnectOptions {
  const headers: Record<string, string> = {};
  for (const item of headerArgs) {
    const i = item.indexOf(":");
    if (i > 0) headers[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  if (flags.bearer) headers["Authorization"] = `Bearer ${flags.bearer}`;
  return { url: flags.url, command: flags.command, args: flags.args, headers };
}
