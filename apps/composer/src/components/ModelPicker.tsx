// Header control: choose a provider, a model, and the provider's config (apiKey/baseURL).
// All state lives in localStorage (no server). Ollama-local is the zero-config default.

import { useState } from "react";
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
              {(provider.defaultModels ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

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
