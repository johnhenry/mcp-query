import { Reactive, esc } from "../lib/reactive.js";
import { client, connectServer, disconnectServer, activeServer } from "../lib/store.js";
import type { TargetSpec } from "../lib/transport.js";

export class Connections extends Reactive {
  connectedCallback(): void {
    this.track(client.subscribeServerState);
    this.track(activeServer.subscribe);
    super.connectedCallback();
  }

  protected update(): void {
    const conns = client.connections();
    this.innerHTML = `
      <form class="card add-server" aria-label="Add server">
        <select name="transport" aria-label="transport">
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
        <input name="name" placeholder="name" required aria-label="name" />
        <input name="command" placeholder="command (stdio), e.g. npx" aria-label="command" />
        <input name="args" placeholder="args, e.g. -y @modelcontextprotocol/server-everything" aria-label="args" />
        <input name="url" placeholder="url (http/sse)" aria-label="url" />
        <label class="inline" title="connect directly from the browser so OAuth runs + is observable">
          <input type="checkbox" name="direct" /> direct (browser OAuth)
        </label>
        <button type="submit">connect</button>
      </form>
      <ul class="server-list" role="list">
        ${conns
          .map(
            (c) => `<li class="${c.name === activeServer.get() ? "active" : ""}">
              <button class="pick" data-name="${esc(c.name)}" aria-current="${c.name === activeServer.get()}">${esc(c.name)}</button>
              <span class="state state-${c.state}" title="${c.state}">${c.state}</span>
              <button class="rm" data-name="${esc(c.name)}" title="disconnect" aria-label="disconnect ${esc(c.name)}">✕</button>
            </li>`,
          )
          .join("")}
      </ul>`;

    const form = this.querySelector("form")!;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const spec: TargetSpec = {
        transport: String(fd.get("transport")) as TargetSpec["transport"],
        command: String(fd.get("command") || "") || undefined,
        args: String(fd.get("args") || "").split(" ").filter(Boolean),
        url: String(fd.get("url") || "") || undefined,
        direct: fd.get("direct") === "on",
      };
      try {
        await connectServer({ name: String(fd.get("name")), ...spec });
        form.reset();
      } catch (err) {
        alert("connect failed: " + (err instanceof Error ? err.message : String(err)));
      }
    };
    this.querySelectorAll<HTMLButtonElement>(".pick").forEach((b) => (b.onclick = () => activeServer.set(b.dataset.name!)));
    this.querySelectorAll<HTMLButtonElement>(".rm").forEach((b) => (b.onclick = () => void disconnectServer(b.dataset.name!)));
  }
}
customElements.define("mcp-connections", Connections);
