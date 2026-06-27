import { Reactive, esc } from "../lib/reactive.js";
import { client, hub, activeServer } from "../lib/store.js";

export class Prompts extends Reactive {
  private selected = "";

  connectedCallback(): void {
    this.track(activeServer.subscribe);
    this.track(hub.subscribe);
    super.connectedCallback();
  }

  protected update(): void {
    const server = activeServer.get();
    const prompts = server ? client.listPrompts(server) : [];
    const prompt = prompts.find((p) => p.name === this.selected) ?? prompts[0];

    this.innerHTML = `
      <div class="split">
        <ul class="picker" role="list" aria-label="prompts">
          ${prompts.map((p) => `<li><button class="item ${p.name === prompt?.name ? "sel" : ""}" data-name="${esc(p.name)}">${esc(p.name)}</button></li>`).join("") || '<li class="muted">no prompts</li>'}
        </ul>
        <div class="detail card" id="prompt-detail"></div>
      </div>`;

    this.querySelectorAll<HTMLButtonElement>(".item").forEach((b) => (b.onclick = () => { this.selected = b.dataset.name!; this.update(); }));

    const detail = this.querySelector<HTMLDivElement>("#prompt-detail")!;
    if (!prompt || !server) return;
    detail.innerHTML = `<h3>${esc(prompt.name)}</h3><p class="muted">${esc(prompt.description ?? "")}</p>`;

    const args = (prompt as { arguments?: Array<{ name: string; required?: boolean; description?: string }> }).arguments ?? [];
    const inputs = new Map<string, HTMLInputElement>();
    for (const a of args) {
      const label = document.createElement("label");
      label.className = "field";
      label.innerHTML = `<span>${esc(a.name)}${a.required ? " *" : ""}</span>`;
      const input = document.createElement("input");
      input.type = "text";
      if (a.description) input.title = a.description;
      inputs.set(a.name, input);
      label.append(input);
      detail.append(label);
    }
    const run = document.createElement("button");
    run.textContent = "get prompt";
    const out = document.createElement("pre");
    out.className = "output";
    run.onclick = async () => {
      const vars = Object.fromEntries([...inputs].map(([k, el]) => [k, el.value]));
      try {
        out.textContent = JSON.stringify(await client.getPrompt(prompt.name, vars, server), null, 2);
      } catch (err) {
        out.textContent = "Error: " + (err instanceof Error ? err.message : String(err));
      }
    };
    detail.append(run, out);
  }
}
customElements.define("mcp-prompts", Prompts);
