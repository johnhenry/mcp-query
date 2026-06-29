// Live activity log — newest-first, filterable. Reads from the ActivityStore via
// useSyncExternalStore so audit (onCall) + DevtoolsHub events both stream in.

import { useState, useSyncExternalStore } from "react";
import { filterRows, type ActivityFilter, type ActivityStore } from "../lib/activity.js";

const FILTERS: ActivityFilter[] = ["all", "ok", "error", "audit", "devtools"];

export function ActivityStream({ store }: { store: ActivityStore }) {
  const rows = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const shown = filterRows(rows, filter);

  return (
    <section className="activity">
      <header className="activity__head">
        <h2>Activity</h2>
        <div className="activity__filters">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`chip${filter === f ? " chip--on" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </header>
      {shown.length === 0 ? (
        <p className="muted activity__empty">no activity yet</p>
      ) : (
        <ol className="activity__log">
          {shown.map((r) => (
            <li key={r.id} className={`logrow logrow--${r.ok === false ? "err" : r.ok === true ? "ok" : "info"}`}>
              <time>{new Date(r.at).toLocaleTimeString()}</time>
              <span className="logrow__server">{r.server}</span>
              <span className="logrow__method">{r.method}</span>
              {r.ms !== undefined && <span className="logrow__ms">{r.ms}ms</span>}
              {r.ok === false && <span className="logrow__bad">✗</span>}
              {r.ok === true && <span className="logrow__good">✓</span>}
              {r.detail && <span className="logrow__detail">{r.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
