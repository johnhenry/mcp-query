import { TENANTS, type Tenant } from "../tenants.js";

export function TenantSwitcher({ active, onPick }: { active: Tenant; onPick: (t: Tenant) => void }) {
  return (
    <section className="panel">
      <h2>Tenant</h2>
      <div className="tenant-list">
        {TENANTS.map((t) => (
          <button
            key={t.id}
            className={active.id === t.id ? "tenant active" : "tenant"}
            style={{ borderLeftColor: t.color }}
            onClick={() => onPick(t)}
          >
            <b>{t.label}</b>
            <span className="muted">{t.user}</span>
          </button>
        ))}
      </div>
      <p className="muted small">
        Every call is stamped with the tenant (<code>_meta</code>) and cached in its own partition —
        switch tenants and watch the partition inspector.
      </p>
    </section>
  );
}
