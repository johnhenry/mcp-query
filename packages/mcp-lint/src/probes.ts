// Live-probe lint rules (opt-in, `mcp-lint --probe`).
//
// The rules in rules.ts are *contract-only*: pure functions of one captured Contract, so they
// are safe to run against a pinned contract file. The rules here need a live connection (a
// second request, a deliberately failing request), so they take a connected client instead.
// They are kept in their own list on purpose: `lintContract` never runs them, and the CLI
// refuses `--probe` together with `--contract`.

import { Client } from "@modelcontextprotocol/client";
import { buildTransport, type ConnectOptions } from "../../mcp-contract/src/index.js";
import type { Severity } from "./rules.js";

/**
 * Connect for probing. Unlike the contract tools' default (the classic initialize handshake), this
 * lets the SDK try `server/discover` first (`versionNegotiation: auto`) and fall back to
 * `initialize`, which is exactly what `stateless-ready` needs to observe.
 */
export async function connectProbeClient(opts: ConnectOptions): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: opts.clientName ?? "mcp-lint", version: "0.0.1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  await client.connect(buildTransport(opts));
  return { client, close: () => client.close().catch(() => {}) };
}

/** The slice of the SDK client the probes use. Kept structural so tests can inject fakes. */
export interface ProbeClient {
  getServerCapabilities(): Record<string, unknown> | undefined;
  getProtocolEra?(): string | undefined;
  getDiscoverResult?(): unknown;
  discover?(): Promise<unknown>;
  listTools(params?: { cursor?: string }, options?: { cacheMode?: "use" | "refresh" | "bypass" }): Promise<{ tools: Array<{ name: string }>; nextCursor?: string }>;
  readResource(params: { uri: string }, options?: { cacheMode?: "use" | "refresh" | "bypass" }): Promise<unknown>;
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
  check: (client: ProbeClient) => Promise<ProbeViolation[]>;
}

const errorCode = (e: unknown): number | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
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
export async function runProbes(client: ProbeClient, opts: { rules?: Record<string, Severity> } = {}): Promise<ProbeFinding[]> {
  const out: ProbeFinding[] = [];
  for (const rule of LIVE_RULES) {
    const severity = opts.rules?.[rule.id] ?? rule.defaultSeverity;
    if (severity === "off") continue;
    let violations: ProbeViolation[];
    try {
      violations = await rule.check(client);
    } catch (e) {
      violations = [{ target: rule.id, message: `probe could not run: ${errorMessage(e)}` }];
    }
    for (const v of violations) out.push({ rule: rule.id, severity, target: v.target, message: v.message, probe: true });
  }
  return out;
}
