// #82 slice 1 — MRTR (input_required) pass-through at the gateway.
import { describe, it, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 }); // cold start of the first rig is slow on a loaded machine
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCPClient, type CallAuditEntry } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createGateway, createGatewayHandler, interactionModeFor, type GatewayInteractions } from "../src/server/gateway.js";

type Wire = { sent: string[]; received: string[] };
function handlerTransport(handler: { fetch: (r: Request) => Promise<Response> }, wire?: Wire) {
  return new StreamableHTTPClientTransport(new URL("http://gw.local/mcp"), {
    fetch: async (url, init) => {
      if (wire && typeof init?.body === "string") wire.sent.push(init.body);
      const res = await handler.fetch(new Request(url, init));
      if (wire) void res.clone().text().then((t) => wire.received.push(t), () => {}); // not awaited: the listen stream never ends
      return res;
    },
  });
}

const askTool = (name = "ask", extra: Record<string, unknown> = {}) => ({
  name,
  ...extra,
  handler: async (_a: Record<string, unknown>, ctx: { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> }) => {
    const r = await ctx.elicit({ message: "Pick a colour", requestedSchema: { type: "object", properties: { colour: { type: "string" } } } });
    return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content ?? null)}` }] };
  },
});
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function rig(interactions: GatewayInteractions | undefined, tools = [askTool()], opts: { consumerElicits?: boolean; audit?: CallAuditEntry[] } = {}) {
  const up = new MockMCPServer({ tools });
  const upstream = new MCPClient({
    servers: { a: { transport: up.transport } },
    versions: ["2026-07-28"],
    onCall: (e) => void opts.audit?.push(e),
  });
  await upstream.connect();
  const handler = createGatewayHandler(upstream, { interactions });
  const asked: Array<Record<string, unknown>> = [];
  const wire: Wire = { sent: [], received: [] };
  const consumer = new MCPClient({
    servers: { gw: { transport: () => handlerTransport(handler, wire) } },
    versions: ["2026-07-28"],
    ...(opts.consumerElicits === false
      ? {}
      : { handlers: { elicitation: async (req: unknown) => (asked.push(req as Record<string, unknown>), { action: "accept", content: { colour: "red" } }) } }),
  });
  await consumer.connect();
  const stop = async () => { await consumer.close(); await handler.close(); await upstream.close(); await up.close(); };
  return { up, upstream, handler, consumer, asked, wire, stop };
}

describe("interactionModeFor", () => {
  it("defaults to answer and resolves per-upstream overrides", () => {
    expect(interactionModeFor(undefined, "a")).toBe("answer");
    expect(interactionModeFor("forward", "a")).toBe("forward");
    expect(interactionModeFor({ default: "deny", upstreams: { a: "forward" } }, "a")).toBe("forward");
    expect(interactionModeFor({ default: "deny", upstreams: { a: "forward" } }, "b")).toBe("deny");
    expect(interactionModeFor({ upstreams: { a: "forward" } }, "b")).toBe("answer");
    expect(interactionModeFor({ default: "forward" }, "constructor")).toBe("forward");
  });
});

describe("gateway interactions: forward (modern consumer)", () => {
  it("the consumer answers an upstream form elicitation end to end", async () => {
    const audit: CallAuditEntry[] = [];
    const { consumer, asked, stop } = await rig("forward", [askTool()], { audit });
    const r = await consumer.callTool("gw.a.ask", {});
    expect(text(r)).toBe('accept:{"colour":"red"}');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ message: "Pick a colour" });
    // Both hops are audited: the interim round, then the retry carrying the answers.
    const phases = audit.filter((e) => e.interaction).map((e) => e.interaction!.phase);
    expect(phases).toEqual(["request", "response"]);
    expect(audit.find((e) => e.interaction?.phase === "request")!.interaction!.methods).toEqual(["elicitation/create"]);
    await stop();
  });

  it("forwards requestState byte-for-byte and routes the retry's inputResponses back", async () => {
    const { consumer, wire, stop } = await rig("forward");
    await consumer.callTool("gw.a.ask", {});
    const interim = wire.received.map((b) => b.match(/"requestState":"([^"]*)"/)?.[1]).find(Boolean);
    expect(interim).toMatch(/^replay-\d+$/); // the UPSTREAM's token, not one the gateway minted
    const retry = wire.sent.find((b) => b.includes("inputResponses"))!;
    expect(retry).toContain(`"requestState":"${interim}"`);
    await stop();
  });

  it("never caches an interim input_required result", async () => {
    const { consumer, upstream, stop } = await rig("forward", [askTool("ask", { annotations: { readOnlyHint: true } })]);
    const writes: unknown[] = [];
    const orig = upstream.cache.write.bind(upstream.cache);
    upstream.cache.write = ((key: never, value: unknown, o: never) => (writes.push(value), orig(key, value, o))) as never;
    await consumer.callTool("gw.a.ask", {});
    expect(writes.some((v) => (v as { resultType?: string })?.resultType === "input_required")).toBe(false);
    expect(writes).toHaveLength(1); // only the completed result
    expect(text(writes[0])).toBe('accept:{"colour":"red"}');
    await stop();
  });

  it("a consumer that declared no elicitation capability gets MissingRequiredClientCapability (-32021), not a hang", async () => {
    // The gateway tells the upstream the consumer's REAL capabilities, so the upstream
    // refuses to ask; -32021 here correctly describes the consumer's hop.
    const { consumer, asked, stop } = await rig("forward", [askTool()], { consumerElicits: false });
    await expect(consumer.callTool("gw.a.ask", {})).rejects.toMatchObject({ code: -32021 });
    expect(asked).toHaveLength(0);
    await stop();
  });

  it("per-upstream override: default deny, this upstream forwards", async () => {
    const { consumer, asked, stop } = await rig({ default: "deny", upstreams: { a: "forward" } });
    expect(text(await consumer.callTool("gw.a.ask", {}))).toBe('accept:{"colour":"red"}');
    expect(asked).toHaveLength(1);
    await stop();
  });
});

describe("gateway interactions: deny", () => {
  it("refuses with -32003 and never shows the consumer a question", async () => {
    const audit: CallAuditEntry[] = [];
    const { consumer, asked, stop } = await rig("deny", [askTool()], { audit });
    await expect(consumer.callTool("gw.a.ask", {})).rejects.toBeTruthy();
    expect(asked).toHaveLength(0);
    expect(audit.at(-1)!.outcome).toBe("error");
    await stop();
  });
});

describe("gateway interactions: forward to a legacy-era consumer", () => {
  it("the SDK's legacy shim carries the round as a server-initiated elicitation/create", async () => {
    const up = new MockMCPServer({ tools: [askTool()] });
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } }, versions: ["2026-07-28"] });
    await upstream.connect();
    const gateway = createGateway(upstream, { interactions: "forward" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const asked: unknown[] = [];
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    consumer.setRequestHandler("elicitation/create", async (req) => (asked.push(req.params), { action: "accept", content: { colour: "blue" } }));
    await consumer.connect(ct);
    const r = await consumer.callTool({ name: "a.ask", arguments: {} });
    expect(text(r)).toBe('accept:{"colour":"blue"}');
    expect(asked).toHaveLength(1);
    await consumer.close(); await upstream.close(); await up.close();
  });
});

describe("gateway interactions: default is unchanged", () => {
  it("answer mode: the consumer is never asked", async () => {
    const { consumer, asked, stop } = await rig(undefined);
    await consumer.callTool("gw.a.ask", {}).catch(() => {});
    expect(asked).toHaveLength(0);
    await stop();
  });
});
