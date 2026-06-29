// The Web Components analog of useSyncExternalStore: a base custom element that
// re-renders when any tracked store signal fires, and cleans up on disconnect. This is
// how the WC Console dogfoods mcp-query's framework-agnostic core — `cache.subscribe`,
// `subscribeServerState`, `broker.subscribe`, `DevtoolsHub.subscribe` all plug in here.

export abstract class Reactive extends HTMLElement {
  private cleanups: Array<() => void> = [];
  private scheduled = false;

  connectedCallback(): void {
    this.update();
  }
  disconnectedCallback(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }

  /** Subscribe to a store; re-render (coalesced to a microtask) whenever it changes. */
  protected track(subscribe: (cb: () => void) => () => void): void {
    this.cleanups.push(subscribe(() => this.schedule()));
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.isConnected) this.update();
    });
  }

  protected abstract update(): void;
}

/** Tiny escape helper for interpolating untrusted text into innerHTML. */
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
