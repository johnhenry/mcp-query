// Auto-generated capability nav for the active server: tools / resources / prompts, with
// a filter box, read-only/destructive badges, and keyboard navigation (j/k or arrows to
// move, Enter to open). Re-renders on list_changed via subscribeCapabilities.

import { Reactive, esc } from "@app-shared/reactive";
import { isDestructive, isReadOnly } from "mcp-query";
import { client, activeServer } from "../lib/store.js";

export type Kind = "tool" | "resource" | "prompt";
export interface Selection { kind: Kind; id: string }

interface Row { kind: Kind; id: string; label: string; sub?: string; ro?: boolean; danger?: boolean }

export class ConsoleNav extends Reactive {
  private filter = "";
  private cursor = 0;
  /** Currently opened item (mirrors <console-app>'s selection) so we can highlight it. */
  private selected: Selection | null = null;

  connectedCallback(): void {
    this.track(activeServer.subscribe);
    this.track((cb) => client.subscribeCapabilities(() => cb())); // re-render on *_list_changed
    this.track(client.subscribeServerState);
    this.tabIndex = 0;
    this.addEventListener("keydown", this.onKey);
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    this.removeEventListener("keydown", this.onKey);
    super.disconnectedCallback();
  }

  /** Called by <console-app> when a selection is made elsewhere, to keep highlight in sync. */
  setSelected(sel: Selection | null): void {
    this.selected = sel;
    const i = this.rows().findIndex((r) => r.kind === sel?.kind && r.id === sel?.id);
    if (i >= 0) this.cursor = i;
    this.update();
  }

  private rows(): Row[] {
    const server = activeServer.get();
    if (!server) return [];
    const tools: Row[] = client.listTools(server).map((t) => ({
      kind: "tool", id: t.name, label: t.name, sub: t.description, ro: isReadOnly(t), danger: isDestructive(t),
    }));
    const resources: Row[] = client.listResources(server).map((r) => ({
      kind: "resource", id: r.uri, label: r.name ?? r.uri, sub: r.uri,
    }));
    const prompts: Row[] = client.listPrompts(server).map((p) => ({
      kind: "prompt", id: p.name, label: p.name, sub: p.description,
    }));
    const all = [...tools, ...resources, ...prompts];
    const f = this.filter.trim().toLowerCase();
    return f ? all.filter((r) => (r.label + " " + (r.sub ?? "")).toLowerCase().includes(f)) : all;
  }

  protected update(): void {
    const server = activeServer.get();
    const rows = this.rows();
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);

    const counts = server
      ? { t: client.listTools(server).length, r: client.listResources(server).length, p: client.listPrompts(server).length }
      : { t: 0, r: 0, p: 0 };

    this.innerHTML = `
      <div class="nav-head">
        <input class="filter" type="search" placeholder="Filter capabilities…" value="${esc(this.filter)}" aria-label="filter capabilities" />
        <div class="caps-summary muted">${counts.t} tools · ${counts.r} resources · ${counts.p} prompts</div>
      </div>
      ${this.section("Tools", rows.filter((r) => r.kind === "tool"), rows)}
      ${this.section("Resources", rows.filter((r) => r.kind === "resource"), rows)}
      ${this.section("Prompts", rows.filter((r) => r.kind === "prompt"), rows)}
      ${!server ? `<p class="muted nav-empty">No active server.</p>` : rows.length === 0 ? `<p class="muted nav-empty">Nothing matches.</p>` : ""}`;

    const input = this.querySelector<HTMLInputElement>(".filter")!;
    input.oninput = () => { this.filter = input.value; this.cursor = 0; this.update(); this.querySelector<HTMLInputElement>(".filter")?.focus(); };

    this.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((b) => {
      b.onclick = () => { this.cursor = Number(b.dataset.index); this.open(rows[this.cursor]!); };
    });
  }

  private section(title: string, items: Row[], all: Row[]): string {
    if (items.length === 0) return "";
    const body = items
      .map((row) => {
        const i = all.indexOf(row);
        const isCursor = i === this.cursor;
        const isOpen = this.selected?.kind === row.kind && this.selected?.id === row.id;
        return `<li>
          <button class="nav-item ${isCursor ? "cursor" : ""} ${isOpen ? "open" : ""}" data-index="${i}" title="${esc(row.sub ?? "")}">
            <span class="nav-label">${esc(row.label)}</span>
            <span class="nav-badges">
              ${row.ro ? `<span class="badge ro">RO</span>` : ""}
              ${row.danger ? `<span class="badge danger">⚠</span>` : ""}
            </span>
          </button>
        </li>`;
      })
      .join("");
    return `<div class="nav-section"><h3 class="nav-title">${esc(title)}</h3><ul role="list">${body}</ul></div>`;
  }

  private open(row: Row): void {
    this.selected = { kind: row.kind, id: row.id };
    this.dispatchEvent(new CustomEvent<Selection>("select", { detail: { kind: row.kind, id: row.id }, bubbles: true }));
    this.update();
  }

  private onKey = (e: KeyboardEvent): void => {
    // Don't hijack typing in the filter box, except for Enter/Escape.
    const inFilter = (e.target as HTMLElement)?.classList?.contains("filter");
    const rows = this.rows();
    if (rows.length === 0) return;
    if ((e.key === "j" || e.key === "ArrowDown") && !inFilter) {
      e.preventDefault(); this.cursor = Math.min(rows.length - 1, this.cursor + 1); this.update();
    } else if ((e.key === "k" || e.key === "ArrowUp") && !inFilter) {
      e.preventDefault(); this.cursor = Math.max(0, this.cursor - 1); this.update();
    } else if (e.key === "Enter") {
      e.preventDefault(); this.open(rows[this.cursor]!);
    } else if (e.key === "/" && !inFilter) {
      e.preventDefault(); this.querySelector<HTMLInputElement>(".filter")?.focus();
    }
  };
}
customElements.define("console-nav", ConsoleNav);
