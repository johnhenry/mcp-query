// Dependency-free GateConfig validation. Config modules are hand-written, so a typo'd
// key must fail loudly at load time instead of being silently ignored (the observed
// footgun: a redact rule with `replace` instead of `replacement` redacted nothing).
// Every error names the offending key/upstream and lists what would have been valid.

import type { GateConfig } from "./config.js";

const UPSTREAM_SHAPES =
  'a transport factory { transport: () => Transport, maxRetries?, retryDelay?, lazy?, idleMs?, versions?, versionNegotiation? }, a stdio spec { command, args?, env? }, or a Streamable HTTP spec { url, headers?, getToken?, auth? }';

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

const aSecretRef = (v: unknown): boolean => {
  if (!isRecord(v)) return false;
  const ks = presentKeys(v);
  return (ks.length === 1 && ks[0] === "env" && typeof v.env === "string" && v.env.length > 0) || (ks.length === 1 && ks[0] === "get" && typeof v.get === "function");
};

/** A secret must be a reference. A bare string is the mistake this exists to catch. */
function checkSecret(obj: Record<string, unknown>, key: string, where: string, required: boolean): void {
  const v = obj[key];
  if (v === undefined) {
    if (required) fail(`"${key}" is required in ${where} — a secret reference { env: "NAME" } or { get: () => ... }`);
    return;
  }
  if (typeof v === "string") {
    fail(`"${key}" in ${where} is an inline secret string — secrets are referenced, never written into config. Use { env: "NAME" } (an environment variable) or { get: () => ... }`);
  }
  if (!aSecretRef(v)) fail(`"${key}" in ${where} must be a secret reference { env: "NAME" } or { get: () => ... } (got ${typeOf(v)})`);
}

function validateUpstreamAuth(auth: unknown, where: string): void {
  if (!isRecord(auth)) fail(`${where} must be an object { type: "client_credentials" | "enterprise", ... } (got ${typeOf(auth)})`);
  const common = ["type", "issuer", "tokenEndpoint", "scope", "resource", "fetch"];
  if (auth.type === "client_credentials") {
    checkKeys(auth, [...common, "clientId", "clientSecret"], where);
    checkType(auth, "clientId", "a string", aString, where);
    if (typeof auth.clientId !== "string" || !auth.clientId) fail(`"clientId" is required in ${where}`);
    checkSecret(auth, "clientSecret", where, true);
  } else if (auth.type === "enterprise") {
    checkKeys(auth, [...common, "idToken", "idp", "clientId", "clientSecret"], where);
    if (typeof auth.clientId !== "string" || !auth.clientId) fail(`"clientId" is required in ${where}`);
    checkSecret(auth, "idToken", where, true);
    checkSecret(auth, "clientSecret", where, false);
    if (!isRecord(auth.idp)) fail(`"idp" in ${where} must be an object { tokenEndpoint, clientId, clientSecret? }`);
    checkKeys(auth.idp, ["tokenEndpoint", "clientId", "clientSecret"], `${where}.idp`);
    if (typeof auth.idp.tokenEndpoint !== "string") fail(`"tokenEndpoint" is required in ${where}.idp`);
    if (typeof auth.idp.clientId !== "string") fail(`"clientId" is required in ${where}.idp`);
    checkSecret(auth.idp, "clientSecret", `${where}.idp`, false);
  } else {
    fail(`"type" in ${where} must be "client_credentials" or "enterprise" (got ${typeOf(auth.type)}${typeof auth.type === "string" ? ` "${auth.type}"` : ""})`);
  }
  if (typeof auth.issuer !== "string" || !auth.issuer) {
    fail(`"issuer" is required in ${where} — the authorization server's issuer identifier the credentials belong to`);
  }
  checkType(auth, "tokenEndpoint", "a string", aString, where);
  checkType(auth, "scope", "a string", aString, where);
  checkType(auth, "resource", "a string", aString, where);
  checkType(auth, "fetch", "a function", aFunction, where);
}

/** Validate a single upstream spec by name. Exported so `Gate.addUpstream`/`.updateUpstream` (a
 * live config change, not the whole `GateConfig`) can reuse the exact same shape checks. */
export function validateGateUpstream(name: string, up: unknown): void {
  const where = `upstream "${name}"`;
  if (!isRecord(up)) fail(`${where} must be an object — ${UPSTREAM_SHAPES} (got ${typeOf(up)})`);
  const has = (k: string) => up[k] !== undefined;
  if (has("transport")) {
    // Factory-style ConnectionConfig.
    if (typeof up.transport !== "function") fail(`"transport" in ${where} must be a () => Transport function (got ${typeOf(up.transport)})`);
    checkKeys(up, ["transport", "maxRetries", "retryDelay", "lazy", "idleMs", "versions", "versionNegotiation"], where);
    checkType(up, "versions", "an array of protocol revision strings", isStringArray, where);
    checkType(up, "versionNegotiation", "an object", isRecord, where);
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
    checkKeys(up, ["url", "headers", "getToken", "auth"], `${where} (http)`);
    checkType(up, "url", "a string", aString, where);
    checkType(up, "headers", "a Record<string, string>", isStringRecord, where);
    checkType(up, "getToken", "a function", aFunction, where);
    if (has("getToken") && isRecord(up.headers) && up.headers.Authorization !== undefined) {
      fail(`${where} has both "headers.Authorization" and "getToken" — pick one (getToken is called fresh per request; a static header never refreshes)`);
    }
    if (has("auth")) {
      if (has("getToken")) fail(`${where} has both "auth" and "getToken" — pick one`);
      if (isRecord(up.headers) && Object.keys(up.headers).some((h) => h.toLowerCase() === "authorization")) {
        fail(`${where} has both "headers.Authorization" and "auth" — pick one`);
      }
      validateUpstreamAuth(up.auth, `${where} auth`);
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
  checkKeys(policy, ["allow", "deny", "approve", "denyDestructive", "skills"], "policy");
  checkType(policy, "allow", "an array of glob strings", isStringArray, "policy");
  checkType(policy, "deny", "an array of glob strings", isStringArray, "policy");
  checkType(policy, "approve", "an array of glob strings", isStringArray, "policy");
  checkType(policy, "denyDestructive", "a boolean", aBoolean, "policy");
  if (policy.skills !== undefined) {
    if (!isRecord(policy.skills)) fail(`"policy.skills" must be an object { allow?, deny?, approve? } (got ${typeOf(policy.skills)})`);
    checkKeys(policy.skills, ["allow", "deny", "approve"], "policy.skills");
    for (const key of ["allow", "deny", "approve"]) checkType(policy.skills, key, "an array of glob strings", isStringArray, "policy.skills");
  }
}

function validateExtensions(v: unknown): void {
  if (!isRecord(v)) fail(`"extensions" must be an object { allow?, deny?, passthrough?, tasksSecret?, taskResolveMs? } (got ${typeOf(v)})`);
  checkKeys(v, ["allow", "deny", "passthrough", "tasksSecret", "taskResolveMs"], "extensions");
  checkType(v, "allow", "an array of extension ids", isStringArray, "extensions");
  checkType(v, "deny", "an array of extension ids", isStringArray, "extensions");
  checkType(v, "taskResolveMs", "a number", aNumber, "extensions");
  checkType(v, "tasksSecret", "a string or Uint8Array of at least 16 bytes", (x) => (typeof x === "string" ? x.length >= 16 : x instanceof Uint8Array && x.length >= 16), "extensions");
  if (v.passthrough !== undefined) {
    if (!isRecord(v.passthrough)) fail(`"passthrough" in extensions must be an object of extension id → { methods: string[] } (got ${typeOf(v.passthrough)})`);
    for (const [id, cfg] of Object.entries(v.passthrough)) {
      if (!isRecord(cfg)) fail(`extensions.passthrough["${id}"] must be an object { methods: string[] } (got ${typeOf(cfg)})`);
      checkKeys(cfg, ["methods"], `extensions.passthrough["${id}"]`);
      if (!isStringArray(cfg.methods) || (cfg.methods as string[]).length === 0) fail(`extensions.passthrough["${id}"].methods must be a non-empty array of method names`);
    }
  }
}

function validateApproval(approval: unknown): void {
  if (!isRecord(approval)) fail(`"approval" must be an object { broker?, handler?, timeoutMs?, onTimeout?, discovery? } (got ${typeOf(approval)})`);
  checkKeys(approval, ["broker", "handler", "timeoutMs", "onTimeout", "discovery"], "approval");
  checkType(approval, "handler", "a function", aFunction, "approval");
  checkType(approval, "timeoutMs", "a number", aNumber, "approval");
  if (typeof approval.timeoutMs === "number" && !(approval.timeoutMs > 0)) fail(`"timeoutMs" in approval must be a positive number`);
  checkType(approval, "onTimeout", '"deny"', (v) => v === "deny", "approval");
  checkType(approval, "discovery", '"visible" | "annotated" | "hidden"', (v) => v === "visible" || v === "annotated" || v === "hidden", "approval");
  checkType(approval, "broker", "an InteractionBroker", (v) => isRecord(v) && typeof (v as { gate?: unknown }).gate === "function", "approval");
}

const MODES = ["answer", "forward", "deny"];
const aMode = (v: unknown) => typeof v === "string" && MODES.includes(v);

function validateInteractions(v: unknown): void {
  const shape = '"answer" | "forward" | "deny", or { default?, upstreams?: Record<string, mode> }';
  if (typeof v === "string") {
    if (!aMode(v)) fail(`"interactions" must be ${shape} (got ${JSON.stringify(v)})`);
    return;
  }
  if (!isRecord(v)) fail(`"interactions" must be ${shape} (got ${typeOf(v)})`);
  checkKeys(v, ["default", "upstreams"], "interactions");
  checkType(v, "default", '"answer" | "forward" | "deny"', aMode, "interactions");
  if (v.upstreams !== undefined) {
    if (!isRecord(v.upstreams)) fail(`"upstreams" in interactions must be an object of upstream name → mode (got ${typeOf(v.upstreams)})`);
    for (const [name, mode] of Object.entries(v.upstreams)) {
      if (!aMode(mode)) fail(`interactions.upstreams["${name}"] must be "answer" | "forward" | "deny" (got ${JSON.stringify(mode)})`);
    }
  }
}

function validateUrlElicitation(v: unknown): void {
  if (!isRecord(v)) fail(`"urlElicitation" must be an object { allowHosts?, denyHosts? } (got ${typeOf(v)})`);
  checkKeys(v, ["allowHosts", "denyHosts"], "urlElicitation");
  for (const key of ["allowHosts", "denyHosts"]) checkType(v, key, "an array of host glob strings", isStringArray, "urlElicitation");
}

function validateAnswerPolicy(v: unknown): void {
  if (typeof v === "function") return;
  if (!isRecord(v)) fail(`"answerPolicy" must be a function or an object { deny?, denyFields?, approve?, approveFields? } (got ${typeOf(v)})`);
  const keys = ["deny", "denyFields", "approve", "approveFields"];
  checkKeys(v, keys, "answerPolicy");
  for (const key of keys) checkType(v, key, "an array of glob strings", isStringArray, "answerPolicy");
}

function validateRedact(redact: unknown): void {
  if (!Array.isArray(redact)) fail(`"redact" must be an array of rules (got ${typeOf(redact)})`);
  redact.forEach((rule, i) => {
    const where = `redact rule #${i}`;
    if (!isRecord(rule)) fail(`${where} must be an object { pattern, replacement? } (got ${typeOf(rule)})`);
    checkKeys(rule, ["pattern", "replacement", "flags"], where);
    if (rule.pattern === undefined) fail(`${where} is missing required key "pattern"`);
    if (typeof rule.pattern !== "string" && !(rule.pattern instanceof RegExp))
      fail(`"pattern" in ${where} must be a RegExp or string (got ${typeOf(rule.pattern)})`);
    checkType(rule, "replacement", "a string", aString, where);
    checkType(rule, "flags", "a string", aString, where);
    if (typeof rule.flags === "string") {
      try {
        new RegExp(typeof rule.pattern === "string" ? rule.pattern : rule.pattern.source, rule.flags);
      } catch {
        fail(`"flags" in ${where} is not valid for its pattern (got ${JSON.stringify(rule.flags)})`);
      }
    }
  });
}

/**
 * Validate a GateConfig-shaped value, throwing on unknown/typo'd keys, malformed
 * upstreams, and wrong basic types. Called by createGate before anything connects.
 */
export function validateGateConfig(config: unknown): asserts config is GateConfig {
  if (!isRecord(config)) fail(`expected a GateConfig object (got ${typeOf(config)})`);
  checkKeys(config, ["upstreams", "policy", "approval", "redact", "rateLimit", "circuitBreaker", "namespace", "audit", "clientInfo", "partitionFrom", "inboundAuth", "interactions", "urlElicitation", "answerPolicy", "extensions"], "GateConfig");

  if (config.upstreams === undefined) fail(`missing required key "upstreams"`);
  if (!isRecord(config.upstreams)) fail(`"upstreams" must be an object of name → upstream (got ${typeOf(config.upstreams)})`);
  for (const [name, up] of Object.entries(config.upstreams)) validateGateUpstream(name, up);

  if (config.policy !== undefined) validatePolicy(config.policy);
  if (config.approval !== undefined) validateApproval(config.approval);
  if (isRecord(config.policy) && config.policy.approve !== undefined && (config.policy.approve as unknown[]).length > 0 && config.approval === undefined) {
    fail(`"policy.approve" rules need an "approval" config (a broker and/or handler) to decide them — without one, approvals could never resolve`);
  }
  if (config.redact !== undefined) validateRedact(config.redact);
  if (config.extensions !== undefined) validateExtensions(config.extensions);
  if (config.interactions !== undefined) validateInteractions(config.interactions);
  if (config.urlElicitation !== undefined) validateUrlElicitation(config.urlElicitation);
  if (config.answerPolicy !== undefined) {
    validateAnswerPolicy(config.answerPolicy);
    const ap = config.answerPolicy;
    if (isRecord(ap) && ((ap.approve as unknown[] | undefined)?.length || (ap.approveFields as unknown[] | undefined)?.length) && config.approval === undefined) {
      fail(`"answerPolicy.approve" rules need an "approval" config (a broker and/or handler) to decide them — without one, approvals could never resolve`);
    }
  }
  if (isRecord(config.interactions)) {
    for (const name of Object.keys((config.interactions.upstreams as Record<string, unknown>) ?? {})) {
      if (!Object.hasOwn(config.upstreams, name)) fail(`interactions.upstreams names "${name}", which is not in "upstreams" (known: ${Object.keys(config.upstreams).join(", ") || "none"})`);
    }
  }

  if (config.rateLimit !== undefined) {
    if (!isRecord(config.rateLimit)) fail(`"rateLimit" must be an object (got ${typeOf(config.rateLimit)})`);
    checkKeys(config.rateLimit, ["concurrency", "keyFn"], "rateLimit");
    checkType(config.rateLimit, "concurrency", "a number", aNumber, "rateLimit");
    checkType(config.rateLimit, "keyFn", "a function", aFunction, "rateLimit");
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
  checkType(config, "inboundAuth", "a boolean or { required?, principal? }", (v) => typeof v === "boolean" || isRecord(v), "GateConfig");
  if (config.clientInfo !== undefined) {
    if (!isRecord(config.clientInfo)) fail(`"clientInfo" must be an object (got ${typeOf(config.clientInfo)})`);
    checkType(config.clientInfo, "name", "a string", aString, "clientInfo");
    checkType(config.clientInfo, "version", "a string", aString, "clientInfo");
  }
}
