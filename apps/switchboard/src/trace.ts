// The interceptor seam, made visible. traceInterceptor times every operation through the
// chain and publishes it to a tiny event bus the TraceWaterfall renders; the tenant-meta
// interceptor stamps the active tenant onto every call's context so the server (and the
// gate's audit line) can see the principal.
import type { RequestInterceptor } from "mcp-query";

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
}

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
        server: op.server,
        target: op.target,
        tenant: (op.context?.meta as { tenant?: string } | undefined)?.tenant,
        ms: performance.now() - t0,
        outcome: "ok",
      });
      return out;
    } catch (e) {
      const err = e as { code?: number; message?: string };
      traceBus.push({
        at: Date.now(),
        kind: op.kind,
        server: op.server,
        target: op.target,
        tenant: (op.context?.meta as { tenant?: string } | undefined)?.tenant,
        ms: performance.now() - t0,
        outcome: err?.code === -32003 ? "denied" : "error",
        error: err?.message ?? String(e),
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
