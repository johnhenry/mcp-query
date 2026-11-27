// Gate configuration. Config is *code* (a .ts/.js module default-exporting a GateConfig),
// but everything — policy AND upstreams — can be expressed declaratively: an upstream is
// either a full ConnectionConfig (transport factory, for full control) or the `.mcp.json`
// shape ({ command } / { url }), for which the gate builds the transport itself so config
// files need no SDK imports.
//
// This module is intentionally free of runtime imports (#37): GateConfig/GatePolicy and the
// declarative-policy compiler below (compilePolicy/policyListFilter) are pure logic with no
// Node-only (or any) dependency, so they load and run fine in a browser bundle — e.g. a
// policy-preview dashboard that never touches an actual upstream connection. Building a real
// transport for a declarative upstream (which does need Node — see `resolveUpstream` in
// ./upstream.ts) lives in its own module for exactly that reason: so a browser bundle that
// imports only the pure stuff here is never forced to resolve `@modelcontextprotocol/client/stdio`
// (which pulls in `cross-spawn` and `node:stream`) — see package.json's `browser` export
// condition, which points `.` at an entry that never reaches ./upstream.ts at all.

import type { AuthzRequest, AuthzVerdict } from "@johnhenry/mcp-query/server";
import type { ConnectionConfig, ClientInfo, CallAuditEntry, InteractionBroker, CallContext } from "@johnhenry/mcp-query";
import type { RedactRule } from "./redact.js";
import type { GatewayInteractions, GatewayExtensions } from "@johnhenry/mcp-query/server";
import type { UrlElicitationPolicy } from "./interaction.js";

/**
 * Policy for the ANSWER hop of a forwarded round (`interactions: "forward"`): the consumer's
 * reply to one upstream input request, judged before it goes upstream. Each `accept`ed answer
 * is evaluated on its own (declined/cancelled answers carry no data and pass). Verdicts are the
 * usual allow / deny / approve; a denied (or unapproved) answer is replaced by
 * `{ action: "decline" }`, so the upstream sees the person declined, and the call is audited
 * with the key in `interaction.declined`. With no `answerPolicy`, answers are allowed (still
 * redacted).
 *
 * A function receives an `AuthzRequest` with `kind: "answer"`, `target` the tool/prompt name and
 * `answer: { surface, key, action, fields }` (field names only, never values).
 */
export type AnswerPolicy = ((req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict>) | AnswerPolicyRules;

/**
 * Declarative answer rules. Precedence, first match wins: `deny` -> `denyFields` -> `approve` ->
 * `approveFields` -> allow. `deny`/`approve` are globs on the `server.tool` (or `server.prompt`)
 * id; `denyFields`/`approveFields` are globs on field names (a dotted path or its last segment).
 */
export interface AnswerPolicyRules {
  deny?: string[];
  denyFields?: string[];
  approve?: string[];
  approveFields?: string[];
}

/**
 * Declarative policy: glob-matched `server.tool` allow/deny/approve lists + a destructive switch.
 *
 * Globs apply to tool calls, resource reads and `prompts/get` (by prompt name). Catalog views and the
 * skills calls stay allowed here; function policies receive every kind (`list`, `prompt`, `skill`, ...).
 *
 * Precedence, first match wins: `deny` -> `denyDestructive` -> not in `allow` (when set) -> `approve` -> allow.
 * So `approve` never widens access: an id outside `allow` is still denied, and a
 * destructive tool is denied (not approvable) while `denyDestructive` is on. To route
 * destructive tools to a human instead, leave `denyDestructive` off and either list them in
 * `approve` or use a function policy that returns "approve" when `req.destructive`.
 */
export interface GatePolicyRules {
  /** If set, only these (glob) ids are allowed; everything else is denied. */
  allow?: string[];
  /** These (glob) ids are always denied (takes precedence). */
  deny?: string[];
  /** These (glob) ids require human approval (see `GateConfig.approval`) before they run. */
  approve?: string[];
  /** Deny any tool flagged destructiveHint. */
  denyDestructive?: boolean;
  /**
   * Skills (`io.modelcontextprotocol/skills`): allow / deny / approve a WHOLE skill, never its text
   * (a skill's files are digest-verified, so the gate never rewrites them). Globs match the skill id
   * `server.<skill-path>`, the `skill://` URI without its scheme (`github.git-commit`,
   * `github.team/deploy`); a glob that matches a skill also covers every file in it. `deny` wins, then
   * `allow` (when set) must match, then `approve`. Skills with no rule are allowed. Hidden from
   * `skills/list` when denied or outside `allow`; an approve-gated skill is listed and held at `get` / file read.
   */
  skills?: { allow?: string[]; deny?: string[]; approve?: string[] };
}

/** What an approver (the `approval.handler`, or the UI behind the broker) is shown. */
export interface ApprovalRequest {
  /** The broker interaction id (resolve it with `gate.approvals.resolve(id, ...)`). */
  id: number;
  kind: AuthzRequest["kind"];
  server: string;
  /** Tool name (call/query) or resource URI (read) -- un-namespaced, as the upstream knows it. */
  target: string;
  args?: Record<string, unknown>;
  destructive: boolean;
  readOnly: boolean;
  context?: CallContext;
}

/**
 * Human-in-the-loop approval for operations whose policy verdict is "approve".
 * Approval fails closed: no decision before `timeoutMs`, a handler that throws, or a
 * broker policy that auto-denies all refuse the call (JSON-RPC -32003, audited "denied").
 */
export interface ApprovalConfig {
  /**
   * Your own broker (shared with sampling/elicitation UI, custom `policy`/`onAudit`). Its
   * `policy` is consulted per approval: "ask" parks the call in `broker.list()` until
   * `broker.resolve(id, { action: "approve" | "deny" })`; "allow"/"deny" decide without a
   * human. Default: a fresh broker that asks for everything, exposed as `gate.approvals`.
   */
  broker?: InteractionBroker;
  /**
   * Programmatic approver, called once per pending approval (e.g. post to Slack, check a
   * ticket). Return "allow" to run the call, "deny" to refuse. Omit it to drive approvals
   * from a UI through `gate.approvals`.
   */
  handler?: (req: ApprovalRequest) => Promise<"allow" | "deny"> | "allow" | "deny";
  /** Max ms to wait for a decision. Default: wait forever. */
  timeoutMs?: number;
  /** What happens on timeout. Only "deny" exists -- approval never fails open. */
  onTimeout?: "deny";
  /**
   * How `policy.approve`-listed tools/prompts/resources appear in discovery
   * (`tools/list` etc.). Default `"visible"` (the pre-0.4.0 behavior).
   * - `"visible"`: listed normally; approval is only enforced when the call is made.
   * - `"annotated"`: listed, with `_meta.requiresApproval: true` so a client can show a badge.
   *   (`_meta`, not MCP tool `annotations`: that field is a closed set of behavior hints.)
   * - `"hidden"`: omitted from listings. A caller that already knows the name can still call
   *   it, and the call goes through the normal approval flow -- hiding is not a security
   *   boundary (use `policy.deny`/`allow` for that), it only de-clutters discovery, and
   *   means agents/UIs will not find the tool on their own.
   * Only declarative `policy.approve` globs can be listed this way; a function policy's
   * "approve" verdicts are call-time only (names can't be inferred).
   */
  discovery?: "visible" | "annotated" | "hidden";
}

export type GatePolicy = ((req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict>) | GatePolicyRules;

/** Declarative stdio upstream (the `.mcp.json` shape) — the gate spawns the command. */
export interface StdioUpstreamSpec {
  command: string;
  args?: string[];
  /** Extra environment for the spawned server (merged over the SDK's safe defaults). */
  env?: Record<string, string>;
}

/** A secret held elsewhere: an environment variable NAME or a callback. Never the value itself. */
export type SecretRef = { env: string } | { get: () => string | undefined | Promise<string | undefined> };

/** Fields shared by the OAuth upstream auth types. */
interface UpstreamAuthBase {
  /**
   * The authorization server's `issuer` identifier these credentials belong to (SEP-2352). Required:
   * the gate refuses to send credentials to any other authorization server. With no `tokenEndpoint`,
   * the token endpoint is discovered from the upstream (RFC 9728 -> RFC 8414) and its `issuer` must equal this.
   */
  issuer: string;
  /** Skip discovery and use this token endpoint (https, or loopback for development). */
  tokenEndpoint?: string;
  scope?: string;
  /** RFC 8707 resource indicator; defaults to the upstream `url`. */
  resource?: string;
  /** `fetch` for token/discovery requests (tests, proxies). Default: global fetch. */
  fetch?: typeof fetch;
}

/**
 * `io.modelcontextprotocol/oauth-client-credentials`: the gate authenticates as itself
 * (client_secret_basic). The secret is a reference, never inline.
 */
export interface ClientCredentialsAuth extends UpstreamAuthBase {
  type: "client_credentials";
  clientId: string;
  clientSecret: SecretRef;
}

/**
 * `io.modelcontextprotocol/enterprise-managed-authorization`: exchange a user's identity assertion
 * at the enterprise IdP for an ID-JAG (RFC 8693), then trade it for an access token at the MCP
 * authorization server (RFC 7523 jwt-bearer). EXPERIMENTAL: only tested against a mock IdP.
 */
export interface EnterpriseAuth extends UpstreamAuthBase {
  type: "enterprise";
  /** The identity assertion (OIDC ID token) from the user's SSO login, by reference. */
  idToken: SecretRef;
  /** The enterprise IdP the ID-JAG is requested from. */
  idp: { tokenEndpoint: string; clientId: string; clientSecret?: SecretRef };
  /** The client registered at the MCP authorization server. */
  clientId: string;
  clientSecret?: SecretRef;
}

export type UpstreamAuth = ClientCredentialsAuth | EnterpriseAuth;

/** Declarative Streamable HTTP upstream (the `.mcp.json` shape). */
export interface HttpUpstreamSpec {
  url: string;
  headers?: Record<string, string>;
  /**
   * OAuth for this upstream: a machine identity (`client_credentials`) or enterprise-managed
   * authorization (`enterprise`). Secrets by reference only. Mutually exclusive with `getToken`
   * and with an `Authorization` header. Tokens are cached until just before expiry and are never
   * written to audit entries.
   */
  auth?: UpstreamAuth;
  /**
   * Resolve a bearer token fresh before every request to this upstream. Maps directly onto
   * the SDK's own `AuthProvider.token()` — called by the transport itself, per request, with
   * no gate-side caching or shared mutable state, so it's safe under concurrent calls (unlike
   * a naive "mutate a shared headers object" approach, which would race). Mutually exclusive
   * with an `Authorization` entry in `headers`.
   *
   * This resolves a single, possibly-refreshing credential for the upstream connection as a
   * whole — it does not receive per-call context, so it can't differentiate by tenant/caller
   * on its own (neither this SDK generation nor the previous one supports that). For a token
   * that must vary per tenant on the *same* upstream URL, provision one connection per
   * `(upstream, partition)` via `Gate.addUpstream` instead, each with its own `getToken`.
   */
  getToken?: () => string | undefined | Promise<string | undefined>;
}

/**
 * An upstream is either a full ConnectionConfig (`transport: () => Transport` factory,
 * plus reconnect tuning) or a declarative spec the gate builds the transport for.
 */
export type GateUpstream = ConnectionConfig | StdioUpstreamSpec | HttpUpstreamSpec;

export interface GateConfig {
  /** Upstream MCP servers to front (name → transport factory or declarative `{command}`/`{url}` spec). */
  upstreams: Record<string, GateUpstream>;
  policy?: GatePolicy;
  /**
   * Approval backend for "approve" verdicts. Required when `policy.approve` is set; a
   * function policy that returns "approve" without this config is denied (fail closed).
   * The approval step runs right after the policy's allow/deny decision, before rate-limit,
   * circuit-breaker and redaction -- denied calls never reach a human, and a human wait
   * neither holds a rate-limit slot nor counts against the breaker.
   */
  approval?: ApprovalConfig;
  redact?: RedactRule[];
  rateLimit?: { concurrency?: number };
  circuitBreaker?: { threshold?: number; cooldownMs?: number };
  /** Namespace re-exposed tools/prompts as `server.tool`. Default true. */
  namespace?: boolean;
  /**
   * Audit sink for every op (read/call/query), including denials. Default: one line to
   * stderr. The only persistence hook gate has — everything else in gate is in-memory —
   * so a real deployment typically wires this straight into a DB table.
   *
   * Contract (verified against `@johnhenry/mcp-query`'s `MCPClient.run()`):
   * - Fires *after* the operation settles — it's an observability hook, not a veto/blocking
   *   point. It cannot delay, retry, or reject the call; use `policy` for that.
   * - `entry.at` is `Date.now()` at op start; `entry.ms` is wall-clock duration to settle
   *   (`Date.now() - at`), not monotonic — sensitive to system clock adjustments mid-call.
   * - `entry.outcome` is `"ok" | "denied" | "error"`. `"denied"` means specifically an
   *   authorization-policy denial; a rate-limit rejection or an open circuit breaker
   *   (`CircuitOpenError`) is `"error"`, not `"denied"`.
   * - **Not awaited.** mcp-query's `run()` invokes this fire-and-forget; a returned Promise's
   *   settlement is never waited on before the client call resolves (tracked upstream as
   *   johnhenry/mcp-query#22). Gate wraps whatever you pass here so a thrown error or
   *   rejected Promise can't crash the process or produce an unhandled rejection — but the
   *   operation has already completed by the time your callback runs regardless of what it does.
   */
  audit?: (entry: CallAuditEntry) => void;
  clientInfo?: ClientInfo;
  /**
   * What happens when an upstream `tools/call`/`prompts/get` returns `input_required`
   * (MRTR, 2026-07-28). `"answer"` (default): the gate's own host handlers answer it, or it
   * fails; the consumer never sees it. `"forward"`: the round is returned to the consumer
   * (`inputRequests` redacted and audited, `requestState` untouched) and the consumer's retry
   * is routed back to the same upstream. `"deny"`: refuse any such round. Pass an object for
   * per-upstream overrides: `{ default: "deny", upstreams: { github: "forward" } }`.
   * Forwarding relays elicitations only, and only for upstreams on a modern (2026-07-28)
   * connection.
   */
  interactions?: GatewayInteractions;
  /**
   * Which hosts a forwarded URL-mode elicitation may send the consumer to (see
   * `UrlElicitationPolicy`). Fails closed: with `interactions` forwarding but no `allowHosts`,
   * URL-mode requests are denied (-32003, audited "denied"). Form-mode is unaffected.
   */
  urlElicitation?: UrlElicitationPolicy;
  /**
   * Policy for the consumer's answers to forwarded input requests (see `AnswerPolicy`).
   * `approve` verdicts need `approval`. Default: answers are allowed. Independently of this,
   * every answer is scrubbed with `redact` before it goes upstream (`requestState` never is).
   */
  answerPolicy?: AnswerPolicy;
  /**
   * Derive a tenant/session partition from request `_meta` for per-tenant `rateLimit`/
   * `circuitBreaker` isolation (so one tenant hammering an upstream doesn't throttle or
   * trip the breaker for every other tenant sharing this gate). Default:
   * `(meta) => meta?.partition as string | undefined`. Runs before `policy`, so a function
   * policy can also branch on `context.partition`. A caller sets this via `_meta.partition`
   * on a raw `tools/call` (the gateway already forwards `_meta` through), or a library-mode
   * embedder sets it directly via `gate.client.scope({ partition, meta })`.
   */
  /**
   * Map the host-verified bearer token into each call's context. Front the gate's HTTP endpoint
   * with the SDK's `requireBearerAuth` / `verifyBearerToken` (`@modelcontextprotocol/server`), pass the
   * verified `AuthInfo` to the transport (`handleRequest(req, { authInfo })`), and set this: the
   * verified principal lands in `_meta.principal` (plus `authScopes`, `authClientId`) where
   * `policy` and `partitionFrom` read it. Caller-supplied values for those keys are dropped.
   * `{ required: true }` rejects calls with no verified token.
   */
  inboundAuth?: boolean | import("@johnhenry/mcp-query/server").InboundAuthOptions;
  partitionFrom?: (meta: Record<string, unknown> | undefined) => string | undefined;
  /**
   * MCP extensions the gate offers consumers and passes through (tasks, skills, MCP Apps, and an opt-in
   * allowlist for unknown extension methods). An extension is offered to a consumer only when an upstream
   * advertises it, this config allows it, and the consumer declared it. Allowed by default: tasks, skills,
   * `io.modelcontextprotocol/ui`. The gate's own connection to upstreams declares the UI extension (so
   * upstreams send their MCP Apps metadata; it is stripped for consumers that did not declare it) unless
   * UI is denied here. Set `tasksSecret` when several gate instances share consumers. See the README.
   */
  extensions?: GatewayExtensions;
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map(escapeRe).join(".*") + "$");
}

/** What a glob is matched against: the `server.tool` id (default) or the bare tool name. */
export type PolicyScope = "qualified" | "tool";

/** Additive options for the declarative policy compilers; the defaults are the original behaviour. */
export interface PolicyOptions {
  /**
   * `allow: []`: `"deny"` (default) denies every tool; `"ignore"` treats an empty list as no
   * allow list (for UIs where clearing the list shouldn't lock everything out).
   */
  emptyAllow?: "deny" | "ignore";
  /**
   * What globs match: `"qualified"` (default) the `server.tool` id, or `"tool"` the bare tool
   * name. A server-name map (`{ fs: "tool" }`) sets it per server; unlisted servers stay `"qualified"`.
   */
  scope?: PolicyScope | Record<string, PolicyScope>;
}

/** Which rule decided a verdict: the policy list, and the glob that matched (absent for `denyDestructive` and an allow-list miss). */
export interface PolicyRule {
  list: "deny" | "approve" | "allow" | "denyDestructive";
  glob?: string;
}

/** A verdict plus the rule that produced it; `rule` is absent when the default (allow) applied. */
export interface PolicyDecision {
  decision: AuthzVerdict;
  rule?: PolicyRule;
}

function idFor(options: PolicyOptions | undefined, server: string, name: string): string {
  const sc = options?.scope;
  const scope = typeof sc === "object" && sc !== null ? (Object.hasOwn(sc, server) ? sc[server] : undefined) : sc;
  return scope === "tool" ? name : `${server}.${name}`;
}

/** Compile an allow list honouring `emptyAllow`; undefined means "no allow list". */
function compileAllow(policy: GatePolicyRules, options?: PolicyOptions): { glob: string; re: RegExp }[] | undefined {
  if (!policy.allow) return undefined;
  if (policy.allow.length === 0 && options?.emptyAllow === "ignore") return undefined;
  return policy.allow.map((glob) => ({ glob, re: globToRe(glob) }));
}

const compileList = (globs?: string[]) => globs?.map((glob) => ({ glob, re: globToRe(glob) }));

/**
 * Like `compilePolicy`, but each result is `{ decision, rule? }`: the verdict plus which
 * list (and glob) decided it. `rule` is absent when the default applied. A function policy
 * yields `{ decision }` only.
 */
export function explainPolicy(
  policy: GatePolicy,
  options?: PolicyOptions,
): (req: AuthzRequest) => PolicyDecision | Promise<PolicyDecision> {
  if (typeof policy === "function") {
    return (req) => {
      const v = policy(req);
      return v instanceof Promise ? v.then((decision) => ({ decision })) : { decision: v };
    };
  }
  const allow = compileAllow(policy, options);
  const deny = compileList(policy.deny);
  const approve = compileList(policy.approve);
  return (req) => {
    // Catalog views (`list`) are filtered per item by policyListFilter, and the skills calls have no
    // glob-addressable id: a declarative policy leaves both permissive (use a function policy to gate them).
    if (req.kind === "list" || req.kind === "extension") return { decision: "allow" };
    if (req.kind === "skill") return skillDecision(policy.skills, req);
    const id = idFor(options, req.server, req.target);
    const denied = deny?.find((r) => r.re.test(id));
    if (denied) return { decision: "deny", rule: { list: "deny", glob: denied.glob } };
    if (policy.denyDestructive && req.destructive) return { decision: "deny", rule: { list: "denyDestructive" } };
    let allowed: { glob: string } | undefined;
    if (allow) {
      allowed = allow.find((r) => r.re.test(id));
      if (!allowed) return { decision: "deny", rule: { list: "allow" } };
    }
    // A task poll/answer/cancel follows the tool that started it: denied tools stay denied, but approval was
    // asked when the task began, not at every poll.
    const ask = req.kind === "task" ? undefined : approve?.find((r) => r.re.test(id));
    if (ask) return { decision: "approve", rule: { list: "approve", glob: ask.glob } };
    return allowed ? { decision: "allow", rule: { list: "allow", glob: allowed.glob } } : { decision: "allow" };
  };
}

/** The ids a skill operation names, longest first: `server.a/b/SKILL.md`, `server.a/b`, `server.a`. A glob matching any covers the skill. */
function skillIds(server: string, uri: string): string[] {
  const path = uri.startsWith("skill://") ? uri.slice("skill://".length) : uri;
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => `${server}.${parts.slice(0, parts.length - i).join("/")}`);
}

function skillDecision(rules: GatePolicyRules["skills"], req: AuthzRequest): PolicyDecision {
  // The catalog call itself is filtered per skill (policySkillFilter); naming a whole skill is what is judged.
  if (!rules || req.method === "skills/list" || req.target === "skills") return { decision: "allow" };
  const named = (req.args as { skill?: unknown } | undefined)?.skill;
  const ids = skillIds(req.server, typeof named === "string" ? named : req.target);
  const hit = (globs?: string[]) => globs?.find((g) => ids.some((id) => globToRe(g).test(id)));
  const denied = hit(rules.deny);
  if (denied) return { decision: "deny", rule: { list: "deny", glob: denied } };
  if (rules.allow) {
    const ok = hit(rules.allow);
    if (!ok) return { decision: "deny", rule: { list: "allow" } };
  }
  const ask = hit(rules.approve);
  if (ask) return { decision: "approve", rule: { list: "approve", glob: ask } };
  return { decision: "allow" };
}

/**
 * The gateway's `skillFilter` for a declarative policy: skills denied (or outside `skills.allow`) are
 * hidden from `skills/list`. Undefined when the policy has no skill rules (or is a function).
 */
export function policySkillFilter(policy: GatePolicy): ((server: string, uri: string) => boolean) | undefined {
  if (typeof policy === "function" || !(policy.skills?.deny?.length || policy.skills?.allow)) return undefined;
  const rules = policy.skills;
  return (server, uri) => {
    const ids = skillIds(server, uri);
    if (rules.deny?.some((g) => ids.some((id) => globToRe(g).test(id)))) return false;
    if (rules.allow && !rules.allow.some((g) => ids.some((id) => globToRe(g).test(id)))) return false;
    return true;
  };
}

/** Turn a declarative policy (or pass a function through) into an authorize() policy. */
export function compilePolicy(policy: GatePolicy, options?: PolicyOptions): (req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict> {
  if (typeof policy === "function") return policy;
  const explain = explainPolicy(policy, options) as (req: AuthzRequest) => PolicyDecision;
  return (req) => explain(req).decision;
}

/**
 * Derive a gateway list-filter from a *declarative* policy so name-denied tools/prompts
 * are hidden from discovery (not just blocked on call). Returns undefined for a function
 * policy (we can't infer names) — those are still enforced at call time. `denyDestructive`
 * is also call-time only here, since the list-filter doesn't carry tool annotations.
 */
export function policyListFilter(
  policy: GatePolicy,
  discovery: ApprovalConfig["discovery"] = "visible",
  options?: PolicyOptions,
): ((server: string, kind: "tool" | "resource" | "prompt", name: string) => boolean) | undefined {
  if (typeof policy === "function") return undefined;
  const allow = compileAllow(policy, options)?.map((r) => r.re);
  const deny = policy.deny?.map(globToRe);
  const hideApprove = discovery === "hidden" ? policy.approve?.map(globToRe) : undefined;
  if (!allow && !deny && !hideApprove?.length) return undefined;
  return (server, _kind, name) => {
    const id = idFor(options, server, name);
    if (deny?.some((re) => re.test(id))) return false;
    if (allow && !allow.some((re) => re.test(id))) return false;
    if (hideApprove?.some((re) => re.test(id))) return false;
    return true;
  };
}

/**
 * For `approval.discovery: "annotated"`: the `_meta` to merge into a listed item that
 * `policy.approve` gates (`{ requiresApproval: true }`), else undefined. Declarative
 * policies only.
 */
export function policyListAnnotator(
  policy: GatePolicy,
  discovery: ApprovalConfig["discovery"] = "visible",
  options?: PolicyOptions,
): ((server: string, kind: "tool" | "resource" | "prompt", name: string) => Record<string, unknown> | undefined) | undefined {
  if (typeof policy === "function" || discovery !== "annotated" || !policy.approve?.length) return undefined;
  const approve = policy.approve.map(globToRe);
  return (server, _kind, name) => (approve.some((re) => re.test(idFor(options, server, name))) ? { requiresApproval: true } : undefined);
}
