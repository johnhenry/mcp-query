// Audit screen — outcome-colored timeline + NDJSON export.

import { useAuditLog } from "mcp-query/react";
import { outcomeClass, outcomeLabel, toNDJSON } from "../audit.js";
import { clockTime } from "../time.js";

export function Audit() {
  const entries = useAuditLog();
  // Newest first.
  const ordered = [...entries].reverse();

  function exportNDJSON(): void {
    const blob = new Blob([toNDJSON(entries)], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.ndjson`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="audit">
      <div className="audit-head">
        <h2>Audit trail</h2>
        <button className="btn btn-ghost" onClick={exportNDJSON} disabled={entries.length === 0}>
          Export NDJSON
        </button>
      </div>

      {ordered.length === 0 ? (
        <div className="empty">
          <p>No decisions recorded yet.</p>
        </div>
      ) : (
        <ol className="timeline">
          {ordered.map((e) => (
            <li key={e.id} className={`tl-row tl-${outcomeClass(e.outcome)}`}>
              <span className="tl-dot" aria-hidden />
              <span className="tl-time">{clockTime(e.at)}</span>
              <span className={`tl-outcome out-${outcomeClass(e.outcome)}`}>{outcomeLabel(e.outcome)}</span>
              <span className="tl-type">{e.type}</span>
              <span className="tl-server">{e.server}</span>
              {e.reason && <span className="tl-reason">“{e.reason}”</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
