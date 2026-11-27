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
import { describeRequests, type PendingRequests } from "../../mcp-contract/src/index.js";

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

// Moved to @johnhenry/mcp-contract so `mcp-record` shares it; re-exported for existing importers.
export { InputRequiredError, describeRequests, parseAnswers, answerFor, runRounds, type PendingRequests } from "../../mcp-contract/src/index.js";
