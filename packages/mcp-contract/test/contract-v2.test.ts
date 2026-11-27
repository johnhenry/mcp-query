import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer, type MockSpec } from "../../mcp-query/src/testing/mockServer.js";
import { captureContract, diffContract, upgradeContract, type Contract } from "../src/contract.js";
import { diffSchema } from "../src/schema.js";
import { formatDiff } from "../src/report.js";

async function capture(spec: MockSpec, era: "legacy" | "modern" = "modern") {
  const mock = new MockMCPServer(spec, { era });
  const client = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: era === "modern" ? "auto" : "legacy" } });
  await client.connect(mock.transport());
  const contract = await captureContract(client);
  await client.close();
  return contract;
}

const base = (over: Partial<Contract> = {}): Contract => ({ version: 2, tools: [], resources: [], templates: [], prompts: [], ...over });
const find = (d: ReturnType<typeof diffContract>, category: string, target?: string) => d.changes.filter((c) => c.category === category && (target === undefined || c.target === target));

describe("contract v2 capture", () => {
  it("records version 2, capabilities, extensions (with revision) and the negotiated era over a modern connection", async () => {
    const c = await capture({
      tools: [{ name: "echo", title: "Echo", description: "d" } as never],
      capabilities: { tools: {}, logging: {}, extensions: { "io.example/widgets": { revision: "2026-09-01" }, "io.example/plain": {} } },
    });
    expect(c.version).toBe(2);
    expect(c.capabilities).toMatchObject({ tools: {}, logging: {} });
    expect(c.capabilities).not.toHaveProperty("extensions");
    expect(c.extensions).toEqual({ "io.example/plain": {}, "io.example/widgets": { revision: "2026-09-01" } });
    expect(c.protocol?.era).toBe("modern");
    expect(c.protocol?.supported).toContain("2026-07-28");
    expect(c.protocol?.negotiated).toBeTruthy();
    expect(c.cacheHints?.tools).toBeDefined();
  });

  it("captures title/icons/_meta and reads wire-only cache hints when the server sends them", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] }, { era: "modern" });
    const client = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
    await client.connect(mock.transport());
    // Stand in for a server that sends SEP-973 metadata and SEP-2549 hints.
    const listTools = client.listTools.bind(client);
    client.listTools = (async (...args: Parameters<typeof listTools>) => ({
      ...(await listTools(...args)),
      tools: [{ name: "t", title: "Tee", icons: [{ src: "https://x.test/i.png" }], _meta: { a: 1 }, inputSchema: { type: "object" } }],
      ttlMs: 300000,
      cacheScope: "public",
    })) as typeof client.listTools;
    const c = await captureContract(client);
    await client.close();
    expect(c.tools[0]).toMatchObject({ title: "Tee", icons: [{ src: "https://x.test/i.png" }], _meta: { a: 1 } });
    expect(c.cacheHints?.tools).toEqual({ ttlMs: 300000, cacheScope: "public" });
  });

  it("captures a legacy-era server without v2-only protocol fields and tolerates missing hints", async () => {
    const c = await capture({ tools: [{ name: "echo" }] }, "legacy");
    expect(c.protocol?.era).toBe("legacy");
    expect(c.protocol?.supported).toBeUndefined();
    expect(c.cacheHints?.tools).toEqual({});
    expect(c.skills).toBeUndefined();
    expect(c.events).toBeUndefined();
  });

  it("captures skills and events through raw requests only when the extensions are advertised, and tolerates failure", async () => {
    const calls: string[] = [];
    const fake = (extensions: Record<string, unknown>, fail = false) =>
      ({
        getServerCapabilities: () => ({ extensions }),
        getServerVersion: () => ({ name: "fake", version: "1" }),
        request: async (req: { method: string }) => {
          calls.push(req.method);
          if (fail) throw new Error("boom");
          if (req.method === "skills/list")
            return { skills: [{ uri: "skill://review/SKILL.md", frontmatter: { name: "review", description: "d" }, resources: [{ uri: "skill://review/SKILL.md", digest: "sha256:aa", size: 3 }] }] };
          return { events: [{ name: "pr.opened", inputSchema: { type: "object" }, payloadSchema: { type: "object", properties: { id: { type: "string" } } }, delivery: ["poll", "push"] }] };
        },
      }) as unknown as Client;

    const none = await captureContract(fake({}));
    expect(calls).toEqual([]); // not advertised → never asked
    expect(none.skills).toBeUndefined();

    const both = await captureContract(fake({ "io.modelcontextprotocol/skills": {}, "io.modelcontextprotocol/events": {} }));
    expect(both.skills).toEqual([{ uri: "skill://review/SKILL.md", name: "review", description: "d", files: [{ uri: "skill://review/SKILL.md", digest: "sha256:aa", size: 3 }] }]);
    expect(both.events?.[0]).toMatchObject({ name: "pr.opened", delivery: ["poll", "push"] });

    const broken = await captureContract(fake({ "io.modelcontextprotocol/skills": {} }, true));
    expect(broken.skills).toBeUndefined(); // failure tolerated
  });
});

describe("upgradeContract", () => {
  it("reads a v1 contract, bumping the version and leaving v2-only fields uncaptured", () => {
    const v1 = { version: 1, server: { name: "s" }, tools: [{ name: "a", description: "x" }], resources: [], templates: [], prompts: [] };
    const c = upgradeContract(v1);
    expect(c.version).toBe(2);
    expect(c.tools[0]!.name).toBe("a");
    expect(c.extensions).toBeUndefined();
    expect(c.capabilities).toBeUndefined();
  });

  it("rejects unknown versions and non-objects with a clear error", () => {
    expect(() => upgradeContract({ version: 3, tools: [] })).toThrow(/unsupported format version 3/);
    expect(() => upgradeContract(null)).toThrow(/expected a JSON object/);
    expect(upgradeContract({ tools: [] }).version).toBe(2); // a missing version is read as v1
  });

  it("diffing a v1 pin against a live v2 capture does not report v2-only fields as changes", () => {
    const pinned = upgradeContract({ version: 1, tools: [{ name: "a" }], resources: [], templates: [], prompts: [] });
    const live = base({ tools: [{ name: "a", title: "A" }], capabilities: { tools: {} }, extensions: { "io.x/y": { revision: "1" } }, protocol: { supported: ["2026-07-28"] } });
    expect(diffContract(pinned, live).changes).toEqual([]);
    // …and a raw v1 object is accepted directly
    expect(diffContract({ version: 1, tools: [{ name: "a" }], resources: [], templates: [], prompts: [] }, live).breaking).toBe(0);
  });
});

describe("drift classification (v2)", () => {
  it("extension removed or revision changed is breaking; added is compatible", () => {
    const prev = base({ extensions: { "io.x/a": { revision: "1" }, "io.x/b": { revision: "1" }, "io.x/c": {} } });
    const next = base({ extensions: { "io.x/a": { revision: "2" }, "io.x/c": {}, "io.x/d": { revision: "1" } } });
    const d = diffContract(prev, next);
    expect(find(d, "extension", "io.x/a")[0]).toMatchObject({ level: "breaking", detail: "revision 1 → 2" });
    expect(find(d, "extension", "io.x/b")[0]).toMatchObject({ level: "breaking", detail: "extension removed" });
    expect(find(d, "extension", "io.x/d")[0]).toMatchObject({ level: "compatible", detail: "extension added" });
    expect(find(d, "extension", "io.x/c")).toEqual([]);
    expect(d.breaking).toBe(2);
  });

  it("a revision appearing where none was pinned is compatible; a pinned revision disappearing is breaking", () => {
    const d1 = diffContract(base({ extensions: { "io.x/a": {} } }), base({ extensions: { "io.x/a": { revision: "1" } } }));
    expect(d1.breaking).toBe(0);
    const d2 = diffContract(base({ extensions: { "io.x/a": { revision: "1" } } }), base({ extensions: { "io.x/a": {} } }));
    expect(d2.breaking).toBe(1);
  });

  it("a protocol version dropped is breaking; one added is compatible", () => {
    const d = diffContract(base({ protocol: { supported: ["2025-11-25", "2026-07-28"] } }), base({ protocol: { supported: ["2026-07-28", "2027-03-30"] } }));
    expect(find(d, "protocol", "2025-11-25")[0]!.level).toBe("breaking");
    expect(find(d, "protocol", "2027-03-30")[0]!.level).toBe("compatible");
  });

  it("capability removal and listChanged loss are breaking; additions compatible", () => {
    const d = diffContract(
      base({ capabilities: { tools: { listChanged: true }, prompts: {} } }),
      base({ capabilities: { tools: {}, resources: { subscribe: true } } }),
    );
    expect(find(d, "capability", "prompts")[0]!.level).toBe("breaking");
    expect(find(d, "capability", "tools.listChanged")[0]!.level).toBe("breaking");
    expect(find(d, "capability", "resources")[0]!.level).toBe("compatible");
  });

  it("tool title/icon/_meta changes are compatible and only compared when pinned", () => {
    const d = diffContract(base({ tools: [{ name: "t", title: "Old", _meta: { a: 1 } }] }), base({ tools: [{ name: "t", title: "New", _meta: { a: 2 } }] }));
    expect(d.breaking).toBe(0);
    expect(d.compatible).toBe(2);
  });

  it("skill digest changes are content drift (new class), not breaking; a removed skill is breaking", () => {
    const skill = (digest: string) => ({ uri: "skill://r/SKILL.md", files: [{ uri: "skill://r/SKILL.md", digest }] });
    const d = diffContract(base({ skills: [skill("sha256:a"), { uri: "skill://gone/SKILL.md" }] }), base({ skills: [skill("sha256:b")] }));
    expect(find(d, "skill", "skill://r/SKILL.md")[0]).toMatchObject({ level: "drift", detail: "content changed: skill://r/SKILL.md" });
    expect(find(d, "skill", "skill://gone/SKILL.md")[0]!.level).toBe("breaking");
    expect(d.drift).toBe(1);
    expect(formatDiff(d)).toContain("≈ drift");
    expect(formatDiff(diffContract(base({ skills: [skill("sha256:a")] }), base({ skills: [skill("sha256:b")] })))).toContain("1 content drift");
  });

  it("event payloadSchema narrowing is breaking for consumers; delivery mode removal is breaking", () => {
    const ev = (payload: object, delivery: string[]) => ({ name: "e", payloadSchema: payload as never, delivery });
    const wide = { type: "object", properties: { id: { type: "string" }, extra: { type: "string" } } };
    const narrow = { type: "object", properties: { id: { type: "string" } } };
    const d = diffContract(base({ events: [ev(wide, ["poll", "push"])] }), base({ events: [ev(narrow, ["poll"])] }));
    expect(d.changes.filter((c) => c.category === "event" && c.level === "breaking").map((c) => c.detail)).toEqual(
      expect.arrayContaining(['payload properties.extra: property removed', 'delivery mode "push" removed']),
    );
    // widening the payload (adding a produced field) is compatible
    expect(diffContract(base({ events: [ev(narrow, ["poll"])] }), base({ events: [ev(wide, ["poll"])] })).breaking).toBe(0);
  });

  it("`used` scoping still narrows tool changes but never hides extension/protocol breaks", () => {
    const prev = base({ tools: [{ name: "other", description: "a" }, { name: "mine" }], extensions: { "io.x/a": {} } });
    const next = base({ tools: [{ name: "mine" }], extensions: {} });
    const d = diffContract(prev, next, { used: ["mine"] });
    expect(find(d, "tool", "other")).toEqual([]);
    expect(find(d, "extension", "io.x/a")[0]!.level).toBe("breaking");
  });
});

describe("schema diffing tolerates non-object schemas (SEP-2106)", () => {
  it("does not throw on boolean, null, array or primitive schemas and classifies boolean widening/narrowing", () => {
    const junk: unknown[] = [true, false, null, "string", 7, [], { type: "object", properties: "oops", required: 5, enum: "x" }];
    for (const a of junk) for (const b of junk) {
      expect(() => diffSchema(a as never, b as never, "out")).not.toThrow();
      expect(() => diffSchema(a as never, b as never, "in")).not.toThrow();
    }
    expect(diffSchema(true as never, { type: "string" }, "out")[0]).toMatchObject({ level: "compatible" }); // produces less than anything: narrower
    expect(diffSchema({ type: "string" }, true as never, "out")[0]).toMatchObject({ level: "breaking" }); // may now produce anything
    expect(diffSchema(true as never, { type: "string" }, "in")[0]).toMatchObject({ level: "breaking" }); // accepts less
    expect(diffSchema(false as never, true as never, "in")[0]).toMatchObject({ level: "compatible" });
  });

  it("diffContract survives a non-object outputSchema and a tuple/boolean `items`", () => {
    const t = (outputSchema: unknown) => base({ tools: [{ name: "t", outputSchema: outputSchema as never }] });
    expect(() => diffContract(t(true), t({ type: "array", items: [{ type: "string" }] }))).not.toThrow();
    expect(() => diffContract(t({ type: "array", items: true }), t({ type: "array", items: { type: "string" } }))).not.toThrow();
    expect(() => diffContract(t(null), t({ type: "string" }))).not.toThrow();
    // a primitive/array root outputSchema is diffed normally
    expect(diffContract(t({ type: "string" }), t({ type: "number" })).breaking).toBe(1);
  });
});
