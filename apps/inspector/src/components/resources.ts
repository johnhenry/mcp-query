import { Reactive, esc } from "../lib/reactive.js";
import { client, hub, activeServer } from "../lib/store.js";

export class Resources extends Reactive {
  private selected = "";

  connectedCallback(): void {
    this.track(activeServer.subscribe);
    this.track(hub.subscribe);
    super.connectedCallback();
  }

  protected update(): void {
    const server = activeServer.get();
    const resources = server ? client.listResources(server) : [];
    const templates = server ? client.listResourceTemplates(server) : [];
    const res = resources.find((r) => r.uri === this.selected) ?? resources[0];

    this.innerHTML = `
      <div class="split">
        <div class="picker">
          <ul role="list" aria-label="resources">
            ${resources.map((r) => `<li><button class="item ${r.uri === res?.uri ? "sel" : ""}" data-uri="${esc(r.uri)}">${esc(r.name ?? r.uri)}</button></li>`).join("") || '<li class="muted">no resources</li>'}
          </ul>
          ${templates.length ? `<h4>templates</h4><ul role="list">${templates.map((t) => `<li class="muted" title="${esc(t.uriTemplate)}">${esc(t.name)}: ${esc(t.uriTemplate)}</li>`).join("")}</ul>` : ""}
        </div>
        <div class="detail card" id="res-detail"></div>
      </div>`;

    this.querySelectorAll<HTMLButtonElement>(".item").forEach((b) => (b.onclick = () => { this.selected = b.dataset.uri!; this.update(); }));

    const detail = this.querySelector<HTMLDivElement>("#res-detail")!;
    if (!res || !server) return;
    detail.innerHTML = `<h3>${esc(res.name ?? res.uri)}</h3><p class="muted">${esc(res.uri)} ${res.mimeType ? `· ${esc(res.mimeType)}` : ""}</p>`;
    const out = document.createElement("pre");
    out.className = "output";
    out.textContent = "loading…";
    detail.append(out);
    // Live subscription: re-read whenever the cache entry for this URI changes.
    const key = { kind: "resource", server, uri: res.uri } as const;
    const refresh = async () => {
      try {
        const data = (await client.readResource(res.uri, { server, subscribe: true })) as { contents?: { text?: string }[] };
        out.textContent = data.contents?.map((c) => c.text ?? JSON.stringify(c)).join("\n") ?? JSON.stringify(data, null, 2);
      } catch (err) {
        out.textContent = "Error: " + (err instanceof Error ? err.message : String(err));
      }
    };
    this.track((cb) => client.cache.subscribe(key, cb));
    void refresh();
  }
}
customElements.define("mcp-resources", Resources);
