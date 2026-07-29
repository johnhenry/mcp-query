// Dependency-free GateConfig validation. Config modules are hand-written, so a typo'd
// key must fail loudly at load time instead of being silently ignored (the observed
// footgun: a redact rule with `replace` instead of `replacement` redacted nothing).
// Every error names the offending key/upstream and lists what would have been valid.

import type { GateConfig } from "./config.js";

const UPSTREAM_SHAPES =
  'a transport factory { transport: () => Transport, maxRetries?, retryDelay?, lazy?, idleMs? }, a stdio spec { command, args?, env? }, or a Streamable HTTP spec { url, headers?, getToken? }';

function fail(msg: string): never {
  throw new Error(`invalid gate config: ${msg}`);
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const isStringRecord = (v: unknown): boolean => isRecord(v) && Object.values(v).every((x) => typeof x === "string");

/** Keys with a defined value — an explicit `undefined` counts as absent (like JSON). */
const presentKeys = (obj: Record<string, unknown>): string[] => Object.keys(obj).filter((k) => obj[k] !== undefined);

function checkKeys(obj: Record<string, unknown>, valid: readonly string[], where: string): void {
  for (const k of presentKeys(obj)) {
    if (!valid.includes(k)) fail(`unknown key "${k}" in ${where} (valid keys: ${valid.join(", ")})`);
  }
}

/** Type-check a present (defined) key; absent/undefined keys pass. */
function checkType(obj: Record<string, unknown>, key: string, expected: string, ok: (v: unknown) => boolean, where: string): void {
  const v = obj[key];
  if (v !== undefined && !ok(v)) fail(`"${key}" in ${where} must be ${expected} (got ${typeOf(v)})`);
}

const aNumber = (v: unknown) => typeof v === "number";
const aBoolean = (v: unknown) => typeof v === "boolean";
const aString = (v: unknown) => typeof v === "string";
const aFunction = (v: unknown) => typeof v === "function";

/** Validate a single upstream spec by name. Exported so `Gate.addUpstream`/`.updateUpstream` (a
 * live config change, not the whole `GateConfig`) can reuse the exact same shape checks. */
export function validateGateUpstream(name: string, up: unknown): void {
  const where = `upstream "${name}"`;
  if (!isRecord(up)) fail(`${where} must be an object — ${UPSTREAM_SHAPES} (got ${typeOf(up)})`);
  const has = (k: string) => up[k] !== undefined;
  if (has("transport")) {
    // Factory-style ConnectionConfig.
    if (typeof up.transport !== "function") fail(`"transport" in ${where} must be a () => Transport function (got ${typeOf(up.transport)})`);
    checkKeys(up, ["transport", "maxRetries", "retryDelay", "lazy", "idleMs"], where);
    checkType(up, "maxRetries", "a number", aNumber, where);
    checkType(up, "retryDelay", "a function", aFunction, where);
    checkType(up, "lazy", "a boolean", aBoolean, where);
    checkType(up, "idleMs", "a number", aNumber, where);
  } else if (has("command") && has("url")) {
    fail(`${where} has both "command" and "url" — pick one of ${UPSTREAM_SHAPES}`);
  } else if (has("command")) {
    checkKeys(up, ["command", "args", "env"], `${where} (stdio)`);
    checkType(up, "command", "a string", aString, where);
    checkType(up, "args", "an array of strings", isStringArray, where);
    checkType(up, "env", "a Record<string, string>", isStringRecord, where);
  } else if (has("url")) {
    checkKeys(up, ["url", "headers", "getToken"], `${where} (http)`);
    checkType(up, "url", "a string", aString, where);
    checkType(up, "headers", "a Record<string, string>", isStringRecord, where);
    checkType(up, "getToken", "a function", aFunction, where);
    if (has("getToken") && isRecord(up.headers) && up.headers.Authorization !== undefined) {
      fail(`${where} has both "headers.Authorization" and "getToken" — pick one (getToken is called fresh per request; a static header never refreshes)`);
    }
    try {
      new URL(up.url as string);
    } catch {
      fail(`"url" in ${where} is not a valid URL: ${String(up.url)}`);
    }
  } else {
    fail(`${where} matches none of the accepted shapes — provide ${UPSTREAM_SHAPES}`);
  }
}

function validatePolicy(policy: unknown): void {
  if (typeof policy === "function") return;
  if (!isRecord(policy)) fail(`"policy" must be a function or a rules object (got ${typeOf(policy)})`);
  checkKeys(policy, ["allow", "deny", "denyDestructive"], "policy");
  checkType(policy, "allow", "an array of glob strings", isStringArray, "policy");
  checkType(policy, "deny", "an array of glob strings", isStringArray, "policy");
  checkType(policy, "denyDestructive", "a boolean", aBoolean, "policy");
}

function validateRedact(redact: unknown): void {
  if (!Array.isArray(redact)) fail(`"redact" must be an array of rules (got ${typeOf(redact)})`);
  redact.forEach((rule, i) => {
    const where = `redact rule #${i}`;
    if (!isRecord(rule)) fail(`${where} must be an object { pattern, replacement? } (got ${typeOf(rule)})`);
    checkKeys(rule, ["pattern", "replacement"], where);
    if (rule.pattern === undefined) fail(`${where} is missing required key "pattern"`);
    if (typeof rule.pattern !== "string" && !(rule.pattern instanceof RegExp))
      fail(`"pattern" in ${where} must be a RegExp or string (got ${typeOf(rule.pattern)})`);
    checkType(rule, "replacement", "a string", aString, where);
  });
}

/**
 * Validate a GateConfig-shaped value, throwing on unknown/typo'd keys, malformed
 * upstreams, and wrong basic types. Called by createGate before anything connects.
 */
export function validateGateConfig(config: unknown): asserts config is GateConfig {
  if (!isRecord(config)) fail(`expected a GateConfig object (got ${typeOf(config)})`);
  checkKeys(config, ["upstreams", "policy", "redact", "rateLimit", "circuitBreaker", "namespace", "audit", "clientInfo", "partitionFrom"], "GateConfig");

  if (config.upstreams === undefined) fail(`missing required key "upstreams"`);
  if (!isRecord(config.upstreams)) fail(`"upstreams" must be an object of name → upstream (got ${typeOf(config.upstreams)})`);
  for (const [name, up] of Object.entries(config.upstreams)) validateGateUpstream(name, up);

  if (config.policy !== undefined) validatePolicy(config.policy);
  if (config.redact !== undefined) validateRedact(config.redact);

  if (config.rateLimit !== undefined) {
    if (!isRecord(config.rateLimit)) fail(`"rateLimit" must be an object (got ${typeOf(config.rateLimit)})`);
    checkKeys(config.rateLimit, ["concurrency"], "rateLimit");
    checkType(config.rateLimit, "concurrency", "a number", aNumber, "rateLimit");
  }
  if (config.circuitBreaker !== undefined) {
    if (!isRecord(config.circuitBreaker)) fail(`"circuitBreaker" must be an object (got ${typeOf(config.circuitBreaker)})`);
    checkKeys(config.circuitBreaker, ["threshold", "cooldownMs"], "circuitBreaker");
    checkType(config.circuitBreaker, "threshold", "a number", aNumber, "circuitBreaker");
    checkType(config.circuitBreaker, "cooldownMs", "a number", aNumber, "circuitBreaker");
  }
  checkType(config, "namespace", "a boolean", aBoolean, "GateConfig");
  checkType(config, "audit", "a function", aFunction, "GateConfig");
  checkType(config, "partitionFrom", "a function", aFunction, "GateConfig");
  if (config.clientInfo !== undefined) {
    if (!isRecord(config.clientInfo)) fail(`"clientInfo" must be an object (got ${typeOf(config.clientInfo)})`);
    checkType(config.clientInfo, "name", "a string", aString, "clientInfo");
    checkType(config.clientInfo, "version", "a string", aString, "clientInfo");
  }
}
