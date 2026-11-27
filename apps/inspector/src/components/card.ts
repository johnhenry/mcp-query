// Server Card panel (SEP-2127): fetch the card for the active HTTP server (or any URL you paste) and show it
// next to what the live connection says. Cards are untrusted text from whoever serves them: every value is
// set with textContent, icons are listed but never loaded, links are never made clickable.
import { Reactive } from "../lib/reactive.js";
import { client, activeServer } from "../lib/store.js";
import { cardUrlFor, liveFactsFrom, loadCardView, type CardView } from "../lib/card.js";

export class CardPanel extends Reactive {
  private built = "";
  private result: { view?: CardView; error?: string; busy?: boolean } = {};

  connectedCallback(): void {
    this.track(activeServer.subscribe);
    super.connectedCallback();
  }

  private specOf(server: string): { transport?: string; url?: string } | undefined {
    try {
      return JSON.parse(sessionStorage.getItem(`mcp-spec:${server}`) ?? "null") ?? undefined;
    } catch {
      return undefined;
    }
  }

  protected update(): void {
    const server = activeServer.get();
    if (this.built !== server || !this.firstChild) {
      this.built = server;
      this.result = {};
      this.build(server);
    }
    this.renderResult();
  }

  private build(server: string): void {
    const spec = server ? this.specOf(server) : undefined;
    const guess = cardUrlFor(spec) ?? "";
    this.replaceChildren();
    const card = el("section", "card");
    card.append(el("h3", "", "Server Card"));
    const intro = el("p", "muted", "A card is public metadata a remote server publishes (SEP-2127): identity, endpoints, supported protocol versions. Treat it as untrusted text; the live connection wins where they disagree. Browsers need the card host to send CORS headers.");
    const row = el("div", "row");
    const input = document.createElement("input");
    input.id = "card-url";
    input.setAttribute("aria-label", "card url");
    input.placeholder = "https://host/mcp/server-card";
    input.value = guess;
    const btn = el("button", "", "fetch card");
    btn.id = "fetch-card";
    btn.onclick = () => void this.fetchCard(server, input.value.trim());
    row.append(input, btn);
    const note = el("p", "muted");
    note.id = "card-note";
    note.textContent = !server ? "Connect a server first." : guess ? "" : "This server is not an HTTP server (stdio servers have no card). You can still paste a card URL.";
    const out = el("div");
    out.id = "card-result";
    card.append(intro, row, note, out);
    this.append(card);
  }

  private async fetchCard(server: string, url: string): Promise<void> {
    if (!url) return;
    this.result = { busy: true };
    this.renderResult();
    try {
      const live = liveFactsFrom(server ? client.connection(server)?.sdk : undefined, this.specOf(server)?.url);
      this.result = { view: await loadCardView(url, live) };
    } catch (e) {
      this.result = { error: e instanceof Error ? e.message : String(e) };
    }
    this.renderResult();
  }

  private renderResult(): void {
    const out = this.querySelector<HTMLElement>("#card-result");
    if (!out) return;
    out.replaceChildren();
    const { view, error, busy } = this.result;
    if (busy) return void out.append(el("p", "muted", "fetching…"));
    if (error) {
      const p = el("p", "", `Could not use the card: ${error}`);
      p.setAttribute("role", "alert");
      return void out.append(p);
    }
    if (!view) return;
    out.append(el("h4", "", "Card"));
    out.append(el("p", "muted", view.url));
    const dl = el("dl", "kv");
    for (const [k, v] of view.fields) dl.append(el("dt", "", k), el("dd", "", v));
    out.append(dl);
    out.append(el("h4", "", `Remotes (${view.remotes.length})`));
    const ul = el("ul");
    ul.setAttribute("role", "list");
    for (const r of view.remotes) ul.append(el("li", "", `${r.type} ${r.url}  [${r.versions.join(", ") || "no versions listed"}]`));
    out.append(ul);
    const differs = view.findings.filter((f) => f.kind === "differs");
    out.append(el("h4", "", differs.length ? `Disagrees with the live server (${differs.length})` : "Agrees with the live server"));
    const fl = el("ul");
    fl.id = "card-findings";
    fl.setAttribute("role", "list");
    for (const f of view.findings) fl.append(el("li", f.kind === "differs" ? "finding differs" : "finding note muted", f.message));
    if (!view.findings.length) fl.append(el("li", "muted", "nothing to compare, or no differences found"));
    out.append(fl);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

customElements.define("mcp-card", CardPanel);
