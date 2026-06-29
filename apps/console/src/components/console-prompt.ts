// Fill a prompt's declared arguments, fetch it (getPrompt), and render the resulting
// messages as a readable transcript.

import { Reactive, esc } from "@app-shared/reactive";
import { client, activeServer } from "../lib/store.js";
import { renderPromptMessages } from "../lib/render.js";

interface PromptArg { name: string; required?: boolean; description?: string }

export class ConsolePrompt extends Reactive {
  static get observedAttributes(): string[] { return ["prompt"]; }
  attributeChangedCallback(): void { if (this.isConnected) this.update(); }

  protected update(): void {
    const server = activeServer.get();
    const name = this.getAttribute("prompt") ?? "";
    const prompt = server ? client.listPrompts(server).find((p) => p.name === name) : undefined;

    if (!server) { this.innerHTML = `<div class="placeholder">Connect a server to begin.</div>`; return; }
    if (!prompt) { this.innerHTML = `<div class="placeholder">Select a prompt from the left.</div>`; return; }

    const args = (prompt as { arguments?: PromptArg[] }).arguments ?? [];
    this.innerHTML = `
      <header class="detail-head">
        <h2>${esc(prompt.name)}</h2>
        ${prompt.description ? `<p class="muted">${esc(prompt.description)}</p>` : ""}
      </header>
      <div class="schema-form">
        ${args
          .map(
            (a) => `<label class="field">
              <span>${esc(a.name)}${a.required ? " *" : ""}</span>
              <input type="text" data-arg="${esc(a.name)}" ${a.description ? `title="${esc(a.description)}"` : ""} />
            </label>`,
          )
          .join("") || `<p class="muted">no arguments</p>`}
      </div>
      <div class="actions">
        <button class="run" type="button">Get prompt</button>
        <span class="status" aria-live="polite"></span>
      </div>
      <div class="result-slot" aria-live="polite"></div>`;

    const run = this.querySelector<HTMLButtonElement>(".run")!;
    const status = this.querySelector<HTMLElement>(".status")!;
    const slot = this.querySelector<HTMLElement>(".result-slot")!;

    run.onclick = async () => {
      const vars: Record<string, string> = {};
      for (const el of this.querySelectorAll<HTMLInputElement>("[data-arg]")) {
        if (el.value) vars[el.dataset.arg!] = el.value;
      }
      const missing = args.filter((a) => a.required && !vars[a.name]).map((a) => a.name);
      if (missing.length) { status.textContent = `missing: ${missing.join(", ")}`; status.className = "status err"; return; }

      run.disabled = true;
      status.textContent = "fetching…";
      status.className = "status";
      try {
        const result = await client.getPrompt(prompt.name, vars, server);
        slot.innerHTML = renderPromptMessages(result);
        status.textContent = "done";
        status.className = "status ok";
      } catch (err) {
        slot.innerHTML = `<div class="result-error" role="alert">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        status.textContent = "failed";
        status.className = "status err";
      } finally {
        run.disabled = false;
      }
    };
  }
}
customElements.define("console-prompt", ConsolePrompt);
