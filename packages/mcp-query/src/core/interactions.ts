// InteractionBroker — one place that mediates every server→client request needing a
// human: sampling approval, elicitation, (and destructive-tool confirms later). They
// share a shape — pending request → surface to UI → await an approve/deny/edit decision
// → resolve — so they share this machinery instead of each re-rolling UI plumbing.
//
// Wired by MCPClient (pass `interactions`). The React `useInteractions()` hook reads the
// pending queue reactively; `useAuditLog()` reads the trail.

import type { HostHandlers } from "./types.js";

export type InteractionType = "sampling" | "elicitation" | "confirm";

/** "request": pre-model approval / elicitation. "response": post-model redaction. */
export type InteractionPhase = "request" | "response";

/** Trust policy verdict per request. */
export type PolicyVerdict = "allow" | "deny" | "ask";

export interface PolicyContext {
  server: string;
  type: InteractionType;
  payload: unknown;
}

export interface Interaction {
  id: number;
  type: InteractionType;
  phase: InteractionPhase;
  server: string;
  /** sampling request params, elicitation {message, requestedSchema}, or {result}. */
  payload: unknown;
  /** True when the human must *author* the result (manual sampling), not just approve. */
  manual?: boolean;
  createdAt: number;
}

export interface InteractionDecision {
  action: "approve" | "deny";
  /** sampling request-phase: replace the messages sent to the model. */
  editedMessages?: unknown;
  /** sampling response-phase: replace the result returned to the server (redaction). */
  editedResult?: unknown;
  /** elicitation: the structured content the user supplied. */
  content?: unknown;
  reason?: string;
}

export interface AuditEntry {
  id: number;
  at: number;
  server: string;
  type: InteractionType;
  outcome: "auto-allow" | "auto-deny" | "approved" | "denied" | "error";
  reason?: string;
}

export interface InteractionBrokerOptions {
  /** Runs the actual LLM for sampling, e.g. chromeBuiltinAISampling(). Omit ⇒ sampling not offered. */
  model?: NonNullable<HostHandlers["sampling"]>;
  /**
   * Human-as-model sampling (MCP Inspector style): instead of an LLM, a person authors
   * the response in the approval UI. Sampling is still advertised; the request-phase
   * decision must carry `editedResult`. Takes precedence over `model`.
   */
  manualSampling?: boolean;
  /** Per-request trust policy. Default: "ask" for everything. */
  policy?: (ctx: PolicyContext) => PolicyVerdict | Promise<PolicyVerdict>;
  /** When true, every human-approved sampling result also gets a response-review step. */
  reviewResponses?: boolean;
  /** Audit sink (also kept in an in-memory ring buffer). */
  onAudit?: (entry: AuditEntry) => void;
  now?: () => number;
}

function declined(reason?: string): Error & { code: number } {
  return Object.assign(new Error(reason ?? "declined by host"), { code: -32001 });
}
function unavailable(msg: string): Error & { code: number } {
  return Object.assign(new Error(msg), { code: -32601 });
}

export class InteractionBroker {
  private pending = new Map<number, { interaction: Interaction; resolve: (d: InteractionDecision) => void }>();
  private audit: AuditEntry[] = [];
  private listeners = new Set<() => void>();
  private auditSinks = new Set<(e: AuditEntry) => void>();
  private seq = 0;
  private version = 0;
  private now: () => number;

  constructor(private opts: InteractionBrokerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    if (opts.onAudit) this.auditSinks.add(opts.onAudit);
  }

  // ── reactive store (for hooks/devtools) ─────────────────────────────────
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;
  list = (): Interaction[] => [...this.pending.values()].map((p) => p.interaction);
  auditLog = (): readonly AuditEntry[] => this.audit;
  addAuditSink = (fn: (e: AuditEntry) => void): (() => void) => {
    this.auditSinks.add(fn);
    return () => this.auditSinks.delete(fn);
  };

  /** UI settles a pending interaction. */
  resolve = (id: number, decision: InteractionDecision): void => {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(decision);
    this.bump();
  };

  // ── server→client entry points (installed per-server by MCPClient) ───────
  async handleSampling(server: string, params: unknown): Promise<unknown> {
    const verdict = await this.decide({ server, type: "sampling", payload: params });
    if (verdict === "deny") {
      this.record(server, "sampling", "auto-deny");
      throw declined("sampling denied by policy");
    }

    // Manual mode: a human authors the response in the UI (the Inspector pattern).
    if (this.opts.manualSampling) {
      const d = await this.enqueue("sampling", "request", server, params, true);
      if (d.action === "deny") {
        this.record(server, "sampling", "denied", d.reason);
        throw declined(d.reason);
      }
      if (d.editedResult === undefined) {
        this.record(server, "sampling", "error", "manual sampling produced no result");
        throw declined("manual sampling requires an authored result");
      }
      this.record(server, "sampling", "approved");
      return d.editedResult;
    }

    const p = params as { messages?: unknown };
    let messages = p.messages;
    if (verdict === "ask") {
      const d = await this.enqueue("sampling", "request", server, params);
      if (d.action === "deny") {
        this.record(server, "sampling", "denied", d.reason);
        throw declined(d.reason);
      }
      if (d.editedMessages !== undefined) messages = d.editedMessages;
    }

    if (!this.opts.model) {
      this.record(server, "sampling", "error", "no model configured");
      throw unavailable("no sampling model configured");
    }
    let result = await this.opts.model({ ...(params as object), messages });

    if (this.opts.reviewResponses && verdict === "ask") {
      const d = await this.enqueue("sampling", "response", server, { result });
      if (d.action === "deny") {
        this.record(server, "sampling", "denied", "response rejected");
        throw declined("response rejected by host");
      }
      if (d.editedResult !== undefined) result = d.editedResult;
    }

    this.record(server, "sampling", verdict === "allow" ? "auto-allow" : "approved");
    return result;
  }

  async handleElicitation(server: string, params: unknown): Promise<{ action: string; content?: unknown }> {
    const verdict = await this.decide({ server, type: "elicitation", payload: params });
    if (verdict === "deny") {
      this.record(server, "elicitation", "auto-deny");
      return { action: "decline" };
    }
    if (verdict === "allow") {
      this.record(server, "elicitation", "auto-allow");
      return { action: "accept", content: {} };
    }
    const d = await this.enqueue("elicitation", "request", server, params);
    if (d.action === "deny") {
      this.record(server, "elicitation", "denied", d.reason);
      return { action: "decline" };
    }
    this.record(server, "elicitation", "approved");
    return { action: "accept", content: d.content ?? {} };
  }

  /** Build server-bound HostHandlers that route sampling/elicitation through the broker. */
  handlersFor(server: string, base: HostHandlers): HostHandlers {
    const h: HostHandlers = { roots: base.roots };
    if (this.opts.model || this.opts.manualSampling) h.sampling = (p) => this.handleSampling(server, p);
    h.elicitation = (p) => this.handleElicitation(server, p) as ReturnType<NonNullable<HostHandlers["elicitation"]>>;
    return h;
  }

  // ── internals ────────────────────────────────────────────────────────────
  private async decide(ctx: PolicyContext): Promise<PolicyVerdict> {
    return this.opts.policy ? await this.opts.policy(ctx) : "ask";
  }

  private enqueue(
    type: InteractionType,
    phase: InteractionPhase,
    server: string,
    payload: unknown,
    manual = false,
  ): Promise<InteractionDecision> {
    const id = ++this.seq;
    const interaction: Interaction = { id, type, phase, server, payload, manual, createdAt: this.now() };
    return new Promise<InteractionDecision>((resolve) => {
      this.pending.set(id, { interaction, resolve });
      this.bump();
    });
  }

  private record(server: string, type: InteractionType, outcome: AuditEntry["outcome"], reason?: string): void {
    const entry: AuditEntry = { id: ++this.seq, at: this.now(), server, type, outcome, reason };
    this.audit.push(entry);
    if (this.audit.length > 500) this.audit.shift();
    for (const sink of this.auditSinks) sink(entry);
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
