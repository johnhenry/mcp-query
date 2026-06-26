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

        <h3>Events</h3>
        <ol reversed>
          {events.slice(-100).reverse().map((ev, i) => (
            <li key={i}>
              <code>{ev.type}</code> {"server" in ev ? ev.server : ""}{" "}
              {ev.type === "invalidate" ? ev.keys.length + " keys" : ""}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
