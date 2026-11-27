// MCP client verbs — drive a *live* server: list its tools/resources/prompts, call a tool,
// read a resource, get a prompt, ping. Every verb resolves a server reference the same way:
//   • a positional `serverRef` = a registered name OR a URL          → resolveServer
//   • no positional, inline flags (--command/--url/--bearer/--header) → resolveConnect
//
// The per-operation logic lives in `op*(client, …)` functions that act on an ALREADY-connected
// client, so the same code backs the one-shot verbs, the `session` REPL, and the daemon.
//
// `call` is the interesting one: it accepts both flag-style args (`--title "Bug"`, `team=ENG`)
// and a function-call string (`'create_issue(title: "Bug", team: "ENG")'`), coerces each value
// by the tool's inputSchema, confirms destructive calls, and renders via formatResult.

import { createInterface } from "node:readline";
import type { Client } from "@modelcontextprotocol/client";
import { connectEra, parseEra, DEFAULT_ERA, coerceArgs, type Era, InputRequiredError, runRounds, resolveServer, resolveConnect, parseCallExpr, splitKeyValue, parseLiteral, type ConnectOptions } from "../../mcp-contract/src/index.js";
import type { JSONSchema } from "../../mcp-contract/src/schema.js";

// The function-call / literal parsing now lives in mcp-contract (shared with
// `mcp-bench --call` / `mcp-record --call`); re-exported here for existing importers.
export { parseCallExpr } from "../../mcp-contract/src/index.js";
import { formatResult, toolSignature, type OutputMode, type ToolLike } from "./format.js";
import { opSkill, opSkills, opTasks } from "./extension-verbs.js";

const log = (s: string): void => console.log(s);

export interface InvokeFlags {
  /** Output mode flags. */
  json?: boolean;
  raw?: boolean;
  schema?: boolean;
  /** Skip the destructive-tool confirmation prompt. */
  yes?: boolean;
  /** Variant selectors for `tools`. */
  resources?: boolean;
  prompts?: boolean;
  /** Inline connect (used when no positional serverRef). */
  config?: string;
  command?: string;
  args?: string;
  url?: string;
  bearer?: string;
  headers?: string[];
  /** Route the verb through the keep-alive daemon (reuses a live upstream connection). */
  daemon?: boolean;
  /** `--answer key=value` (repeatable): answers for an `input_required` round (call / prompt). */
  answers?: string[];
  /** `--file <ref>` (skill): which file of the skill to read. Default SKILL.md. */
  file?: string;
  /** `--era legacy|auto`: `auto` (default) tries server/discover first (2026-07-28) and falls back to the initialize handshake; `legacy` skips the probe. A registry entry's `era` applies when this is unset. */
  era?: string;
}

function modeOf(f: InvokeFlags): OutputMode {
  if (f.raw) return "raw";
  if (f.json) return "json";
  return "human";
}

/** Resolve to ConnectOptions: a positional ref wins; otherwise fall back to inline flags. */
export function resolveInvoke(serverRef: string | undefined, f: InvokeFlags, clientName = "mcp-query"): ConnectOptions {
  if (serverRef) {
    const base = resolveServer(serverRef, { config: f.config });
    const headers = inlineHeaders(f);
    return { ...base, headers: { ...base.headers, ...headers }, clientName };
  }
  const flags: Record<string, string> = {};
  if (f.command) flags.command = f.command;
  if (f.args) flags.args = f.args;
  if (f.url) flags.url = f.url;
  if (f.bearer) flags.bearer = f.bearer;
  if (f.config) flags.config = f.config;
  return { ...resolveConnect(flags, f.headers ?? [], { config: f.config }), clientName };
}

function inlineHeaders(f: InvokeFlags): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const item of f.headers ?? []) {
    const i = item.indexOf(":");
    if (i > 0) headers[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  if (f.bearer) headers["Authorization"] = `Bearer ${f.bearer}`;
  return headers;
}

/**
 * The era a connection will use: an explicit `--era` wins, then the server's registry pin, then the default (`auto`).
 * `--answer` needs a 2026-07-28 connection, so it implies `auto` unless `--era legacy` was given outright.
 */
export function eraFor(f: InvokeFlags, pinned?: Era): Era {
  const flag = parseEra(f.era);
  if (flag === "legacy" && f.answers?.length) throw new Error("--answer needs a 2026-07-28 connection (the multi round-trip pattern); drop --era legacy");
  if (flag) return flag;
  if (f.answers?.length) return "auto";
  return pinned ?? DEFAULT_ERA;
}

/** Resolve + connect; caller owns close(). Shared by one-shot verbs, the REPL, and the daemon. */
export function connectFor(serverRef: string | undefined, f: InvokeFlags, clientName = "mcp-query"): Promise<{ client: Client; close: () => Promise<void> }> {
  const opts = resolveInvoke(serverRef, f, clientName);
  const era = eraFor(f, opts.era);
  // Declare elicitation only when we can actually answer it (from --answer).
  return connectEra(opts, era, { capabilities: f.answers?.length ? { elicitation: { form: {}, url: {} } } : {} });
}

/** Does this verb need the manual `input_required` round loop? Yes on any 2026-07-28 connection (or when `--answer` was given). */
export function usesRounds(client: Client, f: InvokeFlags): boolean {
  return !!f.answers?.length || (client as unknown as { getProtocolEra?: () => string | undefined }).getProtocolEra?.() === "modern";
}

// ── failure classification (for --json error reports) ─────────────────────────

type Issue = "auth_required" | "offline" | "http_error" | "error";

export function classify(err: unknown): { issue: Issue; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.toLowerCase();
  if (m.includes("401") || m.includes("unauthor") || m.includes("oauth") || m.includes("auth")) return { issue: "auth_required", message };
  if (m.includes("econnrefused") || m.includes("enotfound") || m.includes("offline") || m.includes("connect")) return { issue: "offline", message };
  if (/\b(4\d\d|5\d\d)\b/.test(message) || m.includes("http")) return { issue: "http_error", message };
  return { issue: "error", message };
}

/** Emit a structured failure in --json mode, else rethrow for the top-level handler. */
function fail(err: unknown, ctx: { server: string; tool?: string }, mode: OutputMode): never {
  if (mode === "json" && err instanceof InputRequiredError) {
    log(JSON.stringify({ server: ctx.server, tool: ctx.tool, issue: "input_required", message: err.message, pending: err.pending }, null, 2));
    process.exit(1);
  }
  if (mode === "json") {
    const { issue, message } = classify(err);
    log(JSON.stringify({ server: ctx.server, tool: ctx.tool, issue, message }, null, 2));
    process.exit(1);
  }
  throw err;
}

// ── value coercion ────────────────────────────────────────────────────────────

export { coerceArgs };

/**
 * Parse `call` arguments from BOTH styles. The positional `tokens` may be either:
 *   • a single function-call string `'create_issue(title: "Bug")'` (toolName then comes from it), or
 *   • a flag/eq stream: `--title "Bug" team=ENG` (toolName is the explicit first positional).
 * Returns the resolved tool name (if discovered) and the raw (pre-coercion) arg map.
 */
export function parseCallArgs(
  explicitTool: string | undefined,
  tokens: string[],
): { tool: string | undefined; args: Record<string, unknown> } {
  // function-call form: a single token that looks like `name(...)`.
  if (tokens.length === 1 && /^[A-Za-z_][\w.-]*\s*\(/.test(tokens[0]!)) {
    const parsed = parseCallExpr(tokens[0]!);
    if (parsed) return { tool: explicitTool ?? parsed.name, args: parsed.args };
  }
  // flag / key=value form.
  const args: Record<string, unknown> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true; // bare flag → boolean true
      } else {
        args[key] = next;
        i++;
      }
    } else {
      const eq = splitKeyValue(t);
      if (eq) args[eq.key] = parseLiteral(eq.value);
    }
  }
  return { tool: explicitTool, args };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ── ops: operate on an already-connected client; print; throw on error ──────────

export async function opTools(client: Client, f: InvokeFlags): Promise<void> {
  const mode = modeOf(f);
  if (f.resources) {
    const { resources } = await client.listResources();
    if (mode === "json" || mode === "raw") return log(JSON.stringify(resources, null, 2));
    return log(formatResult(resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType ?? "" })), "human"));
  }
  if (f.prompts) {
    const { prompts } = await client.listPrompts();
    if (mode === "json" || mode === "raw") return log(JSON.stringify(prompts, null, 2));
    return log(formatResult(prompts.map((p) => ({ name: p.name, description: p.description ?? "" })), "human"));
  }
  const { tools: list } = await client.listTools();
  if (f.schema) return log(JSON.stringify(list, null, 2));
  if (mode === "json" || mode === "raw") return log(JSON.stringify(list.map((t) => ({ name: t.name, description: t.description })), null, 2));
  log(list.map((t) => toolSignature(t as ToolLike)).join("\n\n"));
}

export async function opCall(client: Client, toolName: string | undefined, argTokens: string[], f: InvokeFlags): Promise<void> {
  const mode = modeOf(f);
  const { tools: list } = await client.listTools();
  const parsed = parseCallArgs(toolName, argTokens);
  const name = parsed.tool;
  if (!name) throw new Error("no tool name — pass `<tool>` or a function-call string `tool(arg: …)`");
  const def = list.find((t) => t.name === name);
  const schema = def?.inputSchema as JSONSchema | undefined;
  const args = coerceArgs(schema, parsed.args);

  if (def?.annotations?.destructiveHint && !f.yes) {
    const ok = await confirm(`Tool "${name}" is marked destructive. Proceed?`);
    if (!ok) throw new Error("aborted");
  }

  // Without --answer an `input_required` result must be visible (not swallowed by the SDK driver) so it can be reported.
  const result = usesRounds(client, f)
    ? await runRounds((retry) => client.callTool({ name, arguments: args, ...retry } as never, { allowInputRequired: true } as never) as Promise<Awaited<ReturnType<Client["callTool"]>>>, f.answers ?? [])
    : await client.callTool({ name, arguments: args });
  if (mode === "raw") return log(formatResult(result, "raw"));
  if (mode === "json") return log(formatResult(result.content, "json"));
  log(formatResult(result.content, "human"));
}

export async function opRead(client: Client, uri: string, f: InvokeFlags): Promise<void> {
  const mode = modeOf(f);
  const result = await client.readResource({ uri });
  if (mode === "raw") return log(formatResult(result, "raw"));
  if (mode === "json") return log(formatResult(result.contents, "json"));
  log(result.contents.map((c) => ("text" in c && c.text !== undefined ? c.text : `[blob: ${c.mimeType ?? "binary"}]`)).join("\n"));
}

export async function opPrompt(client: Client, name: string, argTokens: string[], f: InvokeFlags): Promise<void> {
  const mode = modeOf(f);
  const parsed = parseCallArgs(name, argTokens);
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.args)) args[k] = typeof v === "string" ? v : JSON.stringify(v);
  const result = usesRounds(client, f)
    ? await runRounds((retry) => client.getPrompt({ name, arguments: args, ...retry } as never, { allowInputRequired: true } as never) as Promise<Awaited<ReturnType<Client["getPrompt"]>>>, f.answers ?? [])
    : await client.getPrompt({ name, arguments: args });
  if (mode === "raw") return log(formatResult(result, "raw"));
  if (mode === "json") return log(formatResult(result.messages, "json"));
  log(
    result.messages
      .map((m) => {
        const c = m.content as { type: string; text?: string };
        const body = c.type === "text" ? (c.text ?? "") : `[${c.type}]`;
        return `${m.role}: ${body}`;
      })
      .join("\n"),
  );
}

export async function opPing(client: Client, f: InvokeFlags): Promise<void> {
  const mode = modeOf(f);
  const started = Date.now();
  await client.ping();
  const ms = Date.now() - started;
  if (mode === "json") return log(JSON.stringify({ ok: true, ms }, null, 2));
  log(`ok (${ms}ms)`);
}

// ── one-shot verbs: connect → op → close (fail() classifies in --json mode) ─────

async function oneShot(serverRef: string | undefined, f: InvokeFlags, ctxTool: string | undefined, run: (client: Client) => Promise<void>): Promise<void> {
  const mode = modeOf(f);
  const ctx = { server: serverRef ?? f.url ?? f.command ?? "inline", tool: ctxTool };
  let conn: { client: Client; close: () => Promise<void> };
  try {
    conn = await connectFor(serverRef, f);
  } catch (e) {
    return fail(e, ctx, mode);
  }
  try {
    await run(conn.client);
  } catch (e) {
    fail(e, ctx, mode);
  } finally {
    await conn.close();
  }
}

export const tools = (serverRef: string | undefined, f: InvokeFlags): Promise<void> => oneShot(serverRef, f, undefined, (c) => opTools(c, f));
export const call = (serverRef: string | undefined, toolName: string | undefined, argTokens: string[], f: InvokeFlags): Promise<void> =>
  oneShot(serverRef, f, toolName, (c) => opCall(c, toolName, argTokens, f));
export const read = (serverRef: string | undefined, uri: string, f: InvokeFlags): Promise<void> => oneShot(serverRef, f, undefined, (c) => opRead(c, uri, f));
export const prompt = (serverRef: string | undefined, name: string, argTokens: string[], f: InvokeFlags): Promise<void> =>
  oneShot(serverRef, f, name, (c) => opPrompt(c, name, argTokens, f));
export const ping = (serverRef: string | undefined, f: InvokeFlags): Promise<void> => oneShot(serverRef, f, undefined, (c) => opPing(c, f));

export const skills = (serverRef: string | undefined, f: InvokeFlags): Promise<void> => oneShot(serverRef, f, undefined, (c) => opSkills(c, f));
export const skill = (serverRef: string | undefined, uri: string, f: InvokeFlags): Promise<void> => oneShot(serverRef, f, undefined, (c) => opSkill(c, uri, f));
export const tasks = (serverRef: string | undefined, sub: string | undefined, taskId: string | undefined, f: InvokeFlags): Promise<void> =>
  oneShot(serverRef, f, undefined, (c) => opTasks(c, sub, taskId, f));
