// Apps panel: tools that carry an MCP App (`_meta.ui.resourceUri`), the app itself in a sandboxed
// iframe (double-iframe, proxy on another origin), and the session's live state beside it.
// Uses the framework-agnostic host API: createAppHost -> host.open -> mountIframe -> session.subscribe.
import { mountIframe, type AppSession, type AppSessionState } from "@johnhenry/mcp-query-ui";
import { Reactive, esc } from "../lib/reactive.js";
import { client, hub, activeServer } from "../lib/store.js";
import { buildSchemaForm } from "../lib/schema-form.js";
import { hostFor, listAppTools, sandboxProxyUrl, type AppTool } from "../lib/apps.js";
import { governance, parsePatterns } from "../lib/governed.js";

export class Apps extends Reactive {
  private selected = "";
  private session: AppSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private frame!: HTMLDivElement;
  private form: ReturnType<typeof buildSchemaForm> | undefined;
  private built = "";
  private mounted: HTMLIFrameElement | undefined;
  private openError = "";
  /** Governed mode (off by default): app calls go through mcp-gate and wait for a decision here. */
  private governed = false;
  private openedUri = "";
  private openedServer = "";

  connectedCallback(): void {
    this.track(activeServer.subscribe);
    this.track(hub.subscribe);
    this.track(governance.subscribe);
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    void this.session?.close(); // the iframe lives in this element; closing the tab closes the app
  }

  protected update(): void {
    const server = activeServer.get();
    const tools = server ? listAppTools(client, server) : [];
    const tool = tools.find((t) => t.name === this.selected) ?? tools[0];
    // Rebuild the shell only when the tool list or selection changes, never because the session
    // changed: re-rendering would destroy the running iframe.
    const key = JSON.stringify([server, tools.map((t) => t.name), tool?.name]);
    if (key !== this.built) {
      this.built = key;
      this.build(server, tools, tool);
    }
    this.renderState();
  }

  private build(server: string, tools: AppTool[], tool: AppTool | undefined): void {
    this.innerHTML = `
      <div class="split">
        <ul class="picker" role="list" aria-label="app tools">
          ${tools
            .map(
              (t) => `<li><button class="item ${t.name === tool?.name ? "sel" : ""}" data-name="${esc(t.name)}">
                ${esc(t.name)} ${t.appOnly ? '<span class="hint ro">app-only</span>' : ""}</button></li>`,
            )
            .join("") || '<li class="muted">no tools with <code>_meta.ui.resourceUri</code> (connect a server that ships an MCP App)</li>'}
        </ul>
        <div class="detail card" id="app-detail"></div>
      </div>`;
    this.querySelectorAll<HTMLButtonElement>(".item").forEach((b) => (b.onclick = () => this.pick(b.dataset.name!)));

    const detail = this.querySelector<HTMLDivElement>("#app-detail")!;
    if (!tool || !server) return;
    detail.innerHTML = `<h3>${esc(tool.name)}</h3>
      <p class="muted">${esc(tool.description ?? "")} <code>${esc(tool.uri)}</code></p>
      <div class="row" id="app-controls"></div>
      <div class="row" id="app-governance">
        <label class="inline" title="Open the app through an mcp-gate governed client: calls matching the patterns wait for your approval">
          <input type="checkbox" id="governed" ${this.governed ? "checked" : ""} /> governed (mcp-gate approvals)
        </label>
        <input id="approve-patterns" aria-label="approve patterns" title="server.tool globs that need approval, space or comma separated" value="${esc(governance.patterns.join(" "))}" ${this.governed ? "" : "disabled"} />
      </div>
      <p class="muted" id="app-error" role="alert"></p>
      <div class="app-frame" id="app-frame" aria-label="MCP App"></div>
      <div id="app-approvals" aria-live="polite"></div>
      <div id="app-state"></div>`;
    const gov = detail.querySelector<HTMLInputElement>("#governed")!;
    const pat = detail.querySelector<HTMLInputElement>("#approve-patterns")!;
    gov.onchange = () => {
      this.governed = gov.checked;
      pat.disabled = !gov.checked;
    };
    pat.oninput = () => governance.setPatterns(parsePatterns(pat.value));
    this.form = buildSchemaForm(tool.inputSchema as never);
    const open = document.createElement("button");
    open.textContent = "open app";
    open.id = "open-app";
    const close = document.createElement("button");
    close.textContent = "close app";
    close.id = "close-app";
    open.onclick = () => void this.open(server, tool);
    close.onclick = () => void this.session?.close();
    detail.querySelector("#app-controls")!.append(open, close);
    detail.insertBefore(this.form.element, detail.querySelector("#app-controls"));
    this.frame = detail.querySelector<HTMLDivElement>("#app-frame")!;
    // Re-attach a still-running app after a rebuild (tool list refresh).
    if (this.mounted && this.session && this.session.getState().status !== "closed") this.frame.append(this.mounted);
  }

  private pick(name: string): void {
    this.selected = name;
    void this.session?.close();
    this.built = "";
    this.update();
  }

  private async open(server: string, tool: AppTool): Promise<void> {
    await this.session?.close();
    this.openError = "";
    this.frame.replaceChildren();
    try {
      // Governed: the same server through mcp-gate's browser client; its approvals show up beside the app.
      const through = this.governed ? await governance.clientFor(server) : client;
      const session = await hostFor(through, server).open({ tool: tool.name, toolInput: this.form?.getValues() ?? {} });
      this.openedServer = this.governed ? server : "";
      this.openedUri = session.resource.uri;
      this.attach(session);
      const { iframe } = await mountIframe(session, { container: this.frame, sandboxUrl: sandboxProxyUrl(location), title: `MCP App: ${tool.name}` });
      this.mounted = iframe;
    } catch (e) {
      this.openError = e instanceof Error ? e.message : String(e);
      this.renderState();
    }
  }

  private attach(session: AppSession): void {
    this.unsubscribe?.();
    this.session = session;
    this.unsubscribe = session.subscribe(() => this.renderState());
    this.renderState();
  }

  /** Pending mcp-gate approvals beside the app. Everything shown here is app-supplied: text only, never HTML. */
  private renderApprovals(): void {
    const host = this.querySelector<HTMLElement>("#app-approvals");
    if (!host) return;
    const pending = governance.pending();
    host.replaceChildren();
    if (!this.governed && !pending.length) return;
    const h = document.createElement("h4");
    h.textContent = `Gate approvals (${pending.length})`;
    host.append(h);
    if (!pending.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "no calls waiting for approval";
      host.append(p);
      return;
    }
    for (const a of pending) {
      const card = document.createElement("div");
      card.className = "interaction card approval";
      card.dataset.approval = a.key;
      const line = document.createElement("p");
      const who = document.createElement("b");
      who.textContent = a.principal ?? a.server;
      const what = document.createElement("code");
      what.textContent = `${a.server}.${a.target}`;
      line.append(who, " wants to run ", what);
      if (a.destructive) line.append(" ", Object.assign(document.createElement("span"), { className: "hint", textContent: "destructive" }));
      const args = document.createElement("pre");
      args.className = "output";
      args.textContent = JSON.stringify(a.args ?? {}, null, 2);
      const ok = document.createElement("button");
      ok.textContent = "Approve";
      ok.className = "approve";
      ok.onclick = () => governance.decide(a.key, "approve");
      const no = document.createElement("button");
      no.textContent = "Deny";
      no.className = "deny";
      no.onclick = () => governance.decide(a.key, "deny");
      card.append(line, args, ok, no);
      host.append(card);
    }
  }

  private renderState(): void {
    const err = this.querySelector<HTMLElement>("#app-error");
    if (err) err.textContent = this.openError ? `Could not open the app: ${this.openError}` : "";
    this.renderApprovals();
    const el = this.querySelector<HTMLElement>("#app-state");
    if (!el) return;
    const s: AppSessionState | undefined = this.session?.getState();
    // A closed app can no longer use an answer: refuse whatever it still has waiting.
    if (s?.status === "closed" && this.openedServer) governance.denyFor(this.openedServer, `mcp-app:${this.openedUri}`);
    if (!s) {
      el.innerHTML = '<p class="muted">No app open.</p>';
      return;
    }
    if (this.mounted && s.size?.height) this.mounted.style.height = `${Math.min(Math.max(s.size.height, 80), 800)}px`;
    el.innerHTML = `
      <h4>Session</h4>
      <dl class="kv">
        <dt>status</dt><dd><span class="state state-${esc(s.status)}" id="app-status" data-status="${esc(s.status)}">${esc(s.status)}</span></dd>
        <dt>app</dt><dd>${s.appInfo ? esc(`${s.appInfo.name} ${s.appInfo.version}`) : "-"}</dd>
        <dt>uri</dt><dd><code>${esc(s.uri)}</code></dd>
        <dt>csp</dt><dd><code>${esc(this.session!.resource.cspHeader)}</code></dd>
        ${s.error ? `<dt>error</dt><dd>${esc(s.error)}</dd>` : ""}
      </dl>
      <h4>Calls (${s.calls.length})</h4>
      <ul class="app-calls" id="app-calls" role="list">
        ${s.calls.map((c) => `<li class="call-${esc(c.outcome)}"><code>${esc(c.kind)}</code> ${esc(c.target)} <span class="hint">${esc(c.outcome)}</span>${c.error ? ` <span class="muted">${esc(c.error)}</span>` : ""}</li>`).join("") || '<li class="muted">none yet</li>'}
      </ul>
      <h4>Messages (${s.messages.length})</h4>
      <ul class="app-messages" id="app-messages" role="list">
        ${s.messages.map((m) => `<li><code>${esc(m.role)}</code> ${esc(JSON.stringify(m.content))}</li>`).join("") || '<li class="muted">none</li>'}
      </ul>`;
  }
}
customElements.define("mcp-apps", Apps);
