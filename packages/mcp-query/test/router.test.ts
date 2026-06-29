import { describe, it, expect } from "vitest";
import { Router, AmbiguousCapability, CapabilityNotFound } from "../src/core/router.js";
import type { ServerConnection } from "../src/core/connection.js";

function conn(name: string, tools: string[], resources: string[] = []): ServerConnection {
  return {
    name,
    tools: new Map(tools.map((t) => [t, { name: t }])),
    resources: new Map(resources.map((r) => [r, { uri: r }])),
  } as unknown as ServerConnection;
}

function router(conns: ServerConnection[], schemeMap?: Record<string, string>) {
  return new Router(new Map(conns.map((c) => [c.name, c])), schemeMap);
}

describe("resolveTool", () => {
  it("resolves a uniquely-named tool", () => {
    const r = router([conn("gh", ["create_issue"]), conn("fs", ["read_file"])]);
    expect(r.resolveTool("create_issue").server).toBe("gh");
  });

  it("resolves an explicitly namespaced tool", () => {
    const r = router([conn("a", ["x"]), conn("b", ["x"])]);
    expect(r.resolveTool("b.x").server).toBe("b");
  });

  it("throws on ambiguity between servers", () => {
    const r = router([conn("a", ["x"]), conn("b", ["x"])]);
    expect(() => r.resolveTool("x")).toThrow(AmbiguousCapability);
  });

  it("throws when no server offers the tool", () => {
    const r = router([conn("a", ["x"])]);
    expect(() => r.resolveTool("nope")).toThrow(CapabilityNotFound);
  });

  it("honors an explicit server hint", () => {
    const r = router([conn("a", ["x"]), conn("b", ["x"])]);
    expect(r.resolveTool("x", "a").server).toBe("a");
  });
});

describe("resolveResource", () => {
  it("routes by scheme map", () => {
    const r = router([conn("gh", [], ["github://x"])], { github: "gh" });
    expect(r.resolveResource("github://x").server).toBe("gh");
  });

  it("routes by unique catalog membership", () => {
    const r = router([conn("fs", [], ["file:///a"]), conn("gh", [], ["github://x"])]);
    expect(r.resolveResource("file:///a").server).toBe("fs");
  });

  it("throws when unroutable", () => {
    const r = router([conn("fs", [], ["file:///a"])]);
    expect(() => r.resolveResource("unknown://z")).toThrow(CapabilityNotFound);
  });
});
