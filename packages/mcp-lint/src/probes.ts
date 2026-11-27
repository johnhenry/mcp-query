// Live-probe lint rules (opt-in, `mcp-lint --probe`).
//
// The rules in rules.ts are *contract-only*: pure functions of one captured Contract, so they
// are safe to run against a pinned contract file. The rules here need a live connection (a
// second request, a deliberately failing request), so they take a connected client instead.
// They are kept in their own list on purpose: `lintContract` never runs them, and the CLI
// refuses `--probe` together with `--contract`.

import { Client } from "@modelcontextprotocol/client";
import { buildTransport, versionNegotiationFor, type ConnectOptions } from "../../mcp-contract/src/index.js";
import { DiscoveryError, compareCardToLive, fetchServerCard, recommendedCardUrl, sanitizeForDisplay } from "../../mcp-query/src/discovery/index.js";
import type { Severity } from "./rules.js";

/**
 * Connect for probing. Unlike the contract tools' default (the classic initialize handshake), this
 * lets the SDK try `server/discover` first (`versionNegotiation: auto`) and fall back to
 * `initialize`, which is exactly what `stateless-ready` needs to observe.
 */
export async function connectProbeClient(opts: ConnectOptions): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: opts.clientName ?? "mcp-lint", version: "0.0.1" }, { capabilities: {}, ...versionNegotiationFor("auto") }); // the probe is bounded: a server that never answers it is treated as legacy, not waited on for a minute
  await client.connect(buildTransport(opts));
  return { client, close: () => client.close().catch(() => {}) };
}

/** The slice of the SDK client the probes use. Kept structural so tests can inject fakes. */
export interface ProbeClient {
  getServerCapabilities(): Record<string, unknown> | undefined;
  getProtocolEra?(): string | undefined;
  getDiscoverResult?(): unknown;
  getServerVersion?(): { name?: string; version?: string } | undefined;
  getNegotiatedProtocolVersion?(): string | undefined;
  discover?(): Promise<unknown>;
  listTools(params?: { cursor?: string }, options?: { cacheMode?: "use" | "refresh" | "bypass" }): Promise<{ tools: Array<{ name: string }>; nextCursor?: string }>;
  readResource(params: { uri: string }, options?: { cacheMode?: "use" | "refresh" | "bypass" }): Promise<unknown>;
  /** Used by `reserved-error-range` to send a method the server cannot know. Absent on fakes: the probe then skips that step. */
  request?(request: { method: string; params?: Record<string, unknown> }, resultSchema: unknown): Promise<unknown>;
  /** Used by `reserved-error-range` with a name that does not exist (never a real tool). */
  callTool?(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/** What a probe may need beyond the connected client. */
export interface ProbeContext {
  /** The Streamable HTTP URL that was linted. Absent for stdio servers (the card rule then stays silent). */
  url?: string;
  /** Injectable fetch for the Server Card and transport requests (tests). */
  fetch?: typeof fetch;
  /** Request headers (e.g. `Authorization`) for the transport probe; same ones the connection used. */
  headers?: Record<string, string>;
  /** Upper bound for each transport request and for waiting on the first SSE event (default 5000). */
  timeoutMs?: number;
}

export interface ProbeViolation {
  target: string;
  message: string;
}

export interface LiveRule {
  id: string;
  description: string;
  defaultSeverity: Severity;
  /** The SEP / spec text the rule is written against. */
  source: string;
  check: (client: ProbeClient, ctx: ProbeContext) => Promise<ProbeViolation[]>;
  /** Present on rules that can also run when the connection itself failed (see `runDisconnectedProbes`). */
  checkWithoutConnection?: (ctx: ProbeContext) => Promise<ProbeViolation[]>;
}

const errorCode = (e: unknown): number | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
};
/** The JSON-RPC code of an error: the numeric `.code`, else the code quoted in an SDK transport error that embeds the response body (an HTTP error status on a modern connection). */
const rpcErrorCode = (e: unknown): number | undefined => {
  const direct = errorCode(e);
  if (direct !== undefined) return direct;
  const m = /"code"\s*:\s*(-?\d+)/.exec(e instanceof Error ? e.message : "");
  return m ? Number(m[1]) : undefined;
};
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function listAllToolNames(client: ProbeClient): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    // bypass: the SDK honours ttlMs, so a cached second read would trivially "agree" with the first.
    const page = await client.listTools(cursor ? { cursor } : undefined, { cacheMode: "bypass" });
    names.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
  } while (cursor);
  return names;
}


const RESERVED_MIN = -32099;
const RESERVED_MAX = -32020;
const ASSIGNED_CODES: Record<number, string> = {
  [-32020]: "HeaderMismatch",
  [-32021]: "MissingRequiredClientCapability",
  [-32022]: "UnsupportedProtocolVersion",
};
/** A result schema that accepts anything: the probes only care about the error. */
const ANY_RESULT = { "~standard": { version: 1, vendor: "mcp-lint", validate: (value: unknown) => ({ value }) } };

const PROBE_TIMEOUT_MS = 5000;
const timedOut = Symbol("timeout");

/**
 * Is `ctx.url` an HTTP+SSE-only server? Streamable HTTP answers a POST with a JSON-RPC body (even an
 * error) or an event stream. A legacy HTTP+SSE server has nothing at POST on that URL, but answers a GET
 * with an event stream whose first event is `endpoint`.
 */
async function detectSseOnly(ctx: ProbeContext): Promise<ProbeViolation[]> {
  if (!ctx.url) return [];
  const doFetch = ctx.fetch ?? fetch;
  const headers = { ...(ctx.headers ?? {}) };
  const limit = ctx.timeoutMs ?? PROBE_TIMEOUT_MS;
  let postedJsonRpc = false;
  try {
    const res = await doFetch(ctx.url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mcp-lint", version: "0.0.1" } } }),
      signal: AbortSignal.timeout(limit),
    });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("text/event-stream")) {
      await res.body?.cancel().catch(() => {});
      return [];
    }
    const text = await res.text().catch(() => "");
    postedJsonRpc = /"jsonrpc"\s*:\s*"2\.0"/.test(text);
  } catch {
    return []; // unreachable or timed out: not this rule's finding
  }
  if (postedJsonRpc) return [];
  try {
    const res = await doFetch(ctx.url, { method: "GET", headers: { ...headers, accept: "text/event-stream" }, signal: AbortSignal.timeout(limit) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      await res.body?.cancel().catch(() => {});
      return [];
    }
    const reader = res.body.getReader();
    let seen = "";
    const decoder = new TextDecoder();
    try {
      while (seen.length < 4096 && !/(^|\n)event:\s*endpoint\b/.test(seen)) {
        // An SSE stream normally stays open, so bound the wait for the first event.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([reader.read(), new Promise<typeof timedOut>((r) => { timer = setTimeout(() => r(timedOut), limit); })]);
        clearTimeout(timer);
        if (chunk === timedOut || chunk.done) break;
        const { value } = chunk;
        seen += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (/(^|\n)event:\s*endpoint\b/.test(seen)) {
      return [{ target: ctx.url, message: "only the deprecated HTTP+SSE transport answers here (GET opens an event stream with an `endpoint` event, and POST is not a Streamable HTTP endpoint); HTTP+SSE is Deprecated (SEP-2596), serve Streamable HTTP" }];
    }
  } catch {
    // The GET failing or timing out is inconclusive.
  }
  return [];
}

export const LIVE_RULES: LiveRule[] = [
  {
    id: "stateless-ready",
    description: "The server answers server/discover and serves requests without an initialize handshake (SEP-2575).",
    defaultSeverity: "warn",
    source: "SEP-2575: servers MUST implement server/discover; the initialize handshake is removed in 2026-07-28",
    check: async (client) => {
      const era = client.getProtocolEra?.();
      if (era === undefined && !client.discover) return []; // SDK too old to say; stay silent rather than guess
      if (era !== "modern") {
        // The SDK probes server/discover first and only falls back to initialize when that fails.
        return [{ target: "server/discover", message: "server did not negotiate a 2026-07-28 connection (server/discover failed, so the client fell back to the legacy initialize handshake) (SEP-2575)" }];
      }
      const out: ProbeViolation[] = [];
      try {
        const d = (await client.discover?.()) ?? client.getDiscoverResult?.();
        const versions = (d as { supportedVersions?: unknown } | undefined)?.supportedVersions;
        if (!Array.isArray(versions) || versions.length === 0) out.push({ target: "server/discover", message: "server/discover result lists no supportedVersions (SEP-2575)" });
      } catch (e) {
        out.push({ target: "server/discover", message: `a repeat server/discover failed: ${errorMessage(e)} (SEP-2575)` });
      }
      if (client.getServerCapabilities()?.tools) {
        try {
          await client.listTools(undefined, { cacheMode: "bypass" });
        } catch (e) {
          out.push({ target: "tools/list", message: `request without an initialize handshake failed: ${errorMessage(e)} (SEP-2575)` });
        }
      }
      return out;
    },
  },
  {
    id: "deterministic-list-order",
    description: "Two consecutive tools/list calls return tools in the same order (2026-07-28 changelog: servers SHOULD return tools in a deterministic order).",
    defaultSeverity: "warn",
    source: "2026-07-28 changelog, minor change 3: servers SHOULD return tools from tools/list in a deterministic order",
    check: async (client) => {
      if (!client.getServerCapabilities()?.tools) return [];
      const a = await listAllToolNames(client);
      const b = await listAllToolNames(client);
      if (a.length === b.length && a.every((n, i) => n === b[i])) return [];
      const sameSet = a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");
      return [{ target: "tools/list", message: sameSet ? "two consecutive tools/list calls returned the same tools in a different order" : "two consecutive tools/list calls returned different tool sets" }];
    },
  },
  {
    id: "resource-not-found-code",
    description: "Reading a missing resource fails with -32602 (Invalid Params), not the legacy -32002 (SEP-2164).",
    defaultSeverity: "warn",
    source: "SEP-2164: resource not found changes from -32002 to -32602 (Invalid Params); clients accept both, servers should emit -32602",
    check: async (client) => {
      if (!client.getServerCapabilities()?.resources) return [];
      const uri = `file:///mcp-lint-probe/does-not-exist-${Date.now().toString(36)}`;
      const target = `resources/read ${uri}`;
      try {
        await client.readResource({ uri }, { cacheMode: "bypass" });
      } catch (e) {
        const code = errorCode(e);
        if (code === -32602) return [];
        if (code === -32002) return [{ target, message: "missing resource returned legacy code -32002; 2026-07-28 requires -32602 with data.uri (SEP-2164)" }];
        return [{ target, message: `missing resource returned ${code ?? "a non-JSON-RPC error"} (${errorMessage(e)}), expected -32602 (SEP-2164)` }];
      }
      return [{ target, message: "reading a made-up URI succeeded; a missing resource should fail with -32602 (SEP-2164)" }];
    },
  },
  {
    id: "reserved-error-range",
    description:
      "Error answers to safe probes (unknown method, unknown tool, tools/call without a name, missing resource) do not use codes from -32020..-32099, which the 2026-07-28 spec reserves for itself. Only -32020 / -32021 / -32022 are assigned, and none of them describes these conditions. Judged on 2026-07-28 connections only; no real tool is ever called.",
    defaultSeverity: "warn",
    source: "2026-07-28 changelog (minor change 12) and basic/index, Error Codes: -32020..-32099 are reserved for the MCP specification; implementations MUST NOT emit an undefined code from that range and MUST use defined codes only with their specified meanings",
    check: async (client) => {
      if (client.getProtocolEra?.() === "legacy") return []; // the reservation starts with 2026-07-28; older servers were free to use these codes
      const out: ProbeViolation[] = [];
      const tag = Date.now().toString(36);
      const steps: Array<{ target: string; expect: string; run: () => Promise<unknown> }> = [];
      if (client.request) {
        steps.push({ target: `unknown method mcp-lint/probe-${tag}`, expect: "-32601", run: () => client.request!({ method: `mcp-lint/probe-${tag}` }, ANY_RESULT) });
        steps.push({ target: "tools/call without a name", expect: "-32602", run: () => client.request!({ method: "tools/call", params: {} }, ANY_RESULT) });
      }
      if (client.callTool && client.getServerCapabilities()?.tools) {
        steps.push({ target: `tools/call mcp-lint-probe-no-such-tool-${tag}`, expect: "-32602", run: () => client.callTool!({ name: `mcp-lint-probe-no-such-tool-${tag}` }) });
      }
      if (client.getServerCapabilities()?.resources) {
        steps.push({ target: `resources/read file:///mcp-lint-probe/${tag}`, expect: "-32602", run: () => client.readResource({ uri: `file:///mcp-lint-probe/${tag}` }, { cacheMode: "bypass" }) });
      }
      for (const step of steps) {
        try {
          await step.run();
        } catch (e) {
          const code = rpcErrorCode(e);
          if (code === undefined || code > RESERVED_MAX || code < RESERVED_MIN) continue;
          const assigned = ASSIGNED_CODES[code];
          out.push({
            target: step.target,
            message: assigned
              ? `answered with ${code} (${assigned}), which does not describe this condition; the spec expects ${step.expect} here (2026-07-28 Error Codes)`
              : `answered with ${code}, inside the range -32020..-32099 reserved for the MCP specification and not defined by it; use a code outside -32768..-32000 for server-specific errors, or ${step.expect} here (2026-07-28 Error Codes)`,
          });
        }
      }
      return out;
    },
  },
  {
    id: "sse-only-transport",
    description:
      "A remote server is reachable over Streamable HTTP, not only over the deprecated HTTP+SSE transport (endpoint event on GET). HTTP+SSE is Deprecated (since 2025-03-26) under SEP-2596's lifecycle policy. Runs for --url servers only; works even when the connection itself failed.",
    defaultSeverity: "warn",
    source: "SEP-2596 (feature lifecycle policy): the HTTP+SSE transport is listed as Deprecated in the 2026-07-28 deprecated-features registry; migrate to Streamable HTTP",
    // A connected client already proves Streamable HTTP works, so this only has something to say when the connection failed.
    check: async () => [],
    checkWithoutConnection: (ctx) => detectSseOnly(ctx),
  },
  {
    id: "server-card",
    description: "A remote HTTP server publishes a Server Card at <url>/server-card, and it agrees with the live negotiated versions (SEP-2127).",
    defaultSeverity: "warn",
    source: "SEP-2127: <streamable-http-url>/server-card is the recommended location; card and server/discover SHOULD stay aligned (clients prefer the live values)",
    check: async (client, ctx) => {
      if (!ctx.url) return []; // stdio and other transports have no card location
      const cardUrl = recommendedCardUrl(ctx.url);
      let fetched;
      try {
        // Loopback http is allowed: linting a local dev server is the common case.
        fetched = await fetchServerCard(cardUrl, { allowInsecureLocalhost: true, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
      } catch (e) {
        if (e instanceof DiscoveryError && e.code === "http_error" && /\b404\b|\b410\b/.test(e.message)) {
          return [{ target: cardUrl, message: "no Server Card published here (404); SEP-2127 recommends one at <streamable-http-url>/server-card so clients can discover transports and protocol versions before connecting" }];
        }
        return [{ target: cardUrl, message: `Server Card could not be used: ${sanitizeForDisplay(errorMessage(e), 200)}` }];
      }
      const info = client.getServerVersion?.();
      const supported = (client.getDiscoverResult?.() as { supportedVersions?: unknown } | undefined)?.supportedVersions;
      const findings = compareCardToLive(fetched.card, {
        connectedUrl: ctx.url,
        ...(info ? { serverInfo: info } : {}),
        ...(client.getNegotiatedProtocolVersion?.() ? { negotiatedVersion: client.getNegotiatedProtocolVersion() } : {}),
        ...(Array.isArray(supported) ? { supportedVersions: supported.filter((v): v is string => typeof v === "string") } : {}),
      });
      // `note` findings mean "nothing to compare"; only real disagreements are violations.
      return findings.filter((f) => f.kind === "differs").map((f) => ({ target: cardUrl, message: `${sanitizeForDisplay(f.message, 300)} (SEP-2127: the live server wins)` }));
    },
  },
];

export interface ProbeFinding {
  rule: string;
  severity: "error" | "warn";
  target: string;
  message: string;
  /** Always true: marks the finding as coming from a live probe rather than the contract. */
  probe: true;
}

/** Run the live rules against a connected client. A probe that throws unexpectedly becomes a finding on that rule, never a crash. */
export async function runProbes(client: ProbeClient, opts: { rules?: Record<string, Severity> } & ProbeContext = {}): Promise<ProbeFinding[]> {
  const out: ProbeFinding[] = [];
  for (const rule of LIVE_RULES) {
    const severity = opts.rules?.[rule.id] ?? rule.defaultSeverity;
    if (severity === "off") continue;
    let violations: ProbeViolation[];
    try {
      violations = await rule.check(client, { ...(opts.url ? { url: opts.url } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    } catch (e) {
      violations = [{ target: rule.id, message: `probe could not run: ${errorMessage(e)}` }];
    }
    for (const v of violations) out.push({ rule: rule.id, severity, target: v.target, message: v.message, probe: true });
  }
  return out;
}

/** When connecting failed, run only the rules that do not need a connection (today: `sse-only-transport`). */
export async function runDisconnectedProbes(opts: { rules?: Record<string, Severity> } & ProbeContext = {}): Promise<ProbeFinding[]> {
  const out: ProbeFinding[] = [];
  for (const rule of LIVE_RULES) {
    if (!rule.checkWithoutConnection) continue;
    const severity = opts.rules?.[rule.id] ?? rule.defaultSeverity;
    if (severity === "off") continue;
    const violations = await rule.checkWithoutConnection({ ...(opts.url ? { url: opts.url } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }).catch(() => []);
    for (const v of violations) out.push({ rule: rule.id, severity, target: v.target, message: v.message, probe: true });
  }
  return out;
}
