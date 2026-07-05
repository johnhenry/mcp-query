// Load + failure, on demand: hammer the gate with 25 parallel calls and watch the
// browser-side rateLimit(concurrency: 4) queue them in the waterfall. The gate has its
// own concurrency cap and a circuit breaker per upstream — kill the spawned
// server-everything process and calls fast-fail until its cooldown ends.
import { useState } from "react";
import { useMCPClient } from "@johnhenry/mcpq/react";
import type { Tenant } from "../tenants.js";

export function ChaosPanel({ tenant }: { tenant: Tenant }) {
  const client = useMCPClient();
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  async function hammer() {
    setRunning(true);
    setSummary(null);
    const scoped = client.scope({ partition: tenant.id, meta: { tenant: tenant.id } });
    const t0 = performance.now();
    const settled = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        scoped.callTool("everything.get-sum", { a: i, b: i }, { server: "gate" }),
      ),
    );
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    setSummary(`${ok}/25 ok in ${(performance.now() - t0).toFixed(0)}ms (watch the queueing in the trace)`);
    setRunning(false);
  }

  return (
    <section className="panel">
      <h2>Chaos</h2>
      <button className="primary" disabled={running} onClick={() => void hammer()}>
        {running ? "hammering…" : "⚒ 25 parallel calls"}
      </button>
      {summary && <p className="muted small">{summary}</p>}
      <p className="muted small">
        The browser chain caps concurrency at 4; the gate adds its own rate limit + a circuit
        breaker per upstream (kill the spawned server-everything to see it open).
      </p>
    </section>
  );
}
