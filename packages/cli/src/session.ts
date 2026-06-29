// `mcpq session <server>` — an interactive REPL holding ONE live connection for the
// sitting. Successive commands share the same session (stateful stdio servers like a
// browser keep their tab/cookies between commands) without any background daemon, socket,
// or cross-invocation supervision — a single foreground process. The 80/20 of the daemon.

import { createInterface, type Interface } from "node:readline";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectFor, opTools, opCall, opRead, opPrompt, opPing, type InvokeFlags } from "./invoke.js";

const SESSION_VERBS = new Set(["tools", "resources", "prompts", "call", "read", "prompt", "ping", "help", "exit", "quit", "json", "human"]);

const HELP = `commands:
  tools [--schema]        list tools (also: resources, prompts)
  call <tool> <args…>     call a tool — flags (--k v / k=v) or  tool(a: 1, b: "x")
  <tool> <args…>          shorthand for: call <tool> <args…>
  read <uri>              read a resource
  prompt <name> <args…>   get a prompt
  ping                    liveness check
  json | human            toggle output mode for the session
  help                    this list
  exit | quit             leave (Ctrl-D also works)`;

/** Tokenize a command line on whitespace, respecting single/double quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || buf) out.push(buf);
      buf = "";
      has = false;
      continue;
    }
    buf += c;
    has = true;
  }
  if (has || buf) out.push(buf);
  return out;
}

/** Is `rest` a function-call expression like `tool(a: 1)`? Then it must be passed whole. */
const isCallExpr = (s: string): boolean => /^[A-Za-z_][\w.-]*\s*\([\s\S]*\)\s*$/.test(s.trim());

async function dispatch(client: Client, line: string, f: InvokeFlags): Promise<"continue" | "exit"> {
  const sp = line.indexOf(" ");
  const verb = (sp === -1 ? line : line.slice(0, sp)).trim();
  const rest = (sp === -1 ? "" : line.slice(sp + 1)).trim();

  switch (verb) {
    case "help":
      console.log(HELP);
      return "continue";
    case "exit":
    case "quit":
      return "exit";
    case "json":
      f.json = true;
      f.raw = false;
      console.error("output: json");
      return "continue";
    case "human":
      f.json = false;
      f.raw = false;
      console.error("output: human");
      return "continue";
    case "tools":
      await opTools(client, { ...f, ...(tokenize(rest).includes("--schema") ? { schema: true } : {}) });
      return "continue";
    case "resources":
      await opTools(client, { ...f, resources: true });
      return "continue";
    case "prompts":
      await opTools(client, { ...f, prompts: true });
      return "continue";
    case "ping":
      await opPing(client, f);
      return "continue";
    case "read":
      await opRead(client, rest, f);
      return "continue";
    case "prompt": {
      const toks = tokenize(rest);
      await opPrompt(client, toks[0] ?? "", toks.slice(1), f);
      return "continue";
    }
    case "call": {
      if (isCallExpr(rest)) {
        await opCall(client, undefined, [rest], f);
      } else {
        const toks = tokenize(rest);
        await opCall(client, toks[0], toks.slice(1), f);
      }
      return "continue";
    }
    default: {
      // Bareword shorthand: treat the whole line as a tool call.
      if (isCallExpr(line)) {
        await opCall(client, undefined, [line.trim()], f);
      } else {
        const toks = tokenize(line);
        await opCall(client, toks[0], toks.slice(1), f);
      }
      return "continue";
    }
  }
}

export async function session(serverRef: string | undefined, f: InvokeFlags): Promise<void> {
  const name = serverRef ?? f.url ?? f.command ?? "server";
  const { client, close } = await connectFor(serverRef, f, "mcpq-session");
  try {
    const list = await client.listTools().then((r) => r.tools).catch(() => []);
    console.error(`● connected to ${name} — ${list.length} tools. Type "help" or "exit".`);
    await runRepl(client, name, f);
  } finally {
    await close();
    console.error("● session closed");
  }
}

/**
 * Event-driven REPL: serialize each `line` through a promise chain (commands can arrive
 * faster than they run, and `dispatch` is async). This works for BOTH an interactive TTY
 * and piped stdin — unlike `for await (line of rl)`, which races the close on EOF.
 */
function runRepl(client: Client, name: string, f: InvokeFlags): Promise<void> {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`${name}> `);
  let chain: Promise<void> = Promise.resolve();
  let closing = false;
  let closed = false;
  // Prompt only while open (piped stdin closes on EOF before queued commands finish draining).
  const prompt = (): void => {
    if (!closed) try { rl.prompt(); } catch { /* closed mid-flight */ }
  };
  prompt();

  return new Promise<void>((resolve) => {
    rl.on("line", (raw) => {
      const line = raw.trim();
      chain = chain.then(async () => {
        if (closing) return;
        if (!line) return prompt();
        try {
          if ((await dispatch(client, line, f)) === "exit") {
            closing = true;
            rl.close();
            return;
          }
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
        }
        prompt();
      });
    });
    rl.on("close", () => {
      closed = true;
      void chain.then(resolve);
    });
  });
}

// exported for tests
export { tokenize, dispatch };
