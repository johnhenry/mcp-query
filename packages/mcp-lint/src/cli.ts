#!/usr/bin/env node
// mcp-lint CLI — quality-lint an MCP server's capability surface.
//
//   mcp-lint --command npx --args "-y @modelcontextprotocol/server-everything"
//   mcp-lint --url https://host/mcp --bearer "$TOKEN"
//   mcp-lint --contract mcp.contract.json [--max-warnings 0] [--off naming-consistency,no-open-input]
//   mcp-lint --url https://host/mcp --probe     # also run the live-probe rules (needs a live server)
//   mcp-lint --url https://host/mcp --era legacy # capture with the plain initialize handshake (default: --era auto,
//                                               # server/discover first, initialize as the fallback)
//
// A live server is reached over stdio (--command) or Streamable HTTP (--url, with optional
// --bearer / repeated --header "K: V"). Unknown flags are rejected. Exits non-zero on any
// error, or warnings over --max-warnings.

import { readFile } from "node:fs/promises";
import { captureContract, connectEra, resolveConnect, rejectUnknownFlags, upgradeContract, parseEra, withEra, ERA_FLAG_HELP, type Contract } from "../../mcp-contract/src/index.js";
import { lintContract, type Finding, type LintOptions } from "./lint.js";
import { formatLint } from "./report.js";
import { RULES, type Severity } from "./rules.js";
import { LIVE_RULES, runDisconnectedProbes, runProbes, type ProbeClient } from "./probes.js";

const KNOWN_FLAGS = ["server", "config", "command", "args", "url", "bearer", "header", "contract", "max-warnings", "off", "error", "list-rules", "probe", "era"] as const;

function parseArgs(argv: string[]): { flags: Record<string, string>; headers: string[] } {
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a === "--probe") flags.probe = "true"; // boolean: takes no value
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return { flags, headers };
}

async function loadContract(flags: Record<string, string>, headers: string[]): Promise<{ contract?: Contract; probes?: Finding[] }> {
  if (flags.contract) return { contract: upgradeContract(JSON.parse(await readFile(flags.contract, "utf8"))) }; // reads v1 and v2
  // --era beats a registry pin, which beats the default (auto). --probe always negotiates with the bounded
  // `server/discover` probe: its rules (stateless-ready, reserved-error-range) observe the modern handshake.
  const target = withEra(resolveConnect(flags, headers), flags.era);
  if ("probe" in flags) target.era = "auto";
  let connection;
  try {
    connection = await connectEra({ ...target, clientName: "mcp-lint" });
  } catch (e) {
    // A server that only speaks HTTP+SSE cannot be connected to over Streamable HTTP; `sse-only-transport` is the finding to report.
    if (!("probe" in flags) || !target.url) throw e;
    const probes = await runDisconnectedProbes({ rules: overridesFrom(flags), url: target.url, ...(target.headers ? { headers: target.headers } : {}) });
    if (probes.length === 0) throw e;
    console.error(`[mcp-lint] could not connect (${e instanceof Error ? e.message : e}); reporting what a connection-less probe found`);
    return { probes };
  }
  const { client, close } = connection;
  try {
    const contract = await captureContract(client);
    if (!("probe" in flags)) return { contract };
    // Live mode: keep the connection open for the probe rules, with the same severity overrides.
    const probes = await runProbes(client as unknown as ProbeClient, { rules: overridesFrom(flags), ...(target.url ? { url: target.url } : {}), ...(target.headers ? { headers: target.headers } : {}) });
    return { contract, probes };
  } finally {
    await close();
  }
}

function overridesFrom(flags: Record<string, string>): Record<string, Severity> {
  const overrides: Record<string, Severity> = {};
  for (const id of (flags.off ?? "").split(",").map((s) => s.trim()).filter(Boolean)) overrides[id] = "off";
  for (const id of (flags.error ?? "").split(",").map((s) => s.trim()).filter(Boolean)) overrides[id] = "error";
  return overrides;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { flags, headers } = parseArgs(argv);
  rejectUnknownFlags("mcp-lint", flags, KNOWN_FLAGS);
  if ("list-rules" in flags) {
    console.error(RULES.map((r) => `  ${r.id} (${r.defaultSeverity}) — ${r.description}`).join("\n"));
    console.error("\nlive-probe rules (only with --probe, never against --contract):");
    console.error(LIVE_RULES.map((r) => `  ${r.id} (${r.defaultSeverity}) — ${r.description}`).join("\n"));
    return;
  }
  if (parseEra(flags.era) === "legacy" && "probe" in flags) throw new Error("--probe needs the default --era auto (its rules observe the server/discover handshake); drop --era legacy");
  if ("probe" in flags && flags.contract) throw new Error("--probe needs a live server (--url or --command); it cannot run against a pinned --contract file");
  const { contract, probes } = await loadContract(flags, headers);

  const opts: LintOptions = { rules: overridesFrom(flags) };

  const base = contract ? lintContract(contract, opts) : { findings: [] as Finding[], skipped: undefined };
  const findings = [...base.findings, ...(probes ?? [])];
  const result = { findings, ...(base.skipped ? { skipped: base.skipped } : {}), errors: findings.filter((f) => f.severity === "error").length, warnings: findings.filter((f) => f.severity === "warn").length };
  console.error(formatLint(result, { color: process.stderr.isTTY }));

  const maxWarnings = flags["max-warnings"] !== undefined ? Number(flags["max-warnings"]) : Infinity;
  process.exit(result.errors > 0 || result.warnings > maxWarnings ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error("[mcp-lint]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
