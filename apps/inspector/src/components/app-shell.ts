// App shell: top bar, connection manager, and tabbed panels. Pane switches use the View
// Transitions API (progressively enhanced, disabled under prefers-reduced-motion).

const TABS = [
  ["tools", "Tools"],
  ["resources", "Resources"],
  ["prompts", "Prompts"],
  ["messages", "Messages"],
] as const;

const TAG: Record<string, string> = {
  tools: "mcp-tools",
  resources: "mcp-resources",
  prompts: "mcp-prompts",
  messages: "mcp-messages",
};

export class AppShell extends HTMLElement {
  connectedCallback(): void {
    this.innerHTML = `
      <a class="skip" href="#main">Skip to content</a>
      <header class="topbar">
        <h1>⬡ MCP Inspector</h1>
        <span class="muted">on mcp-query</span>
      </header>
      <mcp-connections></mcp-connections>
      <nav class="tabs" role="tablist" aria-label="panels">
        ${TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="false">${label}</button>`).join("")}
      </nav>
      <main id="main" tabindex="-1"></main>`;

    this.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => (b.onclick = () => this.show(b.dataset.tab!)));
    this.show("tools");
  }

  private show(tab: string): void {
    this.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    const main = this.querySelector<HTMLElement>("#main")!;
    const swap = () => { main.innerHTML = `<${TAG[tab]}></${TAG[tab]}>`; };
    const vt = (document as Document & { startViewTransition?: (cb: () => void) => void }).startViewTransition;
    if (vt && !matchMedia("(prefers-reduced-motion: reduce)").matches) vt.call(document, swap);
    else swap();
  }
}
customElements.define("mcp-app", AppShell);
