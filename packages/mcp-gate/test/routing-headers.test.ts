import { describe, it, expect, afterEach } from "vitest";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGate, type Gate } from "../src/index.js";

// SEP-2243 routing headers at the gate: a request whose Mcp-Method / Mcp-Name / Mcp-Param-* headers
// disagree with its body is refused with HeaderMismatch (-32020); policy, rate limit and audit read
// the routing facts of the BODY (`context.routing`), never a header.

const V = "2026-07-28";
let gate: Gate | undefined;
let handler: ReturnType<Gate["handler"]> | undefined;
afterEach(async () => {
  await handler?.close();
  await gate?.close();
  gate = handler = undefined;
});

const TOOL = {
  name: "query",
  inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
  handler: () => ({ content: [{ type: "text", text: "ok" }] }),
};

async function open(config: Partial<Parameters<typeof createGate>[0]> = {}) {
  const up = new MockMCPServer({ tools: [TOOL, { name: "other", handler: () => ({ content: [] }) }] });
  gate = await createGate({ upstreams: { up: { transport: up.transport, versions: [V] } }, ...config });
  handler = gate.handler();
  const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const res = await handler!.fetch(
      new Request("http://gate.local/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": name, ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientCapabilities": {} } } }),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call };
}

describe("routing headers at the gate", () => {
  it("answers HeaderMismatch (400, -32020) for a lying Mcp-Name or Mcp-Param, and the tool never runs", async () => {
    const seen: string[] = [];
    const { call } = await open({ policy: (req) => (req.kind === "call" && seen.push(req.target), "allow") });
    const wrongName = await call("up.query", {}, { "mcp-name": "up.other" });
    expect([wrongName.status, wrongName.body.error.code]).toEqual([400, -32020]);
    const wrongParam = await call("up.query", { region: "us" }, { "mcp-param-region": "eu" });
    expect([wrongParam.status, wrongParam.body.error.code]).toEqual([400, -32020]);
    const missingParam = await call("up.query", { region: "us" });
    expect([missingParam.status, missingParam.body.error.code]).toEqual([400, -32020]);
    expect(seen).toEqual([]);
    expect((await call("up.query", { region: "us" }, { "mcp-param-region": "us" })).status).toBe(200);
    expect(seen).toEqual(["query"]);
  });

  it("gives a function policy and the audit trail the method, name and x-mcp-header values of the body", async () => {
    const routing: unknown[] = [];
    const audit: any[] = [];
    const { call } = await open({
      policy: (req) => (req.kind === "call" && routing.push(req.context?.routing), "allow"),
      audit: (e) => audit.push(e),
    });
    await call("up.query", { region: "us" }, { "mcp-param-region": "us" });
    const expected = { method: "tools/call", name: "up.query", params: { Region: "us" } };
    expect(routing).toEqual([expected]);
    expect(audit.find((e) => e.kind === "call")?.routing).toEqual(expected);
  });

  it("lets a rateLimit.keyFn bucket by routing facts", async () => {
    const keys: string[] = [];
    const { call } = await open({
      rateLimit: { concurrency: 2, keyFn: (op) => (keys.push(`${op.context?.routing?.method}|${op.context?.routing?.name}`), op.peer) },
    });
    await call("up.other", {});
    expect(keys).toContain("tools/call|up.other");
  });

  it("validates rateLimit.keyFn as a function", async () => {
    const { validateGateConfig } = await import("../src/validate.js");
    expect(() => validateGateConfig({ upstreams: {}, rateLimit: { keyFn: 3 } })).toThrow(/keyFn/);
    expect(() => validateGateConfig({ upstreams: {}, rateLimit: { keyFn: () => "k" } })).not.toThrow();
  });
});
