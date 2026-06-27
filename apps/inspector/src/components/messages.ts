import { Reactive, esc } from "../lib/reactive.js";
import { client, hub } from "../lib/store.js";
import { persistEvent, clearEvents } from "../lib/idb.js";
import type { DevtoolsEvent } from "mcp-query/devtools";

// The raw JSON-RPC message log — the Inspector's signature view. Live request/response/
// notification stream (from mcp-query's instrumentTransport → devtools events), filterable,
// expandable, exportable as NDJSON, and replayable via conn.sdk.request.

export class Messages extends Reactive {
  private filter = "";
  private seen = 0;

  connectedCallback(): void {
    this.track(hub.subscribe);
    super.connectedCallback();
  }

  protected update(): void {
    const events = hub.events();
    // persist newly-arrived events
    for (let i = this.seen; i < events.length; i++) void persistEvent(events[i]);
    this.seen = events.length;

    const f = this.filter.toLowerCase();
    const rows = events.filter((e) => !f || JSON.stringify(e).toLowerCase().includes(f));

    this.innerHTML = `
      <div class="toolbar card">
        <input id="flt" placeholder="filter (method / server / type)" value="${esc(this.filter)}" aria-label="filter messages" />
        <span class="muted">${rows.length}/${events.length}</span>
        <button id="export">export NDJSON</button>
        <button id="clear">clear</button>
      </div>
      <ol class="log" role="list" aria-live="polite">
        ${rows.slice(-300).reverse().map((e, i) => this.row(e, rows.length - 1 - i)).join("")}
      </ol>
      <dialog id="replay"><pre class="output"></pre><form method="dialog"><button>close</button></form></dialog>`;

    const flt = this.querySelector<HTMLInputElement>("#flt")!;
    flt.oninput = () => { this.filter = flt.value; this.update(); flt.focus(); flt.setSelectionRange(flt.value.length, flt.value.length); };
    this.querySelector<HTMLButtonElement>("#export")!.onclick = () => this.export(rows);
    this.querySelector<HTMLButtonElement>("#clear")!.onclick = async () => { await clearEvents(); location.reload(); };

    this.querySelectorAll<HTMLElement>("[data-expand]").forEach((el) => (el.onclick = () => el.nextElementSibling?.toggleAttribute("hidden")));
    this.querySelectorAll<HTMLButtonElement>("[data-replay]").forEach((b) => (b.onclick = () => this.replay(events[Number(b.dataset.replay)])));
  }

  private row(e: DevtoolsEvent, idx: number): string {
    const dir = "dir" in e && e.dir ? (e.dir === "out" ? "→" : "←") : " ";
    const label =
      e.type === "request" ? `${e.method} #${e.id}` :
      e.type === "response" ? `#${e.id} ${e.ok ? "ok" : "err"} ${e.ms}ms` :
      e.type === "notification" ? e.method :
      e.type === "log" ? `${e.level}: ${esc(JSON.stringify(e.data))}` :
      e.type === "host-call" ? e.kind :
      e.type === "auth" ? `${e.member} ${e.phase}` :
      e.type === "invalidate" ? `${e.keys.length} keys` : "";
    const server = "server" in e ? esc(e.server) : "";
    const replay = e.type === "request" && e.dir === "out" ? `<button data-replay="${idx}" title="replay">⟳</button>` : "";
    return `<li class="evt evt-${e.type}">
      <button class="evt-head" data-expand><span class="dir">${dir}</span> <code>${e.type}</code> <span class="muted">${server}</span> ${esc(label)}</button>
      <pre class="output" hidden>${esc(JSON.stringify(e, null, 2))}</pre>
      ${replay}
    </li>`;
  }

  private export(rows: DevtoolsEvent[]): void {
    const blob = new Blob([rows.map((r) => JSON.stringify(r)).join("\n")], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mcp-messages.ndjson";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private async replay(e: DevtoolsEvent | undefined): Promise<void> {
    if (!e || e.type !== "request" || !("server" in e)) return;
    const conn = client.connection(e.server);
    const dlg = this.querySelector<HTMLDialogElement>("#replay")!;
    const out = dlg.querySelector("pre")!;
    out.textContent = "replaying…";
    dlg.showModal();
    try {
      // permissive result schema — we just want to show whatever comes back
      const result = await conn!.sdk.request({ method: e.method, params: e.params as never }, { parse: (v: unknown) => v } as never);
      out.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      out.textContent = "Error: " + (err instanceof Error ? err.message : String(err));
    }
  }
}
customElements.define("mcp-messages", Messages);
