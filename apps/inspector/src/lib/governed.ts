// Governed mode for the Apps tab (#58): an app-initiated tools/call that matches the approve patterns parks as a
// pending approval a person decides, next to the app. Off by default.
//
// ONE connection. The inspector's single MCPClient is built with `governance.interceptor`, a request interceptor
// that does nothing unless the operation is an app-initiated one for an app opened in governed mode (principal
// `mcp-app:<uri>`, stamped by the app host, plus a `governed` flag its `context` callback sets). It is the same
// `authorize()` + approval-broker pair mcp-gate's `createGateClient` installs (see mcp-gate `buildGateClient`), scoped
// to those calls, so the Tools tab, the Messages log and ungoverned apps are never held, and a stdio server is
// spawned once.
import { InteractionBroker, type RequestInterceptor } from "@johnhenry/mcp-query";
import { AuthorizationError, authorize, type AuthzRequest } from "@johnhenry/mcp-query/server";

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
  /** The broker id as a string (unique across servers: one broker). */
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
  /** Patterns, newest edit wins. Default approves every governed app-initiated tool call. */
  patterns: string[] = ["*"];
  /** A broker of its own (not the inspector's), so these requests show only beside the app. Asks a person for everything. */
  readonly broker = new InteractionBroker();
  private governedApps = new Set<string>();
  private listeners = new Set<() => void>();

  constructor() {
    this.broker.subscribe(() => this.notify());
  }

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

  /** Mark the app at `uri` as governed (or not) for the sessions opened from now on. Read back through {@link context}. */
  setGoverned(uri: string, governed: boolean): void {
    if (governed) this.governedApps.add(uri);
    else this.governedApps.delete(uri);
  }
  isGoverned(uri: string): boolean {
    return this.governedApps.has(uri);
  }

  /** `createAppHost({ context })`: tags an app's requests so the interceptor knows to govern them. */
  context = (session: { uri: string }): { meta: Record<string, unknown> } => ({ meta: { governed: this.isGoverned(session.uri) } });

  private approve = async (req: AuthzRequest): Promise<void> => {
    const request = { id: 0, kind: req.kind, server: req.server, target: req.target, args: req.args, destructive: req.destructive, readOnly: req.readOnly, context: req.context };
    const { verdict, decision } = await this.broker.gate(
      "tool-call",
      req.server,
      { tool: req.target, args: req.args, destructive: req.destructive, request },
      { autoApprove: { action: "approve" }, autoDeny: { action: "deny", reason: "policy" } }, // no handler, no timeout: a person decides
    );
    if (verdict === "auto-deny" || verdict === "denied") {
      throw new AuthorizationError(`denied: ${req.kind} ${req.server}.${req.target} not approved${decision?.reason ? ` (${decision.reason})` : ""}`);
    }
  };

  private gate = authorize(approvePolicy(() => this.patterns), { onApprove: this.approve });

  /** Install on the inspector's client (`new MCPClient({ interceptors: [governance.interceptor] })`). Pass-through for everything but governed app calls. */
  interceptor: RequestInterceptor = (op, next) => {
    const meta = op.context?.meta as { principal?: unknown; governed?: unknown } | undefined;
    if (meta?.governed === true && typeof meta.principal === "string" && meta.principal.startsWith("mcp-app:")) return this.gate(op, next);
    return next(op);
  };

  /** Approvals waiting for a person, across servers, oldest first. */
  pending(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const it of this.broker.list()) {
      const req = (it.payload as { request?: { server: string; kind: string; target: string; args?: Record<string, unknown>; destructive?: boolean; context?: { meta?: Record<string, unknown> } } } | undefined)?.request;
      if (!req) continue;
      const principal = req.context?.meta?.principal;
      out.push({
        key: String(it.id),
        server: req.server,
        id: it.id,
        kind: req.kind,
        target: req.target,
        ...(req.args ? { args: req.args } : {}),
        destructive: req.destructive === true,
        ...(typeof principal === "string" ? { principal } : {}),
      });
    }
    return out;
  }

  /** Approve or deny one pending approval; the app's call resolves (or is refused with -32003) accordingly. */
  decide(key: string, action: "approve" | "deny"): void {
    const p = this.pending().find((x) => x.key === key);
    if (!p) return;
    this.broker.resolve(p.id, action === "approve" ? { action: "approve" } : { action: "deny", reason: "denied in the inspector" });
  }

  /** Deny everything still waiting for `principal` on `server` (the app was closed). */
  denyFor(server: string, principal: string): void {
    for (const p of this.pending()) if (p.server === server && p.principal === principal) this.decide(p.key, "deny");
  }

  /** The server was disconnected: refuse whatever still waits on it. */
  closeServer(server: string): void {
    for (const p of this.pending()) if (p.server === server) this.broker.resolve(p.id, { action: "deny", reason: "server disconnected" });
  }
}

export const governance = new Governance();
