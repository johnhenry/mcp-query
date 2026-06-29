// Server registry — a named catalog of MCP servers, honoring the de-facto `.mcp.json` /
// `mcpServers` standard (shared by Claude, Cursor, VS Code) so existing configs work as-is.
// Resolution merges (project `.mcp.json` ▸ user `~/.mcp-query/servers.json`), and a registry
// entry maps onto the existing `ConnectOptions` so every tool gains named-server support.
// Secrets are NOT stored here — OAuth lives in the `~/.mcp-query/oauth/` cache (oauth.ts).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { connectFromFlags, type ConnectOptions } from "./connect.js";

/** A server entry in the standard `mcpServers` shape (stdio OR remote). */
export interface RegistryEntry {
  description?: string;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // remote (Streamable HTTP / SSE)
  type?: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPServersFile {
  mcpServers: Record<string, RegistryEntry>;
}

export type Scope = "home" | "project";

export const USER_CONFIG = join(homedir(), ".mcp-query", "servers.json");

/** Expand `${VAR}` and `${VAR:-default}` from process.env. */
export function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => process.env[name] ?? def ?? "");
}

function expandRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expandEnv(v)]));
}

/** Map a standard registry entry onto ConnectOptions (the shape every tool already consumes). */
export function entryToConnectOptions(entry: RegistryEntry): ConnectOptions {
  const headers = expandRecord(entry.headers);
  if (entry.url) return { url: expandEnv(entry.url), headers };
  if (entry.command) {
    return {
      command: expandEnv(entry.command),
      args: (entry.args ?? []).map(expandEnv).join(" "),
      env: expandRecord(entry.env),
      cwd: entry.cwd ? expandEnv(entry.cwd) : undefined,
    };
  }
  throw new Error("server entry needs a `command` (stdio) or `url` (http/sse)");
}

function readServersFile(path: string): Record<string, RegistryEntry> {
  if (!existsSync(path)) return {};
  const data = JSON.parse(readFileSync(path, "utf8")) as Partial<MCPServersFile> & { servers?: Record<string, RegistryEntry> };
  return data.mcpServers ?? data.servers ?? {};
}

/** Walk up from `cwd` looking for a project `.mcp.json`. */
export function findProjectConfig(cwd: string = process.cwd()): string | undefined {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, ".mcp.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface RegistryOptions {
  /** Explicit config file (overrides discovery). */
  config?: string;
  /** Base dir for project `.mcp.json` discovery. Default process.cwd(). */
  cwd?: string;
}

/** Merge user + project servers (project wins), or just `--config` when given. */
export function loadRegistry(opts: RegistryOptions = {}): Record<string, RegistryEntry> {
  if (opts.config) return readServersFile(opts.config);
  const user = readServersFile(USER_CONFIG);
  const projectPath = findProjectConfig(opts.cwd);
  const project = projectPath ? readServersFile(projectPath) : {};
  return { ...user, ...project };
}

export interface ServerListing {
  name: string;
  entry: RegistryEntry;
  source: string;
  kind: "stdio" | "http" | "sse";
}

export function listServers(opts: RegistryOptions = {}): ServerListing[] {
  const userPath = USER_CONFIG;
  const projectPath = opts.config ?? findProjectConfig(opts.cwd);
  const sources: Array<[string, Record<string, RegistryEntry>]> = opts.config
    ? [[opts.config, readServersFile(opts.config)]]
    : [
        [userPath, readServersFile(userPath)],
        ...(projectPath ? ([[projectPath, readServersFile(projectPath)]] as Array<[string, Record<string, RegistryEntry>]>) : []),
      ];
  const merged = new Map<string, ServerListing>();
  for (const [source, servers] of sources) {
    for (const [name, entry] of Object.entries(servers)) {
      merged.set(name, { name, entry, source, kind: entry.url ? (entry.type === "sse" ? "sse" : "http") : "stdio" });
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const isUrl = (ref: string): boolean => /^https?:\/\//i.test(ref);

/** Resolve a server reference (registered name | URL) to ConnectOptions. */
export function resolveServer(ref: string, opts: RegistryOptions = {}): ConnectOptions {
  if (isUrl(ref)) return { url: ref, headers: {} };
  const entry = loadRegistry(opts)[ref];
  if (!entry) throw new Error(`unknown server "${ref}" — add it with:  mcpq add ${ref} <url|--command …>`);
  return entryToConnectOptions(entry);
}

/**
 * Universal connect resolution for every CLI: a `--server <name|url>` flag (augmentable with
 * --header/--bearer) wins; otherwise fall back to the classic --command/--url flags.
 */
export function resolveConnect(flags: Record<string, string>, headerArgs: string[] = [], opts: RegistryOptions = {}): ConnectOptions {
  if (flags.server) {
    const base = resolveServer(flags.server, { config: flags.config, ...opts });
    const extra = connectFromFlags(flags, headerArgs).headers ?? {};
    return { ...base, headers: { ...base.headers, ...extra } };
  }
  return connectFromFlags(flags, headerArgs);
}

// ── mutation (add / remove / get / import) ────────────────────────────────────

function configPathForScope(scope: Scope, opts: RegistryOptions = {}): string {
  if (opts.config) return opts.config;
  if (scope === "project") return findProjectConfig(opts.cwd) ?? join(opts.cwd ?? process.cwd(), ".mcp.json");
  return USER_CONFIG;
}

function writeServersFile(path: string, servers: Record<string, RegistryEntry>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}

export function addServer(name: string, entry: RegistryEntry, scope: Scope = "home", opts: RegistryOptions = {}): string {
  const path = configPathForScope(scope, opts);
  const servers = readServersFile(path);
  servers[name] = entry;
  writeServersFile(path, servers);
  return path;
}

export function removeServer(name: string, scope?: Scope, opts: RegistryOptions = {}): string | undefined {
  const paths = scope ? [configPathForScope(scope, opts)] : [USER_CONFIG, findProjectConfig(opts.cwd)].filter((p): p is string => !!p);
  for (const path of paths) {
    const servers = readServersFile(path);
    if (name in servers) {
      delete servers[name];
      writeServersFile(path, servers);
      return path;
    }
  }
  return undefined;
}

export function getServer(name: string, opts: RegistryOptions = {}): RegistryEntry | undefined {
  return loadRegistry(opts)[name];
}

/** Known config locations for `mcpq import <source>`. */
function sourcePath(source: string): string {
  switch (source) {
    case "claude":
      return join(homedir(), ".claude.json");
    case "cursor":
      return join(homedir(), ".cursor", "mcp.json");
    case "vscode":
      return join(homedir(), ".config", "Code", "User", "mcp.json");
    default:
      return source; // treat as a literal path
  }
}

/** Read another tool's config and return its `mcpServers` map (handles Claude's nested shape). */
export function importFrom(source: string): Record<string, RegistryEntry> {
  const path = sourcePath(source);
  if (!existsSync(path)) throw new Error(`no config found at ${path}`);
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    mcpServers?: Record<string, RegistryEntry>;
    servers?: Record<string, RegistryEntry>;
    projects?: Record<string, { mcpServers?: Record<string, RegistryEntry> }>;
  };
  if (data.mcpServers) return data.mcpServers;
  if (data.servers) return data.servers;
  // Claude's ~/.claude.json nests servers under projects — merge them all.
  const merged: Record<string, RegistryEntry> = {};
  for (const proj of Object.values(data.projects ?? {})) Object.assign(merged, proj.mcpServers ?? {});
  return merged;
}
