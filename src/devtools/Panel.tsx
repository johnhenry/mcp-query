// Devtools panel — the React Query / Apollo devtools analog, MCP-flavored. Three
// panes: (1) per-server lifecycle + negotiated capabilities, (2) the live capability
// registry (tools/resources/prompts, with hints), (3) the cache: entries, their tags,
// staleness, subscriber count, and a live event log. This is a layout skeleton, not
// styled production UI.

import { useCallback, useSyncExternalStore } from "react";
import { useMCPClient } from "../react/provider.js";
import type { DevtoolsHub } from "./protocol.js";

export function MCPDevtools({ hub }: { hub: DevtoolsHub }) {
  const client = useMCPClient();
  const events = useSyncExternalStore(
    useCallback((cb) => hub.subscribe(cb), [hub]),
    () => hub.events(),
    () => hub.events(),
  );

  return (
    <div className="mcpq-devtools" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: 12 }}>
      {/* ── Pane 1: servers ───────────────────────────────────────────── */}
      <section>
        <h3>Servers</h3>
        {client.connections().map((c) => (
          <div key={c.name} data-state={c.state}>
            <strong>{c.name}</strong> <code>{c.state}</code>
            <ul>
              <li>tools: {c.supports("tools") ? "✓" : "—"}</li>
              <li>resources: {c.supports("resources") ? "✓" : "—"}</li>
              <li>subscribe: {c.supports("resources.subscribe") ? "✓" : "—"}</li>
              <li>prompts: {c.supports("prompts") ? "✓" : "—"}</li>
            </ul>
          </div>
        ))}
      </section>

      {/* ── Pane 2: live capability registry ──────────────────────────── */}
      <section>
        <h3>Capabilities</h3>
        {client.connections().map((c) => (
          <details key={c.name} open>
            <summary>{c.name}</summary>
            {[...c.tools.values()].map((t) => (
              <div key={t.name}>
                <code>{t.name}</code>{" "}
                {t.annotations?.readOnlyHint && <span title="readOnlyHint">🔒ro</span>}
                {t.annotations?.destructiveHint && <span title="destructiveHint">⚠️destructive</span>}
                {t.annotations?.idempotentHint && <span title="idempotentHint">♻️idem</span>}
              </div>
            ))}
          </details>
        ))}
      </section>

      {/* ── Pane 3: cache + event log ─────────────────────────────────── */}
      <section>
        <h3>Cache</h3>
        <table>
          <thead>
            <tr>
              <th>key</th>
              <th>status</th>
              <th>stale</th>
              <th>subs</th>
              <th>sub?</th>
              <th>tags</th>
            </tr>
          </thead>
          <tbody>
            {client.cache.entriesForDevtools().map((e) => (
              <tr key={e.key} style={{ opacity: e.isStale ? 0.5 : 1 }}>
                <td title={e.key}>{e.key.slice(0, 40)}</td>
                <td>{e.status}</td>
                <td>{e.isStale ? "stale" : "fresh"}</td>
                <td>{e.subscribers}</td>
                <td>{e.protocolSubscribed ? "live" : ""}</td>
                <td>{[...e.tags].join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Messages & events</h3>
        <ol reversed>
          {events.slice(-150).reverse().map((ev, i) => (
            <li key={i}>
              {(ev.type === "request" || ev.type === "notification" || ev.type === "response") && (
                <span title={ev.type}>{ev.dir === "out" ? "→" : "←"} </span>
              )}
              <code>{ev.type}</code> {"server" in ev ? ev.server : ""}{" "}
              {ev.type === "request" ? `${ev.method} #${ev.id}` : ""}
              {ev.type === "notification" ? ev.method : ""}
              {ev.type === "response" ? `#${ev.id} ${ev.ok ? "ok" : "err"} ${ev.ms}ms` : ""}
              {ev.type === "invalidate" ? ev.keys.length + " keys" : ""}
              {ev.type === "log" ? `${ev.level}: ${JSON.stringify(ev.data)}` : ""}
              {ev.type === "host-call" ? ev.kind : ""}
            </li>
          ))}
        </ol>
      </section>

      {/* ── Pane 4: human-in-the-loop (broker) ────────────────────────── */}
      <InteractionsPane />
    </div>
  );
}

/** Pending approval queue + audit trail from the InteractionBroker, if configured. */
function InteractionsPane() {
  const client = useMCPClient();
  const broker = client.interactions;
  useSyncExternalStore(
    useCallback((cb) => (broker ? broker.subscribe(cb) : () => {}), [broker]),
    () => broker?.getVersion() ?? 0,
    () => 0,
  );
  if (!broker) return null;
  return (
    <section>
      <h3>Pending interactions</h3>
      {broker.list().length === 0 && <em>none</em>}
      {broker.list().map((i) => (
        <div key={i.id}>
          <strong>{i.server}</strong> <code>{i.type}</code> ({i.phase}){i.manual ? " ✍️ author a response" : ""}
          {i.manual ? (
            <button
              onClick={() =>
                broker.resolve(i.id, {
                  action: "approve",
                  editedResult: {
                    role: "assistant",
                    content: { type: "text", text: prompt("Sampling response:") ?? "" },
                    model: "human",
                    stopReason: "endTurn",
                  },
                })
              }
            >
              send
            </button>
          ) : (
            <button onClick={() => broker.resolve(i.id, { action: "approve" })}>approve</button>
          )}
          <button onClick={() => broker.resolve(i.id, { action: "deny" })}>deny</button>
        </div>
      ))}
      <h3>Audit</h3>
      <ol reversed>
        {broker.auditLog().slice(-50).reverse().map((e) => (
          <li key={e.id}>
            <strong>{e.server}</strong> <code>{e.type}</code> → {e.outcome}
            {e.reason ? ` (${e.reason})` : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}
