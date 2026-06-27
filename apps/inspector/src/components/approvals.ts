import { Reactive, esc } from "../lib/reactive.js";
import { broker, roots, client } from "../lib/store.js";

// Human-in-the-loop center: the broker's pending sampling/elicitation requests, a roots
// editor, and the audit trail. The Inspector is the agent stand-in — a human authors
// sampling replies and fills elicitation forms.

export class Approvals extends Reactive {
  connectedCallback(): void {
    this.track(broker.subscribe);
    this.track(roots.subscribe);
    super.connectedCallback();
  }

  protected update(): void {
    const pending = broker.list();
    this.innerHTML = `
      <section class="card">
        <h3>Pending requests ${pending.length ? `<span class="hint">${pending.length}</span>` : ""}</h3>
        ${pending.length ? "" : '<p class="muted">no server→client requests waiting</p>'}
        <div id="queue"></div>
      </section>
      <section class="card">
        <h3>Roots</h3>
        <div id="roots"></div>
        <button id="add-root">add root</button>
        <button id="notify-roots">notify servers (roots/list_changed)</button>
      </section>
      <section class="card">
        <h3>Audit</h3>
        <ol class="audit" role="list">
          ${broker.auditLog().slice(-50).reverse().map((e) => `<li><code>${esc(e.type)}</code> <span class="muted">${esc(e.server)}</span> → ${esc(e.outcome)}${e.reason ? ` (${esc(e.reason)})` : ""}</li>`).join("")}
        </ol>
      </section>`;

    this.renderQueue(pending);
    this.renderRoots();
  }

  private renderQueue(pending: ReturnType<typeof broker.list>): void {
    const host = this.querySelector<HTMLDivElement>("#queue")!;
    for (const i of pending) {
      const card = document.createElement("div");
      card.className = "interaction card";
      card.innerHTML = `<p><b>${esc(i.server)}</b> requests <code>${esc(i.type)}</code> <span class="muted">(${esc(i.phase)})</span></p>
        <pre class="output">${esc(JSON.stringify(i.payload, null, 2))}</pre>`;

      if (i.type === "sampling" && i.manual) {
        const ta = document.createElement("textarea");
        ta.placeholder = "author the assistant response…";
        const send = document.createElement("button");
        send.textContent = "send";
        send.onclick = () => broker.resolve(i.id, {
          action: "approve",
          editedResult: { role: "assistant", content: { type: "text", text: ta.value }, model: "human", stopReason: "endTurn" },
        });
        card.append(ta, send);
      } else if (i.type === "elicitation") {
        const schema = (i.payload as { requestedSchema?: { properties?: Record<string, unknown>; required?: string[] } }).requestedSchema;
        const props = schema?.properties ?? {};
        const inputs = new Map<string, HTMLInputElement>();
        for (const k of Object.keys(props)) {
          const label = document.createElement("label");
          label.className = "field";
          label.innerHTML = `<span>${esc(k)}</span>`;
          const inp = document.createElement("input");
          inputs.set(k, inp);
          label.append(inp);
          card.append(label);
        }
        const ok = document.createElement("button");
        ok.textContent = "accept";
        ok.onclick = () => broker.resolve(i.id, { action: "approve", content: Object.fromEntries([...inputs].map(([k, el]) => [k, el.value])) });
        card.append(ok);
      } else {
        const ok = document.createElement("button");
        ok.textContent = "approve";
        ok.onclick = () => broker.resolve(i.id, { action: "approve" });
        card.append(ok);
      }
      const deny = document.createElement("button");
      deny.textContent = "deny";
      deny.onclick = () => broker.resolve(i.id, { action: "deny" });
      card.append(deny);
      host.append(card);
    }
  }

  private renderRoots(): void {
    const host = this.querySelector<HTMLDivElement>("#roots")!;
    const current = roots.get();
    host.innerHTML = "";
    current.forEach((r, idx) => {
      const row = document.createElement("div");
      row.className = "field";
      const inp = document.createElement("input");
      inp.value = r.uri;
      inp.oninput = () => { const next = [...roots.get()]; next[idx] = { uri: inp.value }; roots.set(next); };
      const rm = document.createElement("button");
      rm.textContent = "✕";
      rm.onclick = () => roots.set(roots.get().filter((_, j) => j !== idx));
      row.append(inp, rm);
      host.append(row);
    });
    this.querySelector<HTMLButtonElement>("#add-root")!.onclick = () => roots.set([...roots.get(), { uri: "file:///" }]);
    this.querySelector<HTMLButtonElement>("#notify-roots")!.onclick = () => void client.notifyRootsChanged();
  }
}
customElements.define("mcp-approvals", Approvals);
