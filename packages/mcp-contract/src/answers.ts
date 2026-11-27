// Answering multi round-trip (`input_required`) requests non-interactively: `--answer key=value`
// parsing, building the response for each pending request, and the retry loop. Lives here (not in
// packages/cli) because `mcp-record record --call` needs the same behaviour and the dependency
// direction is cli -> tools; mcp-contract is the shared library for the tool CLIs. Pure: no Node modules.

import type { JSONSchema } from "./schema.js";

/**
 * Coerce a whole raw arg map by a tool's inputSchema (each value retyped per `coerce`).
 * Exported so the daemon can coerce flag-style string args without re-deriving the logic.
 */
export function coerceArgs(schema: JSONSchema | undefined, rawArgs: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs)) args[k] = coerce(k, v, schema);
  return args;
}

/** Coerce a raw string token to the type the tool's inputSchema declares for `key`. */
function coerce(key: string, raw: unknown, schema: JSONSchema | undefined): unknown {
  // Already a non-string (came from a parsed function-call literal) — keep it.
  if (typeof raw !== "string") return raw;
  const prop = schema?.properties?.[key];
  const t = Array.isArray(prop?.type) ? prop?.type[0] : prop?.type;
  switch (t) {
    case "number":
    case "integer": {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : raw;
    case "object":
    case "array":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    case "string":
      return raw;
    default: {
      // No schema hint: best-effort JSON for objects/arrays, leave the rest as a string.
      if (/^[[{]/.test(raw.trim())) {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      return raw;
    }
  }
}


export type PendingRequests = Record<string, { method: string; params?: Record<string, unknown> }>;

/** Thrown when a round needs answers the caller did not supply. Carries the pending requests for --json output. */
export class InputRequiredError extends Error {
  constructor(readonly pending: PendingRequests, readonly unanswered: string[], readonly hadAnswers: boolean) {
    super(
      `input required: the server asked ${Object.keys(pending).length} question(s) and ${unanswered.length} ${hadAnswers ? "still need" : "have"} no --answer.\n` +
        `${describeRequests(pending)}\n` +
        `Re-run with --answer <key>=<value> for each (the key is the request key, or the name of a form field).`,
    );
    this.name = "InputRequiredError";
  }
}

export function describeRequests(pending: PendingRequests): string {
  return Object.entries(pending)
    .map(([key, r]) => {
      const p = r.params ?? {};
      const props = (p.requestedSchema as { properties?: Record<string, { type?: string }> } | undefined)?.properties;
      const fields = props ? `  fields: ${Object.entries(props).map(([k, v]) => `${k} (${v?.type ?? "any"})`).join(", ")}` : "";
      const what = typeof p.message === "string" ? ` "${p.message}"` : typeof p.url === "string" ? ` ${p.url}` : "";
      return `  ${key}  ${r.method}${p.mode === "url" ? " (url)" : ""}${what}${fields}`;
    })
    .join("\n");
}

/** Split repeated `--answer key=value` tokens. Later duplicates win. */
export function parseAnswers(tokens: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tokens) {
    const i = t.indexOf("=");
    if (i <= 0) throw new Error(`--answer expects key=value, got "${t}"`);
    out.set(t.slice(0, i).trim(), t.slice(i + 1));
  }
  return out;
}

const ACTIONS = new Set(["accept", "decline", "cancel"]);

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Build the response for one input request from the supplied answers, or undefined when it cannot be
 * answered. By request key: a JSON object with `action` (elicitation) or any JSON object (sampling, roots)
 * is used verbatim; `accept` / `decline` / `cancel` answer an elicitation; a bare value answers a form with
 * a single field. By field name: `--answer <field>=<value>` fills that field of any pending form
 * that declares it (all required fields must be supplied).
 */
export function answerFor(key: string, req: PendingRequests[string], answers: Map<string, string>, used: Set<string>): Record<string, unknown> | undefined {
  const params = req.params ?? {};
  const isElicit = req.method === "elicitation/create";
  const raw = answers.get(key);
  if (raw !== undefined) {
    const json = tryJson(raw);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      used.add(key);
      return isElicit && !("action" in json) ? { action: "accept", content: json as Record<string, unknown> } : (json as Record<string, unknown>);
    }
    if (isElicit) {
      if (ACTIONS.has(raw)) {
        used.add(key);
        return { action: raw };
      }
      const schema = params.requestedSchema as JSONSchema | undefined;
      const names = Object.keys(schema?.properties ?? {});
      if (params.mode !== "url" && names.length === 1) {
        used.add(key);
        return { action: "accept", content: coerceArgs(schema, { [names[0]!]: raw }) };
      }
      throw new Error(`--answer ${key}=…: this form has ${names.length || "no"} fields (${names.join(", ") || "-"}); pass a JSON object, or answer by field name (--answer ${names[0] ?? "field"}=<value>)`);
    }
    throw new Error(`--answer ${key}=…: ${req.method} needs a JSON object as the answer`);
  }
  if (isElicit && params.mode !== "url") {
    const schema = params.requestedSchema as (JSONSchema & { required?: string[] }) | undefined;
    const names = Object.keys(schema?.properties ?? {});
    const given = names.filter((n) => answers.has(n));
    if (!given.length) return undefined;
    if ((schema?.required ?? []).some((r) => !answers.has(r))) return undefined;
    for (const n of given) used.add(n);
    return { action: "accept", content: coerceArgs(schema, Object.fromEntries(given.map((n) => [n, answers.get(n)!]))) };
  }
  return undefined;
}

const MAX_ROUNDS = 8;

/**
 * Run a request through its `input_required` rounds, answering from `--answer`. `send` issues one round
 * (the SDK in manual mode, so the interim result is visible). Throws {@link InputRequiredError} as soon as a
 * round has a question nobody answered, so a missing answer is a clear non-zero exit instead of a hang.
 */
export async function runRounds<R>(send: (retry: { inputResponses?: Record<string, unknown>; requestState?: string }) => Promise<R>, answerTokens: string[]): Promise<R> {
  const answers = parseAnswers(answerTokens);
  const used = new Set<string>();
  let retry: { inputResponses?: Record<string, unknown>; requestState?: string } = {};
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await send(retry);
    const r = result as { resultType?: string; inputRequests?: PendingRequests; requestState?: string };
    if (r?.resultType !== "input_required") {
      const unused = [...answers.keys()].filter((k) => !used.has(k));
      if (unused.length) console.error(`note: unused --answer ${unused.join(", ")}`);
      return result;
    }
    const pending = r.inputRequests ?? {};
    const responses: Record<string, unknown> = {};
    const unanswered: string[] = [];
    for (const [key, req] of Object.entries(pending)) {
      const a = answerFor(key, req, answers, used);
      if (a === undefined) unanswered.push(key);
      else responses[key] = a;
    }
    if (unanswered.length) throw new InputRequiredError(pending, unanswered, answers.size > 0);
    retry = { inputResponses: responses, ...(r.requestState !== undefined ? { requestState: r.requestState } : {}) };
  }
  throw new Error(`the server kept asking for input after ${MAX_ROUNDS} rounds; giving up`);
}
