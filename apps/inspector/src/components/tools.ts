import { Reactive, esc } from "../lib/reactive.js";
import { isDestructive, isReadOnly } from "mcp-query";
import { client, hub, activeServer } from "../lib/store.js";
import { buildSchemaForm } from "../lib/schema-form.js";

export class Tools extends Reactive {
  private selected = "";

  connectedCallback(): void {
    this.track(activeServer.subscribe);
    this.track(hub.subscribe); // re-render on any protocol activity (incl. list_changed)
    super.connectedCallback();
  }

  protected update(): void {
    const server = activeServer.get();
    const tools = server ? client.listTools(server) : [];
    const tool = tools.find((t) => t.name === this.selected) ?? tools[0];

    this.innerHTML = `
      <div class="split">
        <ul class="picker" role="list" aria-label="tools">
          ${tools
            .map(
              (t) => `<li><button class="item ${t.name === tool?.name ? "sel" : ""}" data-name="${esc(t.name)}">
                ${esc(t.name)} ${isReadOnly(t) ? '<span class="hint ro">read-only</span>' : ""}${isDestructive(t) ? '<span class="hint danger">destructive</span>' : ""}
              </button></li>`,
            )
            .join("") || '<li class="muted">no tools (connect a server)</li>'}
        </ul>
        <div class="detail card" id="tool-detail"></div>
      </div>`;

    this.querySelectorAll<HTMLButtonElement>(".item").forEach((b) => (b.onclick = () => { this.selected = b.dataset.name!; this.update(); }));

    const detail = this.querySelector<HTMLDivElement>("#tool-detail")!;
    if (!tool || !server) return;
    detail.innerHTML = `<h3>${esc(tool.name)}</h3><p class="muted">${esc(tool.description ?? "")}</p>`;
    const form = buildSchemaForm(tool.inputSchema as never);
    const run = document.createElement("button");
    run.textContent = isDestructive(tool) ? "⚠ run (destructive)" : "run";
    const out = document.createElement("pre");
    out.className = "output";
    run.onclick = async () => {
      if (isDestructive(tool) && !confirm(`Run destructive tool "${tool.name}"?`)) return;
      run.disabled = true;
      try {
        const result = await client.callTool(`${server}.${tool.name}`, form.getValues());
        out.textContent = JSON.stringify(result, null, 2);
      } catch (err) {
        out.textContent = "Error: " + (err instanceof Error ? err.message : String(err));
      } finally {
        run.disabled = false;
      }
    };
    detail.append(form.element, run, out);
  }
}
customElements.define("mcp-tools", Tools);
