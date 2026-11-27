// Shared connection helper for the capture-based tools (contract / lint / docs):
// connect to a live MCP server over stdio OR Streamable HTTP, capture its surface, close.
// HTTP support lets these tools target *hosted* MCP servers, not just locally-spawned ones.

import { Client, StreamableHTTPClientTransport, type ClientCapabilities, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { captureContract, type Contract, type ContractCard } from "./contract.js";
import { captureProvider, tokenNormalizingFetch } from "./oauth.js";

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
  /**
   * Which handshake to connect with: `legacy` skips the `server/discover` probe (use for a server known to
   * be 2025-era; a registry entry's `era` pin lands here), `auto` probes first. Absent means the default,
   * `auto`, for every connecting function in this package (`connectEra`, `connectClient`, `captureFrom`).
   * Consumers that take `--era` let the flag win over a registry pin.
   */
  era?: Era;
}

/** `legacy`: the plain `initialize` handshake. `auto`: probe `server/discover` first, fall back to `initialize`. */
export type Era = "legacy" | "auto";
/** What every `--era` flag, and the `era` option of every connecting function, defaults to. */
export const DEFAULT_ERA: Era = "auto";
/**
 * Upper bound for the `server/discover` probe, in ms (override with `MCPQ_ERA_PROBE_TIMEOUT_MS`).
 * Without it the SDK would wait its full request timeout (60 s) on a server that never answers the probe.
 */
export const ERA_PROBE_TIMEOUT_MS = 5000;

/** The `--era` help text shared by every CLI that connects (wording kept in one place). */
export const ERA_FLAG_HELP =
  "--era auto (default) probes server/discover first, bounded by a timeout, and falls back to initialize; a stdio server is started again for the probe. --era legacy skips the probe (a registry entry's `era` applies when unset).";

/** Validate an era string (a `--era` value or a registry field). */
export function parseEra(value: unknown, what = "--era"): Era | undefined {
  if (value === undefined) return undefined;
  if (value === "legacy" || value === "auto") return value;
  throw new Error(`${what} must be "legacy" (initialize handshake) or "auto" (default: try server/discover first, fall back to initialize)`);
}

/** The SDK `Client` options that select an era: nothing for `legacy`, a bounded `server/discover` probe for `auto`. */
export function versionNegotiationFor(era: Era): { versionNegotiation?: { mode: "auto"; probe: { timeoutMs: number } } } {
  if (era === "legacy") return {};
  const fromEnv = Number(process.env.MCPQ_ERA_PROBE_TIMEOUT_MS);
  return { versionNegotiation: { mode: "auto", probe: { timeoutMs: Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : ERA_PROBE_TIMEOUT_MS } } };
}

const isProbeTimeout = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "REQUEST_TIMEOUT";

/**
 * Connect honouring an era. `auto` bounds the `server/discover` probe: on stdio the SDK treats a silent
 * server as legacy and falls back to `initialize` itself; on HTTP a probe timeout is retried once with the
 * plain legacy handshake on a fresh client, so a server that never answers the probe cannot hang the caller
 * for the SDK's full request timeout. Caller owns `close()`.
 */
export async function connectEra(opts: ConnectOptions, era: Era = opts.era ?? DEFAULT_ERA, extra: { capabilities?: ClientCapabilities } = {}): Promise<{ client: Client; close: () => Promise<void> }> {
  const make = (e: Era): Client => new Client({ name: opts.clientName ?? "mcp-query", version: "0.0.1" }, { capabilities: extra.capabilities ?? {}, ...versionNegotiationFor(e) });
  const open = async (e: Era): Promise<{ client: Client; close: () => Promise<void> }> => {
    const client = make(e);
    try {
      await client.connect(buildTransport(opts));
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return { client, close: () => client.close().catch(() => {}) };
  };
  if (era === "legacy") return open("legacy");
  try {
    return await open("auto");
  } catch (err) {
    if (opts.url && isProbeTimeout(err)) return open("legacy");
    throw err;
  }
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
    if (!hasAuthHeader) {
      init.authProvider = captureProvider(opts.url);
      // Token refresh runs through the transport's fetch — normalize null-valued token
      // fields (some servers send "refresh_token": null, which the SDK schema rejects).
      init.fetch = tokenNormalizingFetch;
    }
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

/**
 * Connect a live SDK client from connect options; caller is responsible for `close()`.
 * The era is `opts.era`, default `auto` (a bounded `server/discover` probe, then `initialize`): this is
 * {@link connectEra}, so a silent server cannot hang the caller and a stdio server is not left running twice.
 * Pass `era: "legacy"` for the plain `initialize` handshake this function used before it defaulted to `auto`.
 */
export async function connectClient(opts: ConnectOptions): Promise<{ client: Client; close: () => Promise<void> }> {
  return connectEra(opts);
}

/**
 * Connect, capture the capability surface, and close. The captured contract records the handshake that
 * produced it in `protocol.era`; the handshake is `opts.era` (default `auto`, see {@link connectClient}).
 */
export async function captureFrom(opts: ConnectOptions, extra: { card?: ContractCard } = {}): Promise<Contract> {
  const { client, close } = await connectClient(opts);
  try {
    return await captureContract(client, extra.card ? { card: extra.card } : {});
  } finally {
    await close();
  }
}

/**
 * Resolve the era for a CLI: an explicit `--era` flag beats a registry pin (`target.era`), which beats the default.
 * Returns the connect options with the winning era filled in.
 */
export function withEra(target: ConnectOptions, flagValue: string | undefined): ConnectOptions & { era: Era } {
  return { ...target, era: parseEra(flagValue) ?? target.era ?? DEFAULT_ERA };
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
