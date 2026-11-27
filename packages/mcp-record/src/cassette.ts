// The cassette: a serializable log of real request→response interactions captured from
// a live MCP server, plus the identity/capabilities learned at `initialize`. Unlike a
// contract (shape only) or a shape-mock, a cassette holds the *actual results* the server
// returned — so replay is faithful, deterministic, and offline. (VCR/Polly/nock for MCP.)

import { createHash } from "node:crypto";
import type { ServerCapabilities } from "@modelcontextprotocol/server";

/** The cassette format this build writes. Bump on any change a reader of the previous version could misread. */
export const CASSETTE_VERSION = 2;

/**
 * What an interaction is part of, derived from the wire (never trusted from input):
 * - `mrtr`: a multi round-trip request (SEP-2322). `round` 0 is the original request; each retry
 *   (`requestState` / `inputResponses` on the params) is the previous round + 1. `inputRequired`
 *   marks a round whose result was `resultType: "input_required"`.
 * - `task`: the tasks extension (SEP-2663): any `tasks/*` call, or a call whose result is a task handle (`resultType: "task"`, or a `taskId` + `status`).
 * - `skill`: the skills extension (SEP-2640): `skills/*` calls.
 */
export type InteractionKind = "mrtr" | "task" | "skill";

export interface Interaction {
  method: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
  /** v2: classification of the exchange (informational; replay matches on method + params). */
  kind?: InteractionKind;
  /** v2: present on `kind: "mrtr"`. */
  mrtr?: { round: number; inputRequired: boolean };
}

/** How the recorded server was reached; lets replay serve the same era. */
export interface CassetteProtocol {
  era: "modern" | "legacy";
  /** Negotiated protocol version, when known. */
  version?: string;
  /** `supportedVersions` from `server/discover` (modern era). */
  supportedVersions?: string[];
}

export interface Cassette {
  /** Format version. Cassettes written before versioning (or at 1) are upgraded on load. */
  version: 2;
  recordedFrom?: { name?: string; version?: string };
  /** Legacy-era negotiated version (kept for readers of format 1). */
  protocolVersion?: string;
  /** v2: era and versions of the recorded connection. Absent = legacy. */
  protocol?: CassetteProtocol;
  capabilities?: ServerCapabilities;
  interactions: Interaction[];
  /**
   * SHA-256 over the canonicalized interaction list, stamped by `sealCassette` once
   * recording is complete. Tamper-*evidence*, not a signature — it detects accidental or
   * malicious hand-edits of a cassette file, it doesn't prove who recorded it. Cassettes
   * without this field (e.g. built purely in-memory, never persisted) are unverified and
   * `loadCassette` lets them through unchecked.
   */
  integrity?: string;
}

/** The format-1 shape (no `protocol`, no interaction tags). Read-only: `loadCassette` upgrades it. */
export interface CassetteV1 extends Omit<Cassette, "version" | "protocol"> {
  version?: 1;
}

export function createCassette(): Cassette {
  return { version: CASSETTE_VERSION, interactions: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Classify interactions in order, adding `kind` / `mrtr`. Idempotent and driven only by the wire
 * data, so it serves both the recorder (one at a time, with a shared `rounds` map) and the v1 upgrade.
 */
export function tagInteraction(it: Interaction, rounds: Map<string, number>): Interaction {
  const params = isRecord(it.params) ? it.params : {};
  const result = isRecord(it.result) ? it.result : {};
  const state = typeof params.requestState === "string" ? params.requestState : undefined;
  const isRetry = state !== undefined || isRecord(params.inputResponses);
  const inputRequired = result.resultType === "input_required";
  if (isRetry || inputRequired) {
    const round = isRetry ? (state !== undefined && rounds.has(state) ? rounds.get(state)! + 1 : 1) : 0;
    if (inputRequired && typeof result.requestState === "string") rounds.set(result.requestState, round);
    return { ...it, kind: "mrtr", mrtr: { round, inputRequired } };
  }
  if (it.method.startsWith("tasks/") || result.resultType === "task" || (typeof result.taskId === "string" && typeof result.status === "string")) return { ...it, kind: "task" };
  if (it.method.startsWith("skills/")) return { ...it, kind: "skill" };
  return it;
}

/** Upgrade any readable cassette (format 1 or unversioned) to the current shape. Throws on a format newer than this build understands. */
export function upgradeCassette(raw: Cassette | CassetteV1): Cassette {
  const v = (raw as { version?: unknown }).version;
  if (v !== undefined && v !== 1 && v !== CASSETTE_VERSION) {
    throw new Error(`mcp-record: cassette format version ${JSON.stringify(v)} is not supported (this build reads 1 and ${CASSETTE_VERSION}); it was probably written by a newer mcp-record`);
  }
  if (v === CASSETTE_VERSION) return raw as Cassette;
  const rounds = new Map<string, number>();
  // The old seal covered the old hash input; callers that verified it (loadCassette) re-seal.
  const { version: _drop, integrity: _seal, ...rest } = raw as CassetteV1;
  void _drop;
  void _seal;
  return {
    ...rest,
    version: CASSETTE_VERSION,
    interactions: rest.interactions.map((it) => tagInteraction(it, rounds)),
  };
}

/** Recursively key-sort an object so equal payloads stringify identically. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (k === "_meta") continue; // volatile (progress tokens etc.) — never part of identity
      out[k] = stable((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** A match key for an interaction: method + canonicalized params (minus volatile fields). */
export function interactionKey(method: string, params: unknown): string {
  return `${method} ${JSON.stringify(stable(params ?? {}))}`;
}

/** The tamper-evidence hash for a cassette's current interactions (order-sensitive; key order within each interaction is not). */
export function cassetteHash(cassette: Pick<Cassette, "interactions"> & Partial<Pick<Cassette, "protocol" | "capabilities" | "recordedFrom">> & { version?: 1 | 2 }): string {
  // Format 1 hashed the interactions only. From format 2 the header (capabilities, protocol, identity)
  // is covered too, because replay behaviour depends on it.
  const body = cassette.version === undefined || cassette.version === 1
    ? cassette.interactions
    : { protocol: cassette.protocol, capabilities: cassette.capabilities, recordedFrom: cassette.recordedFrom, interactions: cassette.interactions };
  return createHash("sha256").update(JSON.stringify(stable(body))).digest("hex");
}

/** Stamp `cassette.integrity` with its current content hash. Call once recording is complete, before persisting to disk. */
export function sealCassette(cassette: Cassette): Cassette {
  cassette.integrity = cassetteHash(cassette);
  return cassette;
}

/**
 * Parse cassette JSON, verifying its tamper-evidence hash when present. Throws on invalid
 * JSON or on a hash mismatch (the file was hand-edited or corrupted after recording).
 * Cassettes with no `integrity` field (never sealed) are parsed as-is — this is about
 * detecting tampering of a sealed cassette, not requiring every cassette to be sealed.
 */
export function loadCassette(json: string): Cassette {
  const raw = JSON.parse(json) as Cassette | CassetteV1;
  // Verify against the bytes as recorded (format-specific hash), then upgrade.
  const cassette = raw as Cassette;
  if (cassette.integrity !== undefined) {
    const actual = cassetteHash(cassette);
    if (actual !== cassette.integrity) {
      throw new Error(
        "mcp-record: cassette integrity check failed — its interactions do not match the recorded hash " +
          "(the file may have been hand-edited or corrupted since it was recorded)",
      );
    }
  }
  const upgraded = upgradeCassette(raw);
  return cassette.integrity !== undefined && upgraded !== raw ? sealCassette(upgraded) : upgraded;
}
