#!/usr/bin/env node
// mcpq — the unified MCP CLI. One umbrella over three families of verbs:
//
//   Tools     codegen · inspect · contract · lint · docs · bench · record · gate
//             → delegate to the existing per-tool CLI (lazy-loaded).
//   Registry  add · servers(ls) · remove(rm) · get · import · login · logout
//             → a named catalog of MCP servers (.mcp.json / ~/.mcp-query/servers.json).
//   Client    tools · call · read · prompt · ping
//             → drive a live server (registered name | URL | inline flags).
//
//   mcpq lint everything                     # tool verb, by registered name
//   mcpq add linear https://mcp.linear.app/sse
//   mcpq tools linear                        # list a live server's tools
//   mcpq call linear 'create_issue(title: "Bug", team: "ENG")'

import {
  addServer,
  removeServer,
  getServer,
  listServers,
  importFrom,
  resolveServer,
  authenticate,
  hasCachedAuth,
  tokenCachePath,
  type RegistryEntry,
  type Scope,
} from "../../mcp-contract/src/index.js";
import { registryVerbs, subcommandVerbs } from "./registry-verbs.js";
import { formatResult } from "./format.js";
import * as client from "./invoke.js";
import type { InvokeFlags } from "./invoke.js";
import { session } from "./session.js";

const CLIENT_VERBS = ["tools", "call", "read", "prompt", "ping", "session"] as const;
const REGISTRY_VERBS: Record<string, string> = {
  add: "Register a server (stdio command or http/sse url)",
  servers: "List registered servers (alias: ls)",
  remove: "Remove a registered server (alias: rm)",
  get: "Show a registered server's entry",
  import: "Import servers from claude | cursor | vscode | <path>",
  login: "OAuth-authenticate a registered server or url",
  logout: "Forget cached OAuth tokens for a server or url",
};
const CLIENT_DESCRIBE: Record<string, string> = {
  tools: "List a live server's tools (--resources / --prompts / --schema / --json)",
  call: "Call a tool (flags or a function-call string; coerced by inputSchema)",
  read: "Read a resource by URI",
  prompt: "Get a prompt by name",
  ping: "Check that a server is reachable",
  session: "Open an interactive REPL holding one live connection",
};

// ── generic flag parsing for the registry/client layers ─────────────────────────
// Collects --flags (value or boolean), repeated --header, and leftover positionals.

interface Parsed {
  positionals: string[];
  flags: Record<string, string | true>;
  headers: string[];
}

const BOOLEAN_FLAGS = new Set(["json", "raw", "schema", "yes", "resources", "prompts"]);

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const headers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") {
      headers.push(argv[++i] ?? "");
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // Known boolean flags never consume the next token (so it stays a positional).
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, headers };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

// ── help ─────────────────────────────────────────────────────────────────────

export function helpText(): string {
  const section = (title: string, rows: Array<[string, string]>): string => {
    const w = Math.max(...rows.map(([k]) => k.length));
    const lines = rows.map(([k, d]) => `  ${k.padEnd(w)}  ${d}`);
    return `${title}\n${lines.join("\n")}`;
  };
  return [
    "mcpq — the unified MCP CLI",
    "",
    "Usage: mcpq <verb> [args] [--json|--raw]",
    "",
    section(
      "Tools",
      Object.entries(registryVerbs).map(([k, v]) => [k, v.describe] as [string, string]),
    ),
    "",
    section(
      "Registry",
      Object.entries(REGISTRY_VERBS).map(([k, d]) => [k, d] as [string, string]),
    ),
    "",
    section(
      "Client",
      CLIENT_VERBS.map((k) => [k, CLIENT_DESCRIBE[k]!] as [string, string]),
    ),
    "",
    "Examples:",
    '  mcpq add linear https://mcp.linear.app/sse',
    "  mcpq servers --json",
    "  mcpq tools linear",
    '  mcpq call linear \'create_issue(title: "Bug", team: "ENG")\'',
    "  mcpq lint everything            # tool verb by registered name",
    "",
  ].join("\n");
}

// ── registry verbs ─────────────────────────────────────────────────────────────

async function runRegistry(verb: string, p: Parsed): Promise<void> {
  const scope = (str(p.flags.scope) as Scope | undefined) ?? "home";
  switch (verb) {
    case "add": {
      const [name, maybeUrl] = p.positionals;
      if (!name) throw new Error("usage: mcpq add <name> (<url> | --command <c> [--args <a>] | --url <u>) [--header \"K: V\"]…");
      const headers = headersToRecord(p.headers);
      const entry: RegistryEntry = {};
      if (str(p.flags.description)) entry.description = str(p.flags.description);
      const url = maybeUrl && /^https?:\/\//i.test(maybeUrl) ? maybeUrl : str(p.flags.url);
      if (url) {
        entry.url = url;
        entry.type = "http";
        if (Object.keys(headers).length) entry.headers = headers;
      } else if (str(p.flags.command)) {
        entry.command = str(p.flags.command);
        const args = str(p.flags.args);
        if (args) entry.args = args.split(" ").filter(Boolean);
        entry.type = "stdio";
      } else {
        throw new Error("provide a <url> positional, --url <u>, or --command <c> [--args <a>]");
      }
      const path = addServer(name, entry, scope, { config: str(p.flags.config) });
      console.log(`added "${name}" → ${path}`);
      return;
    }
    case "servers":
    case "ls": {
      const list = listServers({ config: str(p.flags.config) });
      if (p.flags.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      if (!list.length) {
        console.log("no servers registered — add one:  mcpq add <name> <url|--command …>");
        return;
      }
      const rows = list.map((s) => ({
        name: s.name,
        kind: s.kind,
        entry: s.entry.url ?? `${s.entry.command ?? ""} ${(s.entry.args ?? []).join(" ")}`.trim(),
        source: s.source,
      }));
      console.log(formatResult(rows, "human"));
      return;
    }
    case "remove":
    case "rm": {
      const [name] = p.positionals;
      if (!name) throw new Error("usage: mcpq remove <name>");
      // removeServer only honors `--config` when a scope is given (scope picks the config path);
      // default to "home" so an explicit --config is targeted rather than ignored.
      const rmScope = (str(p.flags.scope) as Scope | undefined) ?? (str(p.flags.config) ? "home" : undefined);
      const path = removeServer(name, rmScope, { config: str(p.flags.config) });
      console.log(path ? `removed "${name}" from ${path}` : `"${name}" not found`);
      return;
    }
    case "get": {
      const [name] = p.positionals;
      if (!name) throw new Error("usage: mcpq get <name>");
      const entry = getServer(name, { config: str(p.flags.config) });
      if (!entry) {
        console.error(`"${name}" not found`);
        process.exit(1);
      }
      console.log(p.flags.json ? JSON.stringify(entry, null, 2) : formatResult([{ name, ...flatEntry(entry) }], "human"));
      return;
    }
    case "import": {
      const [source] = p.positionals;
      if (!source) throw new Error("usage: mcpq import <claude|cursor|vscode|path>");
      const servers = importFrom(source);
      let count = 0;
      for (const [name, entry] of Object.entries(servers)) {
        addServer(name, entry, scope, { config: str(p.flags.config) });
        count++;
      }
      console.log(`imported ${count} server${count === 1 ? "" : "s"} from ${source}`);
      return;
    }
    case "login": {
      const [ref] = p.positionals;
      if (!ref) throw new Error("usage: mcpq login <name|url> [--scope home|project]");
      const opts = resolveServer(ref, { config: str(p.flags.config) });
      if (!opts.url) throw new Error(`"${ref}" is not an http/sse server (OAuth applies to remote servers only)`);
      console.error(`authenticating ${opts.url} …`);
      await authenticate(opts.url);
      console.log(`logged in — tokens cached at ${tokenCachePath(opts.url)}`);
      return;
    }
    case "logout": {
      const [ref] = p.positionals;
      if (!ref) throw new Error("usage: mcpq logout <name|url>");
      const opts = resolveServer(ref, { config: str(p.flags.config) });
      if (!opts.url) throw new Error(`"${ref}" is not an http/sse server`);
      const path = tokenCachePath(opts.url);
      if (hasCachedAuth(opts.url)) {
        const { unlink } = await import("node:fs/promises");
        await unlink(path).catch(() => {});
        console.log(`logged out — removed ${path}`);
      } else {
        console.log(`no cached tokens for ${opts.url}`);
      }
      return;
    }
    default:
      throw new Error(`unknown registry verb "${verb}"`);
  }
}

function headersToRecord(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of headers) {
    const i = item.indexOf(":");
    if (i > 0) out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return out;
}

function flatEntry(entry: RegistryEntry): Record<string, string> {
  return {
    kind: entry.url ? (entry.type === "sse" ? "sse" : "http") : "stdio",
    entry: entry.url ?? `${entry.command ?? ""} ${(entry.args ?? []).join(" ")}`.trim(),
    description: entry.description ?? "",
  };
}

// ── client verbs ────────────────────────────────────────────────────────────────
//
// Client verbs need a different split from registry verbs: only the *connection/output*
// flags are ours to consume — everything else (positionals AND tool-arg flags like
// `--title "Bug"`) must pass through untouched to `call`/`prompt`. So we strip the known
// flags and keep the remaining tokens verbatim (preserving their order).

// Connection + output flags we own. The boolean ones never consume a following token.
const CLIENT_VALUE_FLAGS = new Set(["command", "args", "url", "bearer", "config"]);
const CLIENT_BOOL_FLAGS = new Set(["json", "raw", "schema", "yes", "resources", "prompts"]);

interface ClientParse {
  flags: InvokeFlags;
  rest: string[]; // positionals + passthrough tool-arg tokens, in original order
}

function parseClient(argv: string[]): ClientParse {
  const f: InvokeFlags = { headers: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") {
      f.headers!.push(argv[++i] ?? "");
    } else if (a.startsWith("--") && CLIENT_BOOL_FLAGS.has(a.slice(2))) {
      const key = a.slice(2);
      if (key === "json") f.json = true;
      else if (key === "raw") f.raw = true;
      else if (key === "schema") f.schema = true;
      else if (key === "yes") f.yes = true;
      else if (key === "resources") f.resources = true;
      else if (key === "prompts") f.prompts = true;
    } else if (a.startsWith("--") && CLIENT_VALUE_FLAGS.has(a.slice(2))) {
      const key = a.slice(2);
      const val = argv[++i] ?? "";
      if (key === "command") f.command = val;
      else if (key === "args") f.args = val;
      else if (key === "url") f.url = val;
      else if (key === "bearer") f.bearer = val;
      else if (key === "config") f.config = val;
    } else {
      rest.push(a); // positional, or a tool-arg flag like `--title` (kept verbatim)
    }
  }
  return { flags: f, rest };
}

async function runClient(verb: string, argv: string[]): Promise<void> {
  const { flags: f, rest } = parseClient(argv);
  // The first leftover token is the server ref (name | url) UNLESS the connection was given
  // inline via --command/--url. Everything after that is the verb's own arguments.
  const hasInline = !!(f.command || f.url);
  const tokens = [...rest];
  let serverRef: string | undefined;
  if (!hasInline && tokens.length) serverRef = tokens.shift();

  switch (verb) {
    case "tools":
      return client.tools(serverRef, f);
    case "ping":
      return client.ping(serverRef, f);
    case "session":
      return session(serverRef, f);
    case "call": {
      // For a function-call string `'tool(args)'` the tool name comes from the expr, so the
      // single token is BOTH the name source and arg source → leave it in argTokens.
      if (tokens.length === 1 && /^[A-Za-z_][\w.-]*\s*\(/.test(tokens[0]!)) {
        return client.call(serverRef, undefined, tokens, f);
      }
      const toolName = tokens.shift();
      return client.call(serverRef, toolName, tokens, f);
    }
    case "read": {
      const uri = tokens.shift();
      if (!uri) throw new Error("usage: mcpq read <server> <uri>");
      return client.read(serverRef, uri, f);
    }
    case "prompt": {
      const name = tokens.shift();
      if (!name) throw new Error("usage: mcpq prompt <server> <name> [args…]");
      return client.prompt(serverRef, name, tokens, f);
    }
    default:
      throw new Error(`unknown client verb "${verb}"`);
  }
}

// ── delegation to tool CLIs ──────────────────────────────────────────────────────

/**
 * Nicety: for tool verbs WITHOUT their own subcommands (lint/docs/bench/codegen/inspect),
 * if the first token is a bare word (not a `-flag`), rewrite it to `--server <word>` so
 * `mcpq lint everything` works. contract/record own their subcommands → left untouched.
 */
function rewriteToolArgs(verb: string, rest: string[]): string[] {
  if (subcommandVerbs.has(verb)) return rest;
  const first = rest[0];
  if (first && !first.startsWith("-")) return ["--server", first, ...rest.slice(1)];
  return rest;
}

async function runTool(verb: string, rest: string[]): Promise<void> {
  const mod = await registryVerbs[verb]!.load();
  await mod.run(rewriteToolArgs(verb, rest));
}

// ── entry ─────────────────────────────────────────────────────────────────────

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const verb = argv[0];
  const rest = argv.slice(1);

  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    console.log(helpText());
    return;
  }

  if (verb in registryVerbs) return runTool(verb, rest);
  if (verb === "servers" || verb === "ls" || verb === "remove" || verb === "rm" || verb in REGISTRY_VERBS) {
    return runRegistry(verb, parse(rest));
  }
  if ((CLIENT_VERBS as readonly string[]).includes(verb)) return runClient(verb, rest);

  console.error(`unknown verb "${verb}"\n`);
  console.error(helpText());
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error("[mcpq]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
