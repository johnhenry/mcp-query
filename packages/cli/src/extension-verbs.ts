// Client verbs for the 2026-07-28 extensions and multi round-trip requests:
//
//   mcp-query skills <server>                         list a server's skills (skills/list)
//   mcp-query skill  <server> <uri> [--file <ref>]    read one skill file, verified against the manifest
//   mcp-query tasks get|cancel <server> <taskId>      inspect or cancel a task (SEP-2663)
//   mcp-query call|prompt … --answer key=value        answer an `input_required` round non-interactively
//
// Everything here works on an ALREADY-connected SDK client (same split as invoke.ts), speaks the
// extension methods as raw requests (the SDK has no typed surface for them on 2.0.0), and prints
// through formatResult so --json / --raw behave like the other verbs.

import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { formatResult, type OutputMode } from "./format.js";
import type { InvokeFlags } from "./invoke.js";
import { coerceArgs } from "./invoke.js";
import type { JSONSchema } from "../../mcp-contract/src/schema.js";

const log = (s: string): void => console.log(s);
const PASS = { "~standard": { version: 1, vendor: "mcp-query-cli", validate: (value: unknown) => ({ value }) } };
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const TASKS_EXT = "io.modelcontextprotocol/tasks";

function modeOf(f: InvokeFlags): OutputMode {
  if (f.raw) return "raw";
  if (f.json) return "json";
  return "human";
}

type RawClient = { request(req: { method: string; params?: unknown }, schema: unknown, opts?: unknown): Promise<unknown> };
const rawRequest = (client: Client, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (client as unknown as RawClient).request({ method, params }, PASS, { timeout: 30_000 }) as Promise<Record<string, unknown>>;

// ── skills ───────────────────────────────────────────────────────────────────

interface SkillEntry {
  uri: string;
  frontmatter?: { name?: string; description?: string };
  resources?: Array<{ uri: string; digest: string; size: number }> | "dynamic";
}

async function listAllSkills(client: Client): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await rawRequest(client, "skills/list", cursor ? { cursor } : {});
    if (!Array.isArray(page.skills)) throw new Error("server returned no `skills` array for skills/list (does it advertise io.modelcontextprotocol/skills?)");
    out.push(...(page.skills as SkillEntry[]));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);
  return out;
}

export async function opSkills(client: Client, f: InvokeFlags): Promise<void> {
  const skills = await listAllSkills(client);
  const mode = modeOf(f);
  if (mode === "json" || mode === "raw") return log(JSON.stringify(skills, null, 2));
  if (!skills.length) return log("no skills");
  log(
    formatResult(
      skills.map((s) => ({
        name: s.frontmatter?.name ?? "",
        description: s.frontmatter?.description ?? "",
        uri: s.uri,
        files: s.resources === "dynamic" ? "dynamic" : String(s.resources?.length ?? 0),
      })),
      "human",
    ),
  );
}

const sha256 = (bytes: Uint8Array): string => "sha256:" + createHash("sha256").update(bytes).digest("hex");

/** Resolve `--file` against the skill root (the SKILL.md URI minus its file name). Absolute `skill://` URIs pass through. */
export function resolveSkillFile(skillUri: string, ref: string | undefined): string {
  if (!ref) return skillUri;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return ref;
  const segments = ref.split("/");
  if (segments.includes("..") || ref.startsWith("/")) throw new Error(`--file "${ref}" must stay inside the skill (no leading "/" or ".." segments)`);
  return skillUri.slice(0, skillUri.lastIndexOf("/") + 1) + segments.filter((s) => s && s !== ".").join("/");
}

export async function opSkill(client: Client, uri: string, f: InvokeFlags): Promise<void> {
  const got = await rawRequest(client, "skills/get", { uri });
  const skill = got.skill as SkillEntry | undefined;
  if (!skill) throw new Error(`skills/get returned no skill for ${uri}`);
  const target = resolveSkillFile(skill.uri, f.file);
  const read = (await client.readResource({ uri: target })) as { contents: Array<{ uri?: string; text?: string; blob?: string; mimeType?: string }> };
  const c = read.contents[0];
  if (!c) throw new Error(`${target} returned no contents`);
  const bytes = c.text !== undefined ? new TextEncoder().encode(c.text) : Uint8Array.from(Buffer.from(c.blob ?? "", "base64"));

  let verified = false;
  if (skill.resources === "dynamic") {
    console.error(`note: "${skill.frontmatter?.name ?? uri}" publishes dynamic resources; this file is NOT verified against a manifest.`);
  } else {
    const entry = (skill.resources ?? []).find((r) => r.uri === target);
    if (!entry) throw new Error(`refusing ${target}: it is not listed in the skill's manifest (unlisted)`);
    if (bytes.byteLength !== entry.size) throw new Error(`refusing ${target}: size ${bytes.byteLength} does not match the manifest (${entry.size})`);
    const digest = sha256(bytes);
    if (digest !== entry.digest) throw new Error(`refusing ${target}: digest ${digest} does not match the manifest (${entry.digest})`);
    verified = true;
  }

  const mode = modeOf(f);
  if (mode === "json") return log(JSON.stringify({ uri: target, verified, mimeType: c.mimeType, ...(c.text !== undefined ? { text: c.text } : { blobBytes: bytes.byteLength }) }, null, 2));
  if (mode === "raw") return log(formatResult(read, "raw"));
  log(c.text !== undefined ? c.text : `[blob: ${c.mimeType ?? "binary"}, ${bytes.byteLength} bytes]`);
}

// ── tasks ────────────────────────────────────────────────────────────────────

export async function opTasks(client: Client, sub: string | undefined, taskId: string | undefined, f: InvokeFlags): Promise<void> {
  if ((sub !== "get" && sub !== "cancel") || !taskId) throw new Error("usage: mcp-query tasks get|cancel <server> <taskId>");
  const meta = { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXT]: {} } } };
  const result = await rawRequest(client, sub === "get" ? "tasks/get" : "tasks/cancel", { taskId, _meta: meta });
  const mode = modeOf(f);
  if (mode === "json" || mode === "raw") return log(JSON.stringify(result, null, 2));
  if (sub === "cancel" && result.status === undefined) return log(`cancel requested for ${taskId}`); // some servers ack with {}
  const { taskId: id, status, statusMessage, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs, result: payload, error, inputRequests } = result as Record<string, unknown>;
  log(formatResult([{ taskId: String(id ?? taskId), status: String(status ?? ""), message: String(statusMessage ?? ""), updated: String(lastUpdatedAt ?? createdAt ?? ""), ttlMs: ttlMs === null ? "none" : String(ttlMs ?? ""), pollMs: String(pollIntervalMs ?? "") }], "human"));
  if (inputRequests && typeof inputRequests === "object") log(`\npending input:\n${describeRequests(inputRequests as PendingRequests)}`);
  if (payload !== undefined) log(`\nresult:\n${JSON.stringify(payload, null, 2)}`);
  if (error !== undefined) log(`\nerror:\n${JSON.stringify(error, null, 2)}`);
}

// ── multi round-trip requests (--answer) ────────────────────────────────────

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
