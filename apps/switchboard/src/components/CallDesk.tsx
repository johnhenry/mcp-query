// Capability browser + call runner. Everything goes through the GATE by default — the
// governed/direct toggle sends the same Context7 call to the ungoverned remote instead,
// so you can watch policy (deny/redact) make the difference.
import { useMemo, useState } from "react";
import { useMCPClient, useTools } from "@johnhenry/mcpq/react";
import { SchemaForm, ResultView, type JSONSchemaLike } from "@app-shared";
import { isReadOnly, type Tool } from "@johnhenry/mcpq";
import type { Tenant } from "../tenants.js";

export function CallDesk({ tenant }: { tenant: Tenant }) {
  const client = useMCPClient();
  const { tools } = useTools({ server: "gate" });
  const [selected, setSelected] = useState<string | null>(null);
  const [governed, setGoverned] = useState(true);
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tool: Tool | undefined = tools.find((t) => t.name === selected);
  // The gate namespaces upstream tools as `upstream.tool`; the direct connection exposes
  // the bare Context7 names — so only context7.* tools can be compared side by side.
  const directName = selected?.startsWith("context7.") ? selected.slice("context7.".length) : null;

  const scoped = useMemo(() => client.scope({ partition: tenant.id, meta: { tenant: tenant.id, principal: tenant.user } }), [client, tenant]);

  async function run(args: Record<string, unknown>) {
    if (!tool) return;
    setBusy(true);
    setError(null);
    setResult(undefined);
    try {
      const viaDirect = !governed && directName;
      const out = viaDirect
        ? await scoped.callTool(directName, args, { server: "context7-direct" })
        : await scoped.callTool(tool.name, args, { server: "gate" });
      setResult(out);
    } catch (e) {
      setError((e as { message?: string })?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel desk">
      <h2>Call desk</h2>
      <div className="desk-grid">
        <ul className="tool-list">
          {tools.map((t) => (
            <li key={t.name}>
              <button className={selected === t.name ? "active" : ""} onClick={() => setSelected(t.name)}>
                <code>{t.name}</code>
                {isReadOnly(t) && <span className="badge tiny">read-only</span>}
              </button>
            </li>
          ))}
          {tools.length === 0 && <li className="muted">waiting for the gate's catalog…</li>}
        </ul>
        <div className="tool-detail">
          {tool ? (
            <>
              <h3>
                <code>{tool.name}</code>
              </h3>
              <p className="muted">{tool.description}</p>
              {directName && (
                <label className="toggle">
                  <input type="checkbox" checked={governed} onChange={(e) => setGoverned(e.target.checked)} />
                  via gate (uncheck to call <code>context7-direct</code> ungoverned)
                </label>
              )}
              <SchemaForm
                key={tool.name}
                schema={tool.inputSchema as JSONSchemaLike}
                onSubmit={(v) => void run(v)}
                submitLabel={busy ? "running…" : governed || !directName ? "Run via gate" : "Run direct"}
              />
              {error && <p className="error">✗ {error}</p>}
              {result !== undefined && <ResultView value={(result as { content?: unknown[] })?.content ?? result} />}
            </>
          ) : (
            <p className="muted">Pick a tool. Note what's missing: the gate hides denied tools (no get-env).</p>
          )}
        </div>
      </div>
    </section>
  );
}
