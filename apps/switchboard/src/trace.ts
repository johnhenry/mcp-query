// The interceptor seam, made visible. traceInterceptor times every operation through the
// chain and publishes it to a tiny event bus the TraceWaterfall renders; the tenant-meta
// interceptor stamps the active tenant onto every call's context so the server (and the
// gate's audit line) can see the principal.
import type { RequestInterceptor } from "@johnhenry/mcp-query";

export interface TraceRow {
  id: number;
  at: number;
  kind: string;
  server: string;
  target: string;
  tenant?: string;
  ms: number;
  outcome: "ok" | "denied" | "error";
  error?: string;
  /** A forwarded interaction round this operation was one hop of (see {@link hopOf}). */
  hop?: TraceHop;
  /** The verified routing facts the gate recorded for the call (`Mcp-Method` / `Mcp-Name`), when the caller set them. */
  routing?: { method: string; name?: string };
}

/**
 * One hop of a forwarded interaction (`interactions: "forward"` on the gate): `ask` is a call that
 * came back `input_required` (the upstream asked a question; `methods` / `urlHosts` say what), `answer`
 * is the retry that carried the consumer's `inputResponses` / `requestState` back to the same upstream.
 * Same data as `CallAuditEntry.interaction`, read from the operation and its result.
 */
export interface TraceHop {
  phase: "ask" | "answer";
  methods: string[];
  urlHosts: string[];
}

type Request = { method?: unknown; params?: { mode?: unknown; url?: unknown } };

/** The interaction hop an operation was, or undefined when it was an ordinary call. */
export function hopOf(op: { interaction?: { inputResponses?: unknown; requestState?: unknown } }, result: unknown): TraceHop | undefined {
  const r = result as { resultType?: unknown; inputRequests?: Record<string, Request> } | null;
  if (r && typeof r === "object" && r.resultType === "input_required") {
    const reqs = Object.values(r.inputRequests ?? {});
    const urlHosts = reqs.flatMap((q) => {
      if (q.params?.mode !== "url" || typeof q.params.url !== "string") return [];
      try {
        return [new URL(q.params.url).hostname];
      } catch {
        return ["(unparseable)"];
      }
    });
    return { phase: "ask", methods: reqs.map((q) => String(q.method)), urlHosts };
  }
  if (op.interaction && (op.interaction.inputResponses !== undefined || op.interaction.requestState !== undefined)) return { phase: "answer", methods: [], urlHosts: [] };
  return undefined;
}

const routingOf = (op: { context?: unknown }): TraceRow["routing"] => {
  const r = (op.context as { routing?: { method?: unknown; name?: unknown } } | undefined)?.routing;
  return r && typeof r.method === "string" ? { method: r.method, ...(typeof r.name === "string" ? { name: r.name } : {}) } : undefined;
};

type Listener = () => void;

class TraceBus {
  rows: TraceRow[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;
  private version = 0;

  push(row: Omit<TraceRow, "id">): void {
    this.rows = [{ ...row, id: this.nextId++ }, ...this.rows].slice(0, 200);
    this.version++;
    for (const l of this.listeners) l();
  }
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = (): number => this.version;
}

export const traceBus = new TraceBus();

export function traceInterceptor(): RequestInterceptor {
  return async (op, next) => {
    const t0 = performance.now();
    try {
      const out = await next(op);
      traceBus.push({
        at: Date.now(),
        kind: op.kind,
        server: op.peer,
        target: op.target,
        tenant: (op.context?.meta as { tenant?: string } | undefined)?.tenant,
        ms: performance.now() - t0,
        outcome: "ok",
        hop: hopOf(op, out),
        routing: routingOf(op),
      });
      return out;
    } catch (e) {
      const err = e as { code?: number; message?: string };
      traceBus.push({
        at: Date.now(),
        kind: op.kind,
        server: op.peer,
        target: op.target,
        tenant: (op.context?.meta as { tenant?: string } | undefined)?.tenant,
        ms: performance.now() - t0,
        outcome: err?.code === -32003 ? "denied" : "error",
        error: err?.message ?? String(e),
        hop: hopOf(op, undefined),
        routing: routingOf(op),
      });
      throw e;
    }
  };
}

/** Holder the TenantSwitcher writes; the interceptor stamps it on every op's context. */
export const activeTenant = { id: "acme", user: "amber@acme.test" };

export function tenantMetaInterceptor(): RequestInterceptor {
  return (op, next) => {
    op.context = {
      partition: op.context?.partition ?? activeTenant.id,
      ...op.context,
      meta: { tenant: activeTenant.id, principal: activeTenant.user, ...op.context?.meta },
    };
    return next(op);
  };
}
