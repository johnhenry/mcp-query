// Proof of tenant isolation: the cache dehydrated and grouped by partition. The same
// tool + args called by two tenants appear as two distinct entries; nothing is shared.
import { useSyncExternalStore } from "react";
import { useMCPClient } from "@johnhenry/mcp-query/react";
import { TENANTS } from "../tenants.js";

export function PartitionInspector() {
  const client = useMCPClient();
  useSyncExternalStore(
    (cb) => client.cache.subscribeAll(cb),
    () => client.cache.entriesForDevtools().length + client.cache.entriesForDevtools().reduce((n, e) => n + e.version, 0),
    () => 0,
  );

  const entries = client.cache.dehydrate().entries;
  const byPartition = new Map<string, number>();
  for (const e of entries) {
    const p = (e.cacheKey as { partition?: string }).partition ?? "(shared)";
    byPartition.set(p, (byPartition.get(p) ?? 0) + 1);
  }

  return (
    <section className="panel">
      <h2>Cache partitions</h2>
      <table className="partition-table">
        <tbody>
          {[...byPartition.entries()].map(([p, count]) => {
            const tenant = TENANTS.find((t) => t.id === p);
            return (
              <tr key={p}>
                <td>
                  <span className="dot" style={{ background: tenant?.color ?? "var(--muted)" }} /> {tenant?.label ?? p}
                </td>
                <td className="num">{count} entr{count === 1 ? "y" : "ies"}</td>
              </tr>
            );
          })}
          {byPartition.size === 0 && (
            <tr>
              <td className="muted">cache is empty</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small">
        Same call, different tenant → different partition. No cross-tenant reads, ever.
      </p>
    </section>
  );
}
