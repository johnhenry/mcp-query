import { describe, it, expect, vi } from "vitest";
import { MCPCache, structuralEqual } from "../src/core/cache.js";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import type { CacheKey } from "../src/core/keys.js";

const rkey = (uri: string): CacheKey => ({ kind: "resource", server: "srv", uri });

describe("structural sharing", () => {
  it("does not bump the version when re-written with deep-equal data", () => {
    const c = new MCPCache();
    const fn = vi.fn();
    c.subscribe(rkey("a"), fn);
    c.write(rkey("a"), { items: [1, 2], nested: { x: 1 } });
    const v1 = c.getVersion(rkey("a"));
    fn.mockClear();
    c.write(rkey("a"), { items: [1, 2], nested: { x: 1 } }); // identical
    expect(c.getVersion(rkey("a"))).toBe(v1); // no re-render
    expect(fn).not.toHaveBeenCalled();
  });

  it("bumps the version when data actually changes", () => {
    const c = new MCPCache();
    c.write(rkey("a"), { n: 1 });
    const v1 = c.getVersion(rkey("a"));
    c.write(rkey("a"), { n: 2 });
    expect(c.getVersion(rkey("a"))).toBeGreaterThan(v1);
  });

  it("structuralEqual handles primitives, arrays, and nested objects", () => {
    expect(structuralEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(structuralEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(structuralEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe("in-flight de-duplication", () => {
  it("shares one request across concurrent reads of the same key", async () => {
    let reads = 0;
    const mock = new MockMCPServer({
      resources: [{ uri: "mem://a", read: () => ((reads++), { text: "A" }) }],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    await client.connect();

    const [r1, r2, r3] = await Promise.all([
      client.readResource("mem://a"),
      client.readResource("mem://a"),
      client.readResource("mem://a"),
    ]);
    expect(reads).toBe(1); // de-duped
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    await client.close();
  });

  it("starts a fresh request once the prior one settles", async () => {
    let reads = 0;
    const mock = new MockMCPServer({
      resources: [{ uri: "mem://a", read: () => ((reads++), { text: "A" }) }],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    await client.connect();
    await client.readResource("mem://a");
    await client.readResource("mem://a"); // not de-duped (sequential)
    expect(reads).toBe(2);
    await client.close();
  });
});
