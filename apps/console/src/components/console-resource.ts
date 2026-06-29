// Open a resource and render its contents. A "live" toggle subscribes (readResource
// {subscribe:true}); when the server emits resources/updated the cache entry changes and
// the panel re-reads automatically.

import { Reactive, esc } from "@app-shared/reactive";
import { client, activeServer } from "../lib/store.js";
import { renderResourceContents } from "../lib/render.js";

export class ConsoleResource extends Reactive {
  static get observedAttributes(): string[] { return ["uri"]; }
  private live = false;
  private cleanupLive: (() => void) | null = null;

  attributeChangedCallback(): void {
    this.live = false;
    this.cleanupLive?.();
    this.cleanupLive = null;
    if (this.isConnected) this.update();
  }

  disconnectedCallback(): void {
    this.cleanupLive?.();
    this.cleanupLive = null;
    super.disconnectedCallback();
  }

  protected update(): void {
    const server = activeServer.get();
    const uri = this.getAttribute("uri") ?? "";
    const res = server ? client.listResources(server).find((r) => r.uri === uri) : undefined;

    if (!server) { this.innerHTML = `<div class="placeholder">Connect a server to begin.</div>`; return; }
    if (!res) { this.innerHTML = `<div class="placeholder">Select a resource from the left.</div>`; return; }

    this.innerHTML = `
      <header class="detail-head">
        <h2>${esc(res.name ?? res.uri)}</h2>
        <p class="muted">${esc(res.uri)}${res.mimeType ? ` · ${esc(res.mimeType)}` : ""}</p>
        <label class="inline live-toggle">
          <input type="checkbox" ${this.live ? "checked" : ""} /> live (subscribe to updates)
        </label>
      </header>
      <div class="result-slot" aria-live="polite"><div class="spinner">loading…</div></div>`;

    const slot = this.querySelector<HTMLElement>(".result-slot")!;
    const toggle = this.querySelector<HTMLInputElement>(".live-toggle input")!;

    const read = async () => {
      try {
        const data = await client.readResource(res.uri, { server, subscribe: this.live });
        slot.innerHTML = renderResourceContents(data);
      } catch (err) {
        slot.innerHTML = `<div class="result-error" role="alert">${esc(err instanceof Error ? err.message : String(err))}</div>`;
      }
    };

    toggle.onchange = () => {
      this.live = toggle.checked;
      this.cleanupLive?.();
      this.cleanupLive = null;
      if (this.live) {
        // Re-read whenever this resource's cache entry changes (driven by resources/updated).
        const key = { kind: "resource", server, uri: res.uri } as const;
        this.cleanupLive = client.cache.subscribe(key, () => void read());
      }
      void read();
    };

    void read();
  }
}
customElements.define("console-resource", ConsoleResource);
