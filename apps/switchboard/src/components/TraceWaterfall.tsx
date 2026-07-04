// Live view of the browser-side interceptor chain: every read/call/query, its tenant,
// timing, and outcome (ok / denied / error) — the seam auth, tracing, and rate limiting
// hang on, made visible.
import { useSyncExternalStore } from "react";
import { traceBus } from "../trace.js";
import { TENANTS } from "../tenants.js";

export function TraceWaterfall() {
  useSyncExternalStore(traceBus.subscribe, traceBus.getVersion, traceBus.getVersion);
  const rows = traceBus.rows;
  const max = Math.max(50, ...rows.map((r) => r.ms));

  return (
    <section className="panel waterfall">
      <h2>Trace</h2>
      <p className="muted small">every operation through the interceptor chain</p>
      <div className="trace-rows">
        {rows.length === 0 && <p className="muted">no operations yet — run a tool.</p>}
        {rows.map((r) => {
          const tenant = TENANTS.find((t) => t.id === r.tenant);
          return (
            <div key={r.id} className={`trace-row outcome-${r.outcome}`} title={r.error}>
              <span className="dot" style={{ background: tenant?.color ?? "var(--muted)" }} />
              <code className="target">
                {r.server}:{r.target}
              </code>
              <span className="bar-wrap">
                <span className="bar" style={{ width: `${Math.max(2, (r.ms / max) * 100)}%` }} />
              </span>
              <span className="ms">{r.ms.toFixed(0)}ms</span>
              <span className={`badge tiny outcome-${r.outcome}`}>{r.outcome}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
