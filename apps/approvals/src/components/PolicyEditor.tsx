// Policy editor — compose broker policy verdicts (allow / deny / ask) per
// interaction type and/or server. Persists to localStorage and applies live.

import { useState } from "react";
import { setPolicyConfig, EVERYTHING_SERVER } from "../broker.js";
import { evaluatePolicy, savePolicy, type PolicyConfig, type PolicyRule, type PolicyVerdict } from "../policy.js";

const TYPES = ["*", "sampling", "elicitation", "confirm"] as const;
const VERDICTS: PolicyVerdict[] = ["ask", "allow", "deny"];

let ruleSeq = 0;
function newRule(): PolicyRule {
  return { id: `r${Date.now()}-${ruleSeq++}`, type: "*", server: "*", verdict: "ask" };
}

interface Props {
  config: PolicyConfig;
  onChange: (config: PolicyConfig) => void;
}

export function PolicyEditor({ config, onChange }: Props) {
  const [draft, setDraft] = useState<PolicyConfig>(config);
  const [saved, setSaved] = useState(false);

  function update(next: PolicyConfig): void {
    setDraft(next);
    setSaved(false);
  }

  function apply(): void {
    setPolicyConfig(draft);
    savePolicy(draft);
    onChange(draft);
    setSaved(true);
  }

  return (
    <section className="policy">
      <div className="policy-head">
        <div>
          <h2>Policy</h2>
          <p className="hint">
            Rules are evaluated top-down; the first match wins. <b>allow</b> auto-approves,{" "}
            <b>deny</b> auto-rejects, <b>ask</b> queues for human review.
          </p>
        </div>
        <button className="btn btn-approve" onClick={apply}>
          {saved ? "Applied ✓" : "Apply & save"}
        </button>
      </div>

      <table className="rules">
        <thead>
          <tr>
            <th>Type</th>
            <th>Server</th>
            <th>Verdict</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.rules.map((rule, i) => (
            <tr key={rule.id}>
              <td>
                <select
                  value={rule.type}
                  onChange={(e) =>
                    update({
                      ...draft,
                      rules: draft.rules.map((r, j) =>
                        j === i ? { ...r, type: e.target.value as PolicyRule["type"] } : r,
                      ),
                    })
                  }
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  list="servers"
                  value={rule.server}
                  onChange={(e) =>
                    update({
                      ...draft,
                      rules: draft.rules.map((r, j) => (j === i ? { ...r, server: e.target.value } : r)),
                    })
                  }
                />
              </td>
              <td>
                <select
                  className={`verdict verdict-${rule.verdict}`}
                  value={rule.verdict}
                  onChange={(e) =>
                    update({
                      ...draft,
                      rules: draft.rules.map((r, j) =>
                        j === i ? { ...r, verdict: e.target.value as PolicyVerdict } : r,
                      ),
                    })
                  }
                >
                  {VERDICTS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => update({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}
                  aria-label="Remove rule"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {draft.rules.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No rules — everything falls through to the default below.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <datalist id="servers">
        <option value="*" />
        <option value={EVERYTHING_SERVER} />
      </datalist>

      <div className="policy-actions">
        <button className="btn btn-ghost" onClick={() => update({ ...draft, rules: [...draft.rules, newRule()] })}>
          + Add rule
        </button>
        <label className="fallback">
          Default (no match):
          <select
            className={`verdict verdict-${draft.fallback}`}
            value={draft.fallback}
            onChange={(e) => update({ ...draft, fallback: e.target.value as PolicyVerdict })}
          >
            {VERDICTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <PolicyPreview config={draft} />
    </section>
  );
}

function PolicyPreview({ config }: { config: PolicyConfig }) {
  const samples: { type: "sampling" | "elicitation" | "confirm"; server: string }[] = [
    { type: "sampling", server: EVERYTHING_SERVER },
    { type: "elicitation", server: EVERYTHING_SERVER },
    { type: "confirm", server: EVERYTHING_SERVER },
  ];
  return (
    <div className="preview">
      <h3>Live preview</h3>
      <ul>
        {samples.map((s) => {
          const verdict = evaluatePolicy(config, { ...s, payload: {} });
          return (
            <li key={`${s.type}-${s.server}`}>
              <code>
                {s.type} @ {s.server}
              </code>{" "}
              → <span className={`verdict-tag verdict-${verdict}`}>{verdict}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
