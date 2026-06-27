import { describe, it, expect } from "vitest";
import { Reactive, esc } from "../src/lib/reactive.js";

class Probe extends Reactive {
  renders = 0;
  static listeners = new Set<() => void>();
  connectedCallback(): void {
    this.track((cb) => {
      Probe.listeners.add(cb);
      return () => Probe.listeners.delete(cb);
    });
    super.connectedCallback();
  }
  protected update(): void {
    this.renders++;
  }
}
customElements.define("x-probe", Probe);

describe("Reactive base", () => {
  it("renders on connect, coalesces tracked updates, and cleans up on disconnect", async () => {
    const el = new Probe();
    document.body.append(el);
    expect(el.renders).toBe(1); // initial render

    // two synchronous store fires -> a single coalesced re-render
    for (const cb of Probe.listeners) cb();
    for (const cb of Probe.listeners) cb();
    await Promise.resolve();
    await Promise.resolve();
    expect(el.renders).toBe(2);

    el.remove(); // disconnectedCallback runs cleanups (unsubscribes)
    expect(Probe.listeners.size).toBe(0);
    for (const cb of Probe.listeners) cb(); // none left
    await Promise.resolve();
    expect(el.renders).toBe(2);
  });
});

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});
