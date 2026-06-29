// Header control: choose a provider, a model, and the provider's config (apiKey/baseURL).
// All state lives in localStorage (no server). Ollama-local is the zero-config default.

import { useEffect, useState } from "react";
import {
  PROVIDERS,
  getProvider,
  type ProviderConfig,
} from "../model.js";

export function ModelPicker({
  config,
  onChange,
}: {
  config: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const provider = getProvider(config.providerId);
  const saved = config.byProvider[provider.id] ?? {};
  const model = saved.model || provider.defaultModel || "";
  const baseURL = saved.baseURL ?? provider.defaultBaseURL ?? "";

  // For Ollama, list the models actually installed locally (GET <baseURL>/api/tags) so the
  // picker reflects reality — the hardcoded defaults are just suggestions and may not be pulled.
  const [installed, setInstalled] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open || provider.id !== "ollama") return;
    let cancelled = false;
    setInstalled(null);
    fetch(`${baseURL.replace(/\/$/, "")}/api/tags`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { models?: Array<{ name?: string }> }) => {
        if (!cancelled) setInstalled((d.models ?? []).map((m) => m.name ?? "").filter(Boolean));
      })
      .catch(() => {
        if (!cancelled) setInstalled([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, provider.id, baseURL]);

  const isOllama = provider.id === "ollama";
  const suggestions = isOllama && installed && installed.length ? installed : provider.defaultModels ?? [];
  const notInstalled = isOllama && installed !== null && model !== "" && !installed.includes(model);

  function patchProvider(patch: { apiKey?: string; baseURL?: string; model?: string }) {
    onChange({
      ...config,
      byProvider: {
        ...config.byProvider,
        [provider.id]: { ...saved, ...patch },
      },
    });
  }

  return (
    <div className="model-picker">
      <button className="model-pill" onClick={() => setOpen((o) => !o)} title="Model settings">
        <span className="dot" /> {provider.label} · {model || "no model"} {open ? "▾" : "▸"}
      </button>

      {open && (
        <div className="model-panel">
          <label className="field">
            <span>Provider</span>
            <select
              value={provider.id}
              onChange={(e) => onChange({ ...config, providerId: e.target.value })}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Model</span>
            <input
              list={`models-${provider.id}`}
              value={model}
              placeholder={provider.defaultModel}
              onChange={(e) => patchProvider({ model: e.target.value })}
            />
            <datalist id={`models-${provider.id}`}>
              {suggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {isOllama && installed !== null && (
            installed.length === 0 ? (
              <p className="muted small">No local Ollama models found — pull one (e.g. <code>ollama pull {provider.defaultModel}</code>) or check the base URL.</p>
            ) : notInstalled ? (
              <p className="model-warn small">
                ⚠ <b>{model}</b> isn't installed. Pick an installed model{" "}
                ({installed.slice(0, 4).join(", ")}{installed.length > 4 ? "…" : ""}) or run <code>ollama pull {model}</code>.
              </p>
            ) : (
              <p className="muted small">{installed.length} local model{installed.length === 1 ? "" : "s"} available.</p>
            )
          )}

          {provider.configFields.includes("baseURL") && (
            <label className="field">
              <span>Base URL</span>
              <input
                value={saved.baseURL ?? provider.defaultBaseURL ?? ""}
                placeholder={provider.defaultBaseURL}
                onChange={(e) => patchProvider({ baseURL: e.target.value })}
              />
            </label>
          )}

          {provider.configFields.includes("apiKey") && (
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                value={saved.apiKey ?? ""}
                placeholder="sk-…"
                onChange={(e) => patchProvider({ apiKey: e.target.value })}
              />
            </label>
          )}

          {provider.hosted && (
            <p className="muted small">
              Hosted provider — the key is stored in your browser only. Direct browser calls
              may be blocked by CORS; Ollama-local is the zero-config default.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
