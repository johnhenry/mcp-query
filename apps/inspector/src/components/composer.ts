import { Reactive, esc } from "../lib/reactive.js";
import { client, activeServer } from "../lib/store.js";

// Raw JSON-RPC request composer — the escape hatch. Sends an arbitrary method/params to a
// server via mcp-query's conn.sdk.request and shows the result.

export class Composer extends Reactive {
  connectedCallback(): void {
    this.track(client.subscribeServerState);
    this.track(activeServer.subscribe);
    super.connectedCallback();
  }

  protected update(): void {
    const servers = client.connections().map((c) => c.name);
    const active = activeServer.get();
    this.innerHTML = `
      <div class="card composer">
        <div class="row">
          <select id="server" aria-label="server">${servers.map((s) => `<option ${s === active ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
          <input id="method" placeholder="method, e.g. tools/list" aria-label="method" />
          <button id="send">send</button>
        </div>
        <label class="field"><span>params (JSON)</span><textarea id="params" placeholder="{}"></textarea></label>
        <pre class="output" id="out"></pre>
      </div>`;

    const out = this.querySelector<HTMLPreElement>("#out")!;
    this.querySelector<HTMLButtonElement>("#send")!.onclick = async () => {
      const server = (this.querySelector("#server") as HTMLSelectElement).value;
      const method = (this.querySelector("#method") as HTMLInputElement).value.trim();
      const raw = (this.querySelector("#params") as HTMLTextAreaElement).value.trim();
      let params: unknown;
      try { params = raw ? JSON.parse(raw) : undefined; } catch { out.textContent = "params is not valid JSON"; return; }
      const conn = client.connection(server);
      if (!conn || !method) { out.textContent = "pick a server and method"; return; }
      out.textContent = "…";
      try {
        // permissive result schema (structural .parse) — show whatever returns
        const result = await conn.sdk.request({ method, params: params as never }, { parse: (v: unknown) => v } as never);
        out.textContent = JSON.stringify(result, null, 2);
      } catch (err) {
        out.textContent = "Error: " + (err instanceof Error ? err.message : String(err));
      }
    };
  }
}
customElements.define("mcp-composer", Composer);
