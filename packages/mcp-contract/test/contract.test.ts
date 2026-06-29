import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockMCPServer, type MockSpec } from "../../../src/testing/mockServer.js";
import { captureContract, diffContract } from "../src/contract.js";
import { diffSchema } from "../src/schema.js";
import { mockFromContract } from "../src/mock.js";
import { usedFromSource } from "../src/used.js";

async function capture(spec: MockSpec) {
  const mock = new MockMCPServer(spec);
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(mock.transport());
  const contract = await captureContract(client);
  await client.close();
  return contract;
}

// test factory — returns `any` so it satisfies both JSONSchema (diffSchema) and the mock's input schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const obj = (props: Record<string, unknown>, required: string[] = []): any => ({ type: "object", properties: props, required });

describe("schema variance engine", () => {
  it("input is contravariant: new required arg & enum-narrowing break callers", () => {
    const inA = diffSchema(obj({ msg: { type: "string" } }), obj({ msg: { type: "string" } }, ["msg"]), "in");
    expect(inA.find((c) => c.detail === "became required")?.level).toBe("breaking");

    const inB = diffSchema(obj({ x: { type: "string" } }), obj({ x: { type: "string" }, y: { type: "string" } }), "in");
    expect(inB.find((c) => c.path.endsWith("y"))?.level).toBe("compatible"); // new optional arg is fine

    const inC = diffSchema({ type: "string" }, { type: "string", enum: ["a", "b"] }, "in");
    expect(inC[0]!.level).toBe("breaking"); // narrowing accepted set
  });

  it("output is covariant: dropping a produced field & widening break consumers", () => {
    const outA = diffSchema(obj({ id: { type: "string" } }), obj({}), "out");
    expect(outA.find((c) => c.path.endsWith("id"))?.level).toBe("breaking"); // removed output field

    const outB = diffSchema({ type: "integer" }, { type: "number" }, "out");
    expect(outB[0]!.level).toBe("breaking"); // widening a produced value
  });
});

describe("captureContract", () => {
  it("captures tools (schema + annotations), prompts and resources", async () => {
    const c = await capture({
      tools: [{ name: "echo", inputSchema: obj({ msg: { type: "string" } }, ["msg"]), annotations: { readOnlyHint: true } }],
      resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }],
      prompts: [{ name: "greet" }],
    });
    expect(c.tools[0]).toMatchObject({ name: "echo", annotations: { readOnlyHint: true } });
    expect(c.tools[0]!.inputSchema?.required).toEqual(["msg"]);
    expect(c.resources.map((r) => r.uri)).toEqual(["file:///a"]);
    expect(c.prompts.map((p) => p.name)).toEqual(["greet"]);
  });
});

describe("diffContract", () => {
  it("classifies removals, additions, required-arg drift, and destructive flips", async () => {
    const v1 = await capture({
      tools: [
        { name: "read", inputSchema: obj({ id: { type: "string" } }) },
        { name: "gone" },
        { name: "danger" },
      ],
    });
    const v2 = await capture({
      tools: [
        { name: "read", inputSchema: obj({ id: { type: "string" } }, ["id"]) }, // id became required
        { name: "danger", annotations: { destructiveHint: true } }, // now destructive
        { name: "brand_new" }, // added
      ],
    });
    const diff = diffContract(v1, v2);
    const find = (target: string, detail?: string) =>
      diff.changes.find((c) => c.target === target && (!detail || c.detail.includes(detail)));

    expect(find("gone", "removed")?.level).toBe("breaking");
    expect(find("read", "became required")?.level).toBe("breaking");
    expect(find("danger", "destructive")?.level).toBe("breaking");
    expect(find("brand_new", "added")?.level).toBe("compatible");
    expect(diff.breaking).toBe(3);
  });

  it("consumer-driven scoping ignores drift on unused tools", async () => {
    const v1 = await capture({ tools: [{ name: "used_tool" }, { name: "other" }] });
    const v2 = await capture({ tools: [{ name: "used_tool" }] }); // both 'other' removed
    const full = diffContract(v1, v2);
    expect(full.breaking).toBe(1); // 'other' removed
    const scoped = diffContract(v1, v2, { used: ["used_tool"] });
    expect(scoped.breaking).toBe(0); // we don't use 'other', so we don't care
  });
});

describe("mockFromContract", () => {
  it("re-serves the contracted surface for consumer tests", async () => {
    const contract = await capture({
      tools: [{ name: "echo", inputSchema: obj({ msg: { type: "string" } }) }, { name: "add" }],
    });
    const mock = mockFromContract(contract);
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(mock.transport());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(["add", "echo"]);
    await client.close();
  });
});

describe("usedFromSource", () => {
  it("extracts referenced contract ids from source text", async () => {
    const contract = await capture({ tools: [{ name: "echo" }, { name: "unused_tool" }] });
    const src = `const r = await client.callTool("echo", { msg: "hi" });`;
    expect(usedFromSource(src, contract)).toEqual(["echo"]);
  });
});
