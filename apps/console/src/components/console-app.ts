// The operator console shell: a header (connect form + server switcher + saved servers),
// a left capability nav, and a main pane that swaps between console-tool / console-resource
// / console-prompt for the current selection.

import { Reactive, esc } from "@app-shared/reactive";
import type { TargetSpec } from "@app-shared/transport";
import {
  client,
  activeServer,
  connectServer,
  disconnectServer,
  rememberServer,
  forgetServer,
  serverBook,
  proxyToken,
  type SavedServer,
} from "../lib/store.js";
import type { ConsoleNav, Selection } from "./console-nav.js";
import "./console-nav.js";
import "./console-tool.js";
import "./console-resource.js";
import "./console-prompt.js";

export class ConsoleApp extends Reactive {
  private selection: Selection | null = null;
  private busy = false;
  private error = "";

  connectedCallback(): void {
    this.track(client.subscribeServerState);
    this.track(activeServer.subscribe);
    this.track(serverBook.subscribe);
    // Reset the selection whenever the active server changes.
    this.track((cb) => activeServer.subscribe(() => { this.selection = null; cb(); }));
    super.connectedCallback();
  }

  protected update(): void {
    const conns = client.connections();
    const active = activeServer.get();
    const book = serverBook.get();

    this.innerHTML = `
      <a class="skip" href="#main">Skip to content</a>
      <header class="topbar">
        <div class="brand">
          <h1>⬡ MCP Console</h1>
          <span class="muted">operate any MCP server</span>
        </div>
        <div class="server-switcher" role="group" aria-label="active server">
          ${
            conns.length
              ? conns
                  .map(
                    (c) => `<button class="server-chip ${c.name === active ? "active" : ""}" data-pick="${esc(c.name)}" aria-current="${c.name === active}">
                      <span class="dot state-${esc(c.state)}"></span>${esc(c.name)}
                      <span class="rm" data-rm="${esc(c.name)}" title="disconnect" role="button" aria-label="disconnect ${esc(c.name)}">✕</span>
                    </button>`,
                  )
                  .join("")
              : `<span class="muted">no servers connected</span>`
          }
        </div>
      </header>

      ${!proxyToken ? `<div class="banner" role="alert">No <code>proxyToken</code> in the URL — stdio/proxy connections need it. Run <code>npm run dev</code> and open the printed <code>?proxyToken=…&amp;proxyPort=…</code> link. (Direct OAuth http/sse servers work without it.)</div>` : ""}

      <details class="connect-panel card" ${conns.length ? "" : "open"}>
        <summary>Connect a server</summary>
        <form class="connect-form" aria-label="connect a server">
          <input name="name" placeholder="name (e.g. everything)" required aria-label="name" />
          <select name="transport" aria-label="transport">
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
          <input name="command" placeholder="command (stdio), e.g. npx" aria-label="command" />
          <input name="args" placeholder="args, e.g. -y @modelcontextprotocol/server-everything" aria-label="args" />
          <input name="url" placeholder="url (http/sse)" aria-label="url" />
          <label class="inline" title="connect directly from the browser so OAuth runs here">
            <input type="checkbox" name="direct" /> direct (browser OAuth)
          </label>
          <label class="inline"><input type="checkbox" name="save" checked /> save</label>
          <button type="submit" ${this.busy ? "disabled" : ""}>${this.busy ? "connecting…" : "Connect"}</button>
        </form>
        ${this.error ? `<div class="result-error" role="alert">${esc(this.error)}</div>` : ""}
        ${
          book.length
            ? `<div class="saved">
                <h4>Saved servers</h4>
                <ul role="list">
                  ${book
                    .map(
                      (s) => `<li>
                        <button class="saved-connect" data-saved="${esc(s.name)}">${esc(s.name)}</button>
                        <span class="muted">${esc(describe(s))}</span>
                        <button class="saved-forget" data-forget="${esc(s.name)}" aria-label="forget ${esc(s.name)}">✕</button>
                      </li>`,
                    )
                    .join("")}
                </ul>
              </div>`
            : ""
        }
      </details>

      <div class="workspace">
        <aside class="nav-pane" aria-label="capabilities"><console-nav></console-nav></aside>
        <main id="main" class="main-pane" tabindex="-1"></main>
      </div>`;

    this.wireConnectForm();
    this.wireSwitcher();
    this.wireSaved();
    this.wireNav();
    this.renderMain();
  }

  private wireConnectForm(): void {
    const form = this.querySelector<HTMLFormElement>(".connect-form");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const spec: SavedServer = {
        name: String(fd.get("name") || "").trim(),
        transport: String(fd.get("transport")) as TargetSpec["transport"],
        command: String(fd.get("command") || "") || undefined,
        args: String(fd.get("args") || "").split(" ").filter(Boolean),
        url: String(fd.get("url") || "") || undefined,
        direct: fd.get("direct") === "on",
      };
      const save = fd.get("save") === "on";
      this.error = "";
      this.busy = true;
      this.update();
      try {
        if (save) rememberServer(spec);
        await connectServer(spec);
      } catch (err) {
        this.error = "connect failed: " + (err instanceof Error ? err.message : String(err));
      } finally {
        this.busy = false;
        this.update();
      }
    };
  }

  private wireSwitcher(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach(
      (b) => (b.onclick = (e) => {
        if ((e.target as HTMLElement).hasAttribute("data-rm")) return; // handled below
        activeServer.set(b.dataset.pick!);
      }),
    );
    this.querySelectorAll<HTMLElement>("[data-rm]").forEach(
      (el) => (el.onclick = (e) => { e.stopPropagation(); void disconnectServer(el.dataset.rm!); }),
    );
  }

  private wireSaved(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-saved]").forEach(
      (b) => (b.onclick = async () => {
        const spec = serverBook.get().find((s) => s.name === b.dataset.saved);
        if (!spec) return;
        this.busy = true; this.error = ""; this.update();
        try { await connectServer(spec); }
        catch (err) { this.error = "connect failed: " + (err instanceof Error ? err.message : String(err)); }
        finally { this.busy = false; this.update(); }
      }),
    );
    this.querySelectorAll<HTMLButtonElement>("[data-forget]").forEach(
      (b) => (b.onclick = () => forgetServer(b.dataset.forget!)),
    );
  }

  private wireNav(): void {
    const nav = this.querySelector<ConsoleNav>("console-nav");
    if (!nav) return;
    nav.addEventListener("select", (e) => {
      this.selection = (e as CustomEvent<Selection>).detail;
      this.renderMain();
    });
    // restore highlight after re-render
    queueMicrotask(() => nav.setSelected?.(this.selection));
  }

  private renderMain(): void {
    const main = this.querySelector<HTMLElement>("#main");
    if (!main) return;
    if (!activeServer.get()) { main.innerHTML = `<div class="placeholder">Connect a server to explore its tools, resources, and prompts.</div>`; return; }
    const sel = this.selection;
    if (!sel) { main.innerHTML = `<div class="placeholder">Pick a capability from the left (or press <kbd>j</kbd>/<kbd>k</kbd> then <kbd>Enter</kbd>).</div>`; return; }
    const tag = sel.kind === "tool" ? "console-tool" : sel.kind === "resource" ? "console-resource" : "console-prompt";
    const attr = sel.kind === "tool" ? "tool" : sel.kind === "resource" ? "uri" : "prompt";
    main.innerHTML = `<${tag} ${attr}="${esc(sel.id)}"></${tag}>`;
  }
}

function describe(s: SavedServer): string {
  if (s.transport === "stdio") return `stdio · ${[s.command, ...(s.args ?? [])].filter(Boolean).join(" ")}`;
  return `${s.transport}${s.direct ? " · direct" : ""} · ${s.url ?? ""}`;
}

customElements.define("console-app", ConsoleApp);
