import { Reactive, esc } from "../lib/reactive.js";
import { client } from "../lib/store.js";

// Cache inspector — mcp-query's reactive cache laid bare: every entry with its status,
// staleness, tags, and observer/subscription counts.

export class CacheView extends Reactive {
  connectedCallback(): void {
    this.track((cb) => client.cache.subscribeAll(cb));
    super.connectedCallback();
  }

  protected update(): void {
    const entries = client.cache.entriesForDevtools();
    this.innerHTML = `
      <div class="card">
        <table class="cache-table">
          <thead><tr><th>key</th><th>status</th><th>fresh</th><th>subs</th><th>live</th><th>tags</th></tr></thead>
          <tbody>
            ${entries.length ? entries.map((e) => `<tr style="opacity:${e.isStale ? 0.55 : 1}">
              <td title="${esc(e.key)}"><code>${esc(e.key.slice(0, 48))}</code></td>
              <td>${esc(e.status)}</td>
              <td>${e.isStale ? "stale" : "fresh"}</td>
              <td>${e.subscribers}</td>
              <td>${e.protocolSubscribed ? "✓" : ""}</td>
              <td class="muted">${esc([...e.tags].join(", "))}</td>
            </tr>`).join("") : '<tr><td colspan="6" class="muted">cache is empty</td></tr>'}
          </tbody>
        </table>
      </div>`;
  }
}
customElements.define("mcp-cache", CacheView);
