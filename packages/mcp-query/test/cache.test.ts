import { describe, it, expect, vi } from "vitest";
import { MCPCache } from "../src/core/cache.js";
import { resourceTag, capsTag, serverTag } from "../src/core/tags.js";
import type { CacheKey } from "../src/core/keys.js";

const rkey = (uri: string): CacheKey => ({ kind: "resource", server: "fs", uri });

describe("MCPCache writes & reads", () => {
  it("stores data and reports a fresh, successful entry", () => {
    const c = new MCPCache();
    c.write(rkey("file:///a"), { hello: 1 }, { tags: [resourceTag("fs", "file:///a")] });
    const e = c.getSnapshot(rkey("file:///a"));
    expect(e?.status).toBe("success");
    expect(e?.data).toEqual({ hello: 1 });
    expect(c.isStale(rkey("file:///a"))).toBe(false);
  });

  it("treats a missing entry as stale", () => {
    const c = new MCPCache();
    expect(c.isStale(rkey("file:///missing"))).toBe(true);
  });

  it("honors staleTime against an injected clock", () => {
    let now = 1000;
    const c = new MCPCache({ now: () => now });
    c.write(rkey("file:///a"), 1, { staleTime: 100 });
    expect(c.isStale(rkey("file:///a"))).toBe(false);
    now = 1050;
    expect(c.isStale(rkey("file:///a"))).toBe(false);
    now = 1200;
    expect(c.isStale(rkey("file:///a"))).toBe(true);
  });
});

describe("subscribers", () => {
  it("ref-counts subscribers and notifies on write", () => {
    const c = new MCPCache();
    const fn = vi.fn();
    const unsub = c.subscribe(rkey("file:///a"), fn);
    expect(c.getSnapshot(rkey("file:///a"))?.subscribers).toBe(1);
    c.write(rkey("file:///a"), 1);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    expect(c.getSnapshot(rkey("file:///a"))?.subscribers).toBe(0);
  });

  it("fires onSubscribe only for the first subscriber and onUnsubscribe for the last", () => {
    const onSubscribe = vi.fn();
    const onUnsubscribe = vi.fn();
    const c = new MCPCache({ events: { onSubscribe, onUnsubscribe } });
    const u1 = c.subscribe(rkey("file:///a"), () => {});
    const u2 = c.subscribe(rkey("file:///a"), () => {});
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    u1();
    expect(onUnsubscribe).not.toHaveBeenCalled();
    u2();
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("tag invalidation", () => {
  it("marks entries carrying a tag stale and notifies subscribers", () => {
    const c = new MCPCache();
    const fn = vi.fn();
    c.subscribe(rkey("file:///a"), fn);
    c.write(rkey("file:///a"), 1, { tags: [resourceTag("fs", "file:///a")] });
    fn.mockClear();
    c.invalidateTags([resourceTag("fs", "file:///a")]);
    expect(c.getSnapshot(rkey("file:///a"))?.isStale).toBe(true);
    expect(fn).toHaveBeenCalled();
  });

  it("onResourceUpdated invalidates exactly that URI", () => {
    const c = new MCPCache();
    c.write(rkey("file:///a"), 1, { tags: [resourceTag("fs", "file:///a")] });
    c.write(rkey("file:///b"), 1, { tags: [resourceTag("fs", "file:///b")] });
    c.onResourceUpdated("fs", "file:///a");
    expect(c.getSnapshot(rkey("file:///a"))?.isStale).toBe(true);
    expect(c.getSnapshot(rkey("file:///b"))?.isStale).toBe(false);
  });

  it("onListChanged invalidates a capability catalog", () => {
    const c = new MCPCache();
    const key: CacheKey = { kind: "toolList", server: "fs" };
    c.write(key, [], { tags: [capsTag("fs", "tools")] });
    c.onListChanged("fs", "tools");
    expect(c.getSnapshot(key)?.isStale).toBe(true);
  });

  it("markStaleByServer invalidates everything from a server", () => {
    const c = new MCPCache();
    c.write(rkey("file:///a"), 1, { tags: [resourceTag("fs", "file:///a"), serverTag("fs")] });
    c.markStaleByServer("fs");
    expect(c.getSnapshot(rkey("file:///a"))?.isStale).toBe(true);
  });

  it("reindexes tags so stale tags no longer match after a rewrite", () => {
    const c = new MCPCache();
    c.write(rkey("file:///a"), 1, { tags: ["old"] });
    c.write(rkey("file:///a"), 2, { tags: ["new"] });
    c.invalidateTags(["old"]);
    expect(c.getSnapshot(rkey("file:///a"))?.isStale).toBe(false);
    c.invalidateTags(["new"]);
    expect(c.getSnapshot(rkey("file:///a"))?.isStale).toBe(true);
  });
});

describe("optimistic patch", () => {
  it("applies a patch and rolls back on demand", () => {
    const c = new MCPCache();
    c.write(rkey("file:///a"), { n: 1 });
    const rollback = c.patch([{ key: rkey("file:///a"), recipe: (p: any) => ({ n: p.n + 1 }) }]);
    expect(c.getSnapshot(rkey("file:///a"))?.data).toEqual({ n: 2 });
    rollback();
    expect(c.getSnapshot(rkey("file:///a"))?.data).toEqual({ n: 1 });
  });
});

describe("garbage collection", () => {
  it("evicts entries with no subscribers after gcTime", () => {
    vi.useFakeTimers();
    const c = new MCPCache();
    const unsub = c.subscribe(rkey("file:///a"), () => {});
    c.write(rkey("file:///a"), 1, { gcTime: 1000 });
    unsub();
    expect(c.getSnapshot(rkey("file:///a"))).toBeDefined();
    vi.advanceTimersByTime(1001);
    expect(c.getSnapshot(rkey("file:///a"))).toBeUndefined();
    vi.useRealTimers();
  });

  it("never evicts an entry with a live protocol subscription", () => {
    vi.useFakeTimers();
    const c = new MCPCache();
    const unsub = c.subscribe(rkey("file:///a"), () => {});
    c.write(rkey("file:///a"), 1, { gcTime: 1000 });
    c.setProtocolSubscribed(rkey("file:///a"), true);
    unsub();
    vi.advanceTimersByTime(5000);
    expect(c.getSnapshot(rkey("file:///a"))).toBeDefined();
    vi.useRealTimers();
  });
});

describe("MCPCache.onExternalInvalidate (post-construction listener hook)", () => {
  it("notifies listeners on tag invalidation even with no matching local entry, and unsubscribes", () => {
    const c = new MCPCache();
    const seen: unknown[] = [];
    const off = c.onExternalInvalidate((e) => seen.push(e));
    c.onResourceUpdated("fs", "file:///nope");
    expect(seen).toEqual([{ tags: [resourceTag("fs", "file:///nope")] }]);
    off();
    c.onListChanged("fs", "tools");
    expect(seen).toHaveLength(1);
  });

  it("supports multiple listeners and still calls a constructor-provided handler", () => {
    const ctor = vi.fn();
    const c = new MCPCache({ events: { onExternalInvalidate: ctor } });
    const a = vi.fn();
    const b = vi.fn();
    c.onExternalInvalidate(a);
    c.onExternalInvalidate(b);
    c.invalidateTags([serverTag("fs")], false);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("is reachable on a built MCPClient's cache, which marks a server stale via it", async () => {
    const { MCPClient } = await import("../src/index.js");
    const client = new MCPClient({ servers: {} });
    const fn = vi.fn();
    client.cache.onExternalInvalidate(fn);
    client.cache.markStaleByServer("x");
    expect(fn).toHaveBeenCalledWith({ tags: [serverTag("x")] });
  });
});
