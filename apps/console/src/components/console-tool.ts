// The selected tool's operator form: build inputs from inputSchema, Run (with a confirm
// dialog for destructive tools), then render the result as a table / image / text / JSON.

import { Reactive, esc } from "@app-shared/reactive";
import { buildSchemaForm } from "@app-shared/schema-form";
import { isDestructive, isReadOnly } from "mcp-query";
import { client, activeServer } from "../lib/store.js";
import { renderToolResult, coerceArgs, type ToolResult } from "../lib/render.js";

export class ConsoleTool extends Reactive {
  static get observedAttributes(): string[] { return ["tool"]; }
  attributeChangedCallback(): void { if (this.isConnected) this.update(); }

  protected update(): void {
    const server = activeServer.get();
    const name = this.getAttribute("tool") ?? "";
    const tool = server ? client.listTools(server).find((t) => t.name === name) : undefined;

    if (!server) { this.innerHTML = `<div class="placeholder">Connect a server to begin.</div>`; return; }
    if (!tool) { this.innerHTML = `<div class="placeholder">Select a tool from the left.</div>`; return; }

    const destructive = isDestructive(tool);
    this.innerHTML = `
      <header class="detail-head">
        <h2>${esc(tool.name)}</h2>
        <div class="badges">
          ${isReadOnly(tool) ? `<span class="badge ro">read-only</span>` : ""}
          ${destructive ? `<span class="badge danger">destructive</span>` : ""}
        </div>
        ${tool.description ? `<p class="muted">${esc(tool.description)}</p>` : ""}
      </header>
      <div class="form-slot"></div>
      <div class="actions">
        <button class="run ${destructive ? "danger" : ""}" type="button">${destructive ? "⚠ Run" : "Run"}</button>
        <span class="status" aria-live="polite"></span>
      </div>
      <div class="result-slot" aria-live="polite"></div>`;

    const form = buildSchemaForm(tool.inputSchema as never);
    this.querySelector(".form-slot")!.append(form.element);

    const run = this.querySelector<HTMLButtonElement>(".run")!;
    const status = this.querySelector<HTMLElement>(".status")!;
    const slot = this.querySelector<HTMLElement>(".result-slot")!;

    // Lightweight required-field validation from the schema.
    const required: string[] = (tool.inputSchema as { required?: string[] } | undefined)?.required ?? [];

    run.onclick = async () => {
      const raw = form.getValues();
      const missing = required.filter((r) => raw[r] === undefined || raw[r] === "");
      if (missing.length) { status.textContent = `missing: ${missing.join(", ")}`; status.className = "status err"; return; }
      if (destructive && !confirm(`Run destructive tool "${tool.name}"? This may change server state.`)) return;

      const args = coerceArgs(raw, tool.inputSchema as never);
      run.disabled = true;
      status.textContent = "running…";
      status.className = "status";
      slot.innerHTML = `<div class="spinner">working…</div>`;
      try {
        const result = (await client.callTool(`${server}.${tool.name}`, args)) as ToolResult;
        slot.innerHTML = renderToolResult(result);
        status.textContent = result.isError ? "error" : "done";
        status.className = result.isError ? "status err" : "status ok";
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
customElements.define("console-tool", ConsoleTool);
