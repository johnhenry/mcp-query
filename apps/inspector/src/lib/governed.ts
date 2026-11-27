// Governed mode for the Apps tab (#58): an app-initiated tools/call goes through mcp-gate's
// governed client instead of straight to the server, so a policy `approve` verdict parks the call
// as a pending approval a person decides, next to the app. Off by default.
//
// This is mcp-gate's BROWSER entry only (`createGateClient`: the full interceptor stack, no gateway
// Server, no stdio): a second, gated MCPClient connected to the same server through the same transport
// factory the inspector used. The inspector's own client (Tools tab, Messages log) is untouched.
import { createGateClient, type GateClient } from "@johnhenry/mcp-gate";
import type { AuthzRequest } from "@johnhenry/mcp-query/server";
import type { ConnectionConfig, InteractionBroker, MCPClient } from "@johnhenry/mcp-query";
import { disconnectHooks, serverConfigs } from "./store.js";

/** `*` matches any run of characters; everything else is literal. Matched against `server.tool`. */
export function globMatches(glob: string, id: string): boolean {
  const re = new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(id);
}

/** Parse the patterns box: comma/newline separated, blanks dropped. */
export function parsePatterns(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The inspector's policy: a tool CALL whose `server.tool` id matches a pattern needs approval; everything else
 * (resource reads, catalog lists, unmatched calls) is allowed. `patterns` is read on every call, so editing
 * the box applies to the next call without reconnecting.
 */
export function approvePolicy(patterns: () => readonly string[]): (req: AuthzRequest) => "allow" | "approve" {
  return (req) => (req.kind === "call" && patterns().some((p) => globMatches(p, `${req.server}.${req.target}`)) ? "approve" : "allow");
}

export interface PendingApproval {
  /** Unique across servers: `<server>#<broker id>`. */
  key: string;
  server: string;
  id: number;
  kind: string;
  /** Tool name as the upstream knows it. */
  target: string;
  args?: Record<string, unknown>;
  destructive: boolean;
  /** Who asked: `mcp-app:<ui uri>` for an app-initiated call. */
  principal?: string;
}

export class Governance {
  /** Patterns, newest edit wins. Default approves every app-initiated tool call. */
  patterns: string[] = ["*"];
  private gates = new Map<string, GateClient>();
  private building = new Map<string, Promise<GateClient>>();
  private unsubs = new Map<string, () => void>();
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  private notify(): void {
    for (const l of this.listeners) l();
  }

  setPatterns(p: string[]): void {
    this.patterns = p;
    this.notify();
  }

  /** The governed client for `server` (connected lazily, once). Throws if the server is not connected in the inspector. */
  async clientFor(server: string, configs: ReadonlyMap<string, ConnectionConfig> = serverConfigs): Promise<MCPClient> {
    const have = this.gates.get(server);
    if (have) return have.client;
    let pending = this.building.get(server);
    if (!pending) {
      const cfg = configs.get(server);
      if (!cfg) throw new Error(`"${server}" has no saved connection to govern`);
      pending = createGateClient({
        upstreams: { [server]: cfg },
        policy: approvePolicy(() => this.patterns),
        approval: {}, // a fresh broker that asks a person for every "approve" (no handler, no timeout)
        audit: () => {}, // the inspector's Messages log and the app's own call list are the record
        clientInfo: { name: "mcp-inspector-gate", version: "0.0.1", title: "MCP Inspector (governed)" },
      }).then((gate) => {
        this.gates.set(server, gate);
        const broker = gate.approvals as InteractionBroker;
        this.unsubs.set(server, broker.subscribe(() => this.notify()));
        return gate;
      });
      this.building.set(server, pending);
      pending.finally(() => this.building.delete(server)).catch(() => {});
    }
    return (await pending).client;
  }

  /** Approvals waiting for a person, across servers, oldest first. */
  pending(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const [server, gate] of this.gates) {
      for (const it of gate.approvals?.list() ?? []) {
        const req = (it.payload as { request?: { kind: string; target: string; args?: Record<string, unknown>; destructive?: boolean; context?: { meta?: Record<string, unknown> } } } | undefined)?.request;
        if (!req) continue;
        const principal = req.context?.meta?.principal;
        out.push({
          key: `${server}#${it.id}`,
          server,
          id: it.id,
          kind: req.kind,
          target: req.target,
          ...(req.args ? { args: req.args } : {}),
          destructive: req.destructive === true,
          ...(typeof principal === "string" ? { principal } : {}),
        });
      }
    }
    return out;
  }

  /** Approve or deny one pending approval; the app's call resolves (or is refused with -32003) accordingly. */
  decide(key: string, action: "approve" | "deny"): void {
    const p = this.pending().find((x) => x.key === key);
    if (!p) return;
    this.gates.get(p.server)?.approvals?.resolve(p.id, action === "approve" ? { action: "approve" } : { action: "deny", reason: "denied in the inspector" });
  }

  /** Deny everything still waiting for `principal` on `server` (the app was closed). */
  denyFor(server: string, principal: string): void {
    for (const p of this.pending()) if (p.server === server && p.principal === principal) this.decide(p.key, "deny");
  }

  async close(server: string): Promise<void> {
    this.unsubs.get(server)?.();
    this.unsubs.delete(server);
    const gate = this.gates.get(server);
    this.gates.delete(server);
    if (gate) {
      for (const it of gate.approvals?.list() ?? []) gate.approvals?.resolve(it.id, { action: "deny", reason: "server disconnected" });
      await gate.close().catch(() => {});
    }
    this.notify();
  }
}

export const governance = new Governance();
disconnectHooks.add((name) => void governance.close(name));
