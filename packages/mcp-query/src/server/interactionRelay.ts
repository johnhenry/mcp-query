// Interaction relay (#82): forwarding an elicitation from a 2025-era upstream to the gateway's consumer.
//
// A 2026-07-28 upstream asks for input in-band (`input_required`), which the gateway can hand on as it
// is. A 2025-era upstream asks by sending the gate's client a server-initiated `elicitation/create`
// request WHILE the tool call is still open. To relay that, the gate must (1) keep the upstream call
// pending, (2) turn the request into a round the consumer can answer, and (3) feed the consumer's
// answer back to the waiting upstream request. This class is the bookkeeping for (1) and (3); the
// gateway (gateway.ts) does (2) in whichever form the consumer's era uses.
//
// Install it as the gate client's `interactions` broker, then serve that client with `createGateway` /
// `createGatewayHandler` and `interactions: "forward"`:
//
//   const relay = new InteractionRelay({ forwards: (server) => server === "github" });
//   const client = new MCPClient({ servers, interactions: relay });
//   const gate = createGateway(client, { interactions: { upstreams: { github: "forward" } } });
//
// Correlation. A legacy upstream's `elicitation/create` names no request: it arrives on the
// connection, nothing says which in-flight call it belongs to. So calls to a relayed upstream are
// serialized: one in flight per upstream at a time, and an elicitation that arrives is by
// construction that call's. (Calls to OTHER upstreams are unaffected.) An elicitation with no call
// in flight is refused. The consumer's answer is matched by an unguessable one-use `requestState`
// bound to the verified principal and partition that started the call, the upstream, the surface
// and the target: a consumer can only ever resolve the request it was shown.
//
// Fail closed. No consumer capability for the mode asked, no call in flight, too many pending
// calls: the upstream's request is answered with a JSON-RPC error. A consumer that never answers:
// after `timeoutMs` the request is answered `{ action: "decline" }`.

import { InteractionBroker } from "../core/interactions.js";
import type { ElicitationRequest, HostHandlers } from "../core/types.js";

/** Who started a relayed call: the identity the gateway verified (`_meta.principal` / partition). */
export interface RelayIdentity {
  principal?: string;
  partition?: string;
}

/** What a retry has to match to resolve a pending ask. */
export interface RelayExpect {
  server: string;
  surface: "tool" | "prompt" | "resource";
  target: string;
}

/** One elicitation waiting for the consumer. */
export interface RelayAsk {
  /** The one-use token the consumer echoes as `requestState`. */
  state: string;
  /** The key to answer under in `inputResponses`. */
  key: string;
  /** The upstream's `elicitation/create` params, as received. */
  params: Record<string, unknown>;
}

/** What a relayed call is doing next: finished, or waiting on the consumer for an answer. */
export type RelayStep<T> = ({ kind: "ask" } & RelayAsk) | { kind: "done"; value: T };

export interface InteractionRelayOptions {
  /** Which upstreams are relayed (default: all). An upstream that is not keeps the client's ordinary handlers. */
  forwards?: (server: string) => boolean;
  /** How long a consumer has to answer before the upstream's request is declined. Default 300 000 ms. */
  timeoutMs?: number;
  /** Relayed calls in flight or queued at once, across all upstreams. Past it a new call is refused. Default 256. */
  maxPending?: number;
}

/** Arguments of {@link InteractionRelay.begin}. */
export interface RelayBegin extends RelayExpect {
  args: Record<string, unknown>;
  who: RelayIdentity;
  /** Can the consumer take this elicitation (declared capability for its mode)? Otherwise the upstream's request is refused. */
  accepts: (params: Record<string, unknown>) => boolean;
  /** Called (once) when an ask times out unanswered and is declined. */
  onExpire?: (ask: RelayAsk) => void;
  signal?: AbortSignal;
}

type Answer = { action: string; content?: unknown; _meta?: Record<string, unknown> };

interface CallRec {
  id: string;
  begin: RelayBegin;
  ask?: { ask: RelayAsk; resolve: (a: Answer) => void; timer: ReturnType<typeof setTimeout> };
  waiter?: { resolve: (s: RelayStep<unknown>) => void; reject: (e: unknown) => void; detach: () => void };
  finished: boolean;
  abandoned: boolean;
  seq: number;
  /** Serializes concurrent asks from one call. */
  chain: Promise<void>;
  release: () => void;
}

const rpcError = (code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } =>
  Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });

/** The error for a `requestState` that is unknown, spent, expired or someone else's: deliberately one answer for all of them. */
export function invalidRequestState(): Error & { code: number; data?: unknown } {
  return rpcError(-32602, "Invalid or expired requestState", { reason: "invalid_request_state" });
}

const uuid = (): string => globalThis.crypto.randomUUID();

/** Normalize a consumer's reply to an `ElicitResult`; anything unrecognised is a cancel. */
function toAnswer(value: unknown): Answer {
  const a = value as { action?: unknown } | null;
  if (a && typeof a === "object" && (a.action === "accept" || a.action === "decline" || a.action === "cancel")) return value as Answer;
  return { action: "cancel" };
}

const RELAY_BRAND = Symbol.for("@johnhenry/mcp-query.InteractionRelay");

/** True for an {@link InteractionRelay} (also across duplicate copies of this package). */
export function isInteractionRelay(x: unknown): x is InteractionRelay {
  return x instanceof InteractionRelay || (typeof x === "object" && x !== null && (x as Record<symbol, unknown>)[RELAY_BRAND] === true);
}

export class InteractionRelay extends InteractionBroker {
  readonly [RELAY_BRAND] = true;

  private readonly forwards: (server: string) => boolean;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly active = new Map<string, CallRec>();
  private readonly byState = new Map<string, CallRec>();
  private readonly tails = new Map<string, Promise<void>>();
  private count = 0;

  constructor(opts: InteractionRelayOptions = {}) {
    super({});
    this.forwards = opts.forwards ?? (() => true);
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxPending = opts.maxPending ?? 256;
  }

  /** True for an upstream this relay carries elicitations for. */
  relays(server: string): boolean {
    return this.forwards(server);
  }

  /** Relayed upstreams get the relay's elicitation handler (which declares the capability); the rest keep the client's own handlers. */
  override handlersFor(server: string, base: HostHandlers): HostHandlers {
    if (!this.forwards(server)) return base;
    return { ...base, elicitation: (p) => this.handleElicitation(server, p as ElicitationRequest) as ReturnType<NonNullable<HostHandlers["elicitation"]>> };
  }

  // ── the upstream side: an elicitation/create arrives while a relayed call is open ─────────────
  override async handleElicitation(server: string, params: ElicitationRequest): Promise<Answer> {
    const rec = this.active.get(server);
    const p = params as unknown as Record<string, unknown>;
    if (!rec || rec.finished || rec.abandoned) {
      throw rpcError(-32600, `refused: ${server} asked for input while no consumer call to it was waiting, so there is nobody to ask`);
    }
    if (!rec.begin.accepts(p)) {
      throw rpcError(-32600, `refused: the consumer of this call did not declare the elicitation capability for ${p.mode === "url" ? "url" : "form"} requests, so ${server}'s request cannot be relayed`);
    }
    const turn = rec.chain;
    let go!: () => void;
    rec.chain = new Promise<void>((r) => (go = r));
    await turn;
    try {
      if (rec.finished || rec.abandoned) return { action: "cancel" };
      return await this.askConsumer(rec, p);
    } finally {
      go();
    }
  }

  private askConsumer(rec: CallRec, params: Record<string, unknown>): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      const ask: RelayAsk = { state: uuid(), key: `elicitation-${++rec.seq}`, params };
      const timer = setTimeout(() => {
        if (rec.ask?.ask.state !== ask.state) return;
        this.clearAsk(rec);
        rec.begin.onExpire?.(ask);
        resolve({ action: "decline" });
      }, this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      rec.ask = { ask, resolve, timer };
      this.byState.set(ask.state, rec);
      this.deliver(rec, { kind: "ask", ...ask });
    });
  }

  // ── the consumer side ─────────────────────────────────────────────────────────────────────────
  /**
   * Start a relayed call. Waits its turn on this upstream (one call in flight each), runs `start`
   * (the real upstream call; it should go through the client so policy and audit apply), and
   * resolves with the first thing that happens: the call finishes, or the upstream asks the consumer something.
   */
  async begin<T>(b: RelayBegin, start: () => Promise<T>): Promise<RelayStep<T>> {
    if (this.count >= this.maxPending) throw rpcError(-32603, `refused: ${this.count} relayed calls are already pending (limit ${this.maxPending})`);
    this.count++;
    let release!: () => void;
    try {
      release = await this.acquire(b.server, b.signal);
    } catch (e) {
      this.count--;
      throw e;
    }
    const rec: CallRec = { id: uuid(), begin: b, finished: false, abandoned: false, seq: 0, chain: Promise.resolve(), release };
    this.active.set(b.server, rec);
    const first = this.attach<T>(rec, b.signal);
    start().then(
      (value) => this.finish(rec, { ok: true, step: { kind: "done", value } }),
      (error) => this.finish(rec, { ok: false, error }),
    );
    return first;
  }

  /** Check that `state` is a pending ask of this identity for this surface; throws the one generic error otherwise. Never consumes or touches it. */
  inspect(state: string, who: RelayIdentity, expect: RelayExpect): { args: Record<string, unknown>; key: string } {
    const rec = this.byState.get(state);
    const b = rec?.begin;
    if (!rec || !rec.ask || !b || rec.ask.ask.state !== state || b.who.principal !== who.principal || b.who.partition !== who.partition || b.server !== expect.server || b.surface !== expect.surface || b.target !== expect.target) {
      throw invalidRequestState();
    }
    return { args: b.args, key: rec.ask.ask.key };
  }

  /** Answer a pending ask (one use) and wait for what happens next. `answers` is the retry's `inputResponses`. */
  async resume<T>(state: string, who: RelayIdentity, expect: RelayExpect, answers: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<RelayStep<T>> {
    const { key } = this.inspect(state, who, expect);
    const rec = this.byState.get(state)!;
    const pending = rec.ask!;
    this.clearAsk(rec);
    // Attach before answering: the upstream's reply can only land after this synchronous stretch.
    const next = this.attach<T>(rec, signal);
    pending.resolve(toAnswer(answers?.[key]));
    return next;
  }

  /** Refuse a pending ask the consumer's retry must not be allowed to answer (the upstream is told the request was cancelled). Same checks as `inspect`. */
  cancel(state: string, who: RelayIdentity, expect: RelayExpect): void {
    this.inspect(state, who, expect);
    const rec = this.byState.get(state)!;
    const pending = rec.ask!;
    rec.abandoned = true;
    this.clearAsk(rec);
    pending.resolve({ action: "cancel" });
  }

  /** Pending asks (for tests and introspection). */
  get pendingAsks(): number {
    return this.byState.size;
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────
  private clearAsk(rec: CallRec): void {
    if (!rec.ask) return;
    clearTimeout(rec.ask.timer);
    this.byState.delete(rec.ask.ask.state);
    rec.ask = undefined;
  }

  private attach<T>(rec: CallRec, signal?: AbortSignal): Promise<RelayStep<T>> {
    return new Promise<RelayStep<T>>((resolve, reject) => {
      const onAbort = () => {
        // The consumer went away: nobody is waiting for an answer any more.
        rec.waiter = undefined;
        this.abandon(rec);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      rec.waiter = {
        resolve: (s) => resolve(s as RelayStep<T>),
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
    });
  }

  private deliver(rec: CallRec, step: RelayStep<unknown>): void {
    const w = rec.waiter;
    if (!w) {
      // Nobody is attached (consumer aborted): decline rather than leave the upstream hanging.
      this.abandon(rec);
      return;
    }
    rec.waiter = undefined;
    w.detach();
    w.resolve(step);
  }

  private finish(rec: CallRec, outcome: { ok: true; step: RelayStep<unknown> } | { ok: false; error: unknown }): void {
    if (rec.finished) return;
    rec.finished = true;
    if (rec.ask) {
      const pending = rec.ask;
      this.clearAsk(rec);
      pending.resolve({ action: "cancel" });
    }
    if (this.active.get(rec.begin.server) === rec) this.active.delete(rec.begin.server);
    this.count--;
    rec.release();
    const w = rec.waiter;
    rec.waiter = undefined;
    if (!w) return; // abandoned: the outcome has no reader
    w.detach();
    if (outcome.ok) w.resolve(outcome.step);
    else w.reject(outcome.error);
  }

  /** The consumer is gone: decline whatever the upstream is waiting on; the call runs out on its own. */
  private abandon(rec: CallRec): void {
    rec.abandoned = true;
    if (rec.ask) {
      const pending = rec.ask;
      this.clearAsk(rec);
      pending.resolve({ action: "cancel" });
    }
  }

  private acquire(server: string, signal?: AbortSignal): Promise<() => void> {
    const prev = this.tails.get(server) ?? Promise.resolve();
    let rel!: () => void;
    const mine = new Promise<void>((r) => (rel = r));
    const tail = prev.then(() => mine);
    this.tails.set(server, tail);
    void tail.then(() => {
      if (this.tails.get(server) === tail) this.tails.delete(server);
    });
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        // Give the slot back as soon as it is our turn.
        void prev.then(rel);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void prev.then(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(rel);
      });
    });
  }
}
