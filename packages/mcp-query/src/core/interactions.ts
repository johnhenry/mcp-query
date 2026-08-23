// InteractionBroker — one place that mediates every server→client request needing a
// human: sampling approval, elicitation, (and destructive-tool confirms later). They
// share a shape — pending request → surface to UI → await an approve/deny/edit decision
// → resolve — so they share this machinery instead of each re-rolling UI plumbing.
//
// Wired by MCPClient (pass `interactions`). The React `useInteractions()` hook reads the
// pending queue reactively; `useAuditLog()` reads the trail.
//
// Era note (2026-07-28): on legacy connections handleSampling/handleElicitation
// answer server→client JSON-RPC requests; on modern connections the SDK's
// multi-round-trip driver invokes the same handlers for requests a server embeds
// in an `input_required` result. The policy gate, approval queue, and audit trail
// apply identically to both delivery paths.
//
// Issue #18: a thin, MCP-flavored subclass of @johnhenry/agent-query-core's
// InteractionBroker<D> — decide()/enqueue()/record()/resolve()/subscribe()/etc. are all
// inherited unchanged (mcp-query's own private versions of these were structurally identical
// to core's, just server-flavored). handleSampling/handleElicitation keep their EXACT
// original control flow (including the manual-sampling "always enqueue even when policy
// auto-allows, since a human must author the result" branch, which doesn't map cleanly
// onto core's higher-level gate() helper) — only the PolicyContext object literal passed
// into decide() changes shape (`peer` in place of `server`, since that's core's own
// PolicyContext). PolicyContext itself stays mcp-query's own local, `server`-named type
// (decoupled from core's, same as AuthzRequest/CallAuditEntry) so callers' policy
// functions don't need to change. Interaction/AuditEntry are NOT locally redefined —
// they're re-exported straight from core, which means their `.server` is really `.peer`
// now (see devtools/Panel.tsx, react/interactions.ts, and every other reader).

import {
  InteractionBroker as CoreInteractionBroker,
  type BaseDecision,
  type AuditEntry as CoreAuditEntry,
  type InteractionBrokerOptions as CoreInteractionBrokerOptions,
  type PolicyContext as CorePolicyContext,
  type PolicyVerdict as CorePolicyVerdict,
} from "@johnhenry/agent-query-core";
import type { ElicitationRequest, HostHandlers } from "./types.js";

export type InteractionType = "sampling" | "elicitation" | "confirm";

/** "request": pre-model approval / elicitation. "response": post-model redaction. */
export type InteractionPhase = "request" | "response";

/** Trust policy verdict per request. */
export type PolicyVerdict = CorePolicyVerdict;

/** mcp-query's own decoupled PolicyContext — kept `server`-named so policy functions don't change. */
export interface PolicyContext {
  server: string;
  type: InteractionType;
  payload: unknown;
}

/** Re-exported straight from core — `.peer`, not `.server` (see file header). */
export type { Interaction, AuditEntry } from "@johnhenry/agent-query-core";

export interface InteractionDecision extends BaseDecision {
  /** sampling request-phase: replace the messages sent to the model. */
  editedMessages?: unknown;
  /** sampling response-phase: replace the result returned to the server (redaction). */
  editedResult?: unknown;
  /** elicitation: the structured content the user supplied. */
  content?: unknown;
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
  onAudit?: (entry: CoreAuditEntry) => void;
  now?: () => number;
}

function declined(reason?: string): Error & { code: number } {
  return Object.assign(new Error(reason ?? "declined by host"), { code: -32001 });
}
function unavailable(msg: string): Error & { code: number } {
  return Object.assign(new Error(msg), { code: -32601 });
}

export class InteractionBroker extends CoreInteractionBroker<InteractionDecision> {
  private mcpOpts: InteractionBrokerOptions;

  constructor(opts: InteractionBrokerOptions = {}) {
    const coreOpts: CoreInteractionBrokerOptions = {
      now: opts.now,
      onAudit: opts.onAudit,
      policy: opts.policy
        ? (ctx: CorePolicyContext) => opts.policy!({ server: ctx.peer, type: ctx.type as InteractionType, payload: ctx.payload })
        : undefined,
    };
    super(coreOpts);
    this.mcpOpts = opts;
  }

  // ── server→client entry points (installed per-server by MCPClient) ───────
  async handleSampling(server: string, params: unknown): Promise<unknown> {
    const verdict = await this.decide({ peer: server, type: "sampling", payload: params });
    if (verdict === "deny") {
      this.record(server, "sampling", "auto-deny");
      throw declined("sampling denied by policy");
    }

    // Manual mode: a human authors the response in the UI (the Inspector pattern).
    // Always enqueues, even when policy auto-allows — there's no model to call, a human
    // must author the result regardless — so this deliberately doesn't use gate()'s
    // "allow skips the queue" shortcut.
    if (this.mcpOpts.manualSampling) {
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

    if (!this.mcpOpts.model) {
      this.record(server, "sampling", "error", "no model configured");
      throw unavailable("no sampling model configured");
    }
    let result = await this.mcpOpts.model({ ...(params as object), messages });

    if (this.mcpOpts.reviewResponses && verdict === "ask") {
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

  async handleElicitation(server: string, params: ElicitationRequest): Promise<{ action: string; content?: unknown }> {
    const verdict = await this.decide({ peer: server, type: "elicitation", payload: params });
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
    if (this.mcpOpts.model || this.mcpOpts.manualSampling) h.sampling = (p) => this.handleSampling(server, p);
    h.elicitation = (p) => this.handleElicitation(server, p) as ReturnType<NonNullable<HostHandlers["elicitation"]>>;
    return h;
  }
}
