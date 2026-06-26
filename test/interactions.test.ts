import { describe, it, expect, vi } from "vitest";
import { InteractionBroker } from "../src/core/interactions.js";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Echo model: returns the messages it was given so tests can assert edits/redaction.
const echoModel = async (req: unknown) => ({
  role: "assistant" as const,
  content: { type: "text" as const, text: `MODEL:${JSON.stringify((req as { messages: unknown }).messages)}` },
  model: "fake",
  stopReason: "endTurn",
});

const sreq = (text: string) => ({
  messages: [{ role: "user", content: { type: "text", text } }],
  maxTokens: 100,
});

/** Wait for the next pending interaction, then settle it. */
async function settleNext(broker: InteractionBroker, decision: Parameters<InteractionBroker["resolve"]>[1]) {
  for (let i = 0; i < 100; i++) {
    const [next] = broker.list();
    if (next) {
      broker.resolve(next.id, decision);
      return next;
    }
    await tick();
  }
  throw new Error("no interaction appeared");
}

describe("InteractionBroker — policy", () => {
  it('"allow" auto-approves sampling without queuing a human', async () => {
    const broker = new InteractionBroker({ model: echoModel, policy: () => "allow" });
    const res = await broker.handleSampling("srv", sreq("hi"));
    expect((res as { content: { text: string } }).content.text).toContain("MODEL:");
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-allow");
  });

  it('"deny" rejects sampling without queuing', async () => {
    const broker = new InteractionBroker({ model: echoModel, policy: () => "deny" });
    await expect(broker.handleSampling("srv", sreq("hi"))).rejects.toThrow(/denied/);
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-deny");
  });

  it('"ask" queues an interaction the UI must settle', async () => {
    const broker = new InteractionBroker({ model: echoModel }); // default policy = ask
    const p = broker.handleSampling("srv", sreq("hi"));
    await tick();
    expect(broker.list()).toHaveLength(1);
    expect(broker.list()[0]!.type).toBe("sampling");
    expect(broker.list()[0]!.phase).toBe("request");
    await settleNext(broker, { action: "approve" });
    await expect(p).resolves.toBeTruthy();
  });
});

describe("InteractionBroker — editing & redaction", () => {
  it("applies editedMessages before the model runs", async () => {
    const broker = new InteractionBroker({ model: echoModel });
    const p = broker.handleSampling("srv", sreq("original"));
    await settleNext(broker, {
      action: "approve",
      editedMessages: [{ role: "user", content: { type: "text", text: "REWRITTEN" } }],
    });
    const res = await p;
    expect((res as { content: { text: string } }).content.text).toContain("REWRITTEN");
    expect((res as { content: { text: string } }).content.text).not.toContain("original");
  });

  it("redacts the result in a response-review step when reviewResponses is on", async () => {
    const broker = new InteractionBroker({ model: echoModel, reviewResponses: true });
    const p = broker.handleSampling("srv", sreq("hi"));
    // 1) request approval
    await settleNext(broker, { action: "approve" });
    // 2) response review — redact
    const redacted = { role: "assistant", content: { type: "text", text: "[REDACTED]" }, model: "fake", stopReason: "endTurn" };
    await settleNext(broker, { action: "approve", editedResult: redacted });
    const res = await p;
    expect((res as { content: { text: string } }).content.text).toBe("[REDACTED]");
  });

  it("denying the response-review rejects the whole request", async () => {
    const broker = new InteractionBroker({ model: echoModel, reviewResponses: true });
    const p = broker.handleSampling("srv", sreq("hi"));
    await settleNext(broker, { action: "approve" });
    await settleNext(broker, { action: "deny" });
    await expect(p).rejects.toThrow(/response rejected/);
  });
});

describe("InteractionBroker — elicitation", () => {
  it("returns accept+content when approved", async () => {
    const broker = new InteractionBroker();
    const p = broker.handleElicitation("srv", { message: "name?", requestedSchema: {} });
    await settleNext(broker, { action: "approve", content: { name: "Ada" } });
    expect(await p).toEqual({ action: "accept", content: { name: "Ada" } });
  });

  it("returns decline when denied", async () => {
    const broker = new InteractionBroker();
    const p = broker.handleElicitation("srv", { message: "name?", requestedSchema: {} });
    await settleNext(broker, { action: "deny" });
    expect(await p).toEqual({ action: "decline" });
  });
});

describe("InteractionBroker — sampling with no model", () => {
  it("errors if a sampling request arrives but no model is configured", async () => {
    const broker = new InteractionBroker({ policy: () => "allow" });
    await expect(broker.handleSampling("srv", sreq("hi"))).rejects.toThrow(/no sampling model/);
  });
});

describe("audit log & sinks", () => {
  it("accumulates entries and forwards to sinks", async () => {
    const sink = vi.fn();
    const broker = new InteractionBroker({ model: echoModel, policy: () => "allow" });
    broker.addAuditSink(sink);
    await broker.handleSampling("a", sreq("x"));
    await broker.handleSampling("b", sreq("y"));
    expect(broker.auditLog().map((e) => e.server)).toEqual(["a", "b"]);
    expect(sink).toHaveBeenCalledTimes(2);
  });
});

describe("broker integration through the client", () => {
  it("routes a server's sampling request through the broker and back", async () => {
    const broker = new InteractionBroker({ model: echoModel });
    const mock = new MockMCPServer({
      tools: [
        {
          name: "summarize",
          handler: async (args, ctx) => {
            const r = await ctx.sample(sreq(`summarize ${args.text}`));
            return { content: [{ type: "text", text: r.content.text ?? "" }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker });
    await client.connect();

    const call = client.callTool("srv.summarize", { text: "doc" }) as Promise<{ content: { text: string }[] }>;
    await settleNext(broker, { action: "approve" });
    const res = await call;
    expect(res.content[0]!.text).toContain("summarize doc");
    await client.close();
  });

  it("routes a server's elicitation through the broker and back", async () => {
    const broker = new InteractionBroker();
    const mock = new MockMCPServer({
      tools: [
        {
          name: "ask_name",
          handler: async (_args, ctx) => {
            const r = await ctx.elicit({ message: "your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } });
            return { content: [{ type: "text", text: `hi ${(r.content as { name?: string })?.name ?? "?"}` }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker });
    await client.connect();

    const call = client.callTool("srv.ask_name", {}) as Promise<{ content: { text: string }[] }>;
    await settleNext(broker, { action: "approve", content: { name: "Grace" } });
    const res = await call;
    expect(res.content[0]!.text).toBe("hi Grace");
    await client.close();
  });

  it("a denying policy blocks the server with no human prompt", async () => {
    const broker = new InteractionBroker({ model: echoModel, policy: () => "deny" });
    const mock = new MockMCPServer({
      tools: [
        {
          name: "needs_ai",
          handler: async (_args, ctx) => {
            await ctx.sample(sreq("x"));
            return { content: [{ type: "text", text: "unreachable" }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker });
    await client.connect();
    await expect(client.callTool("srv.needs_ai", {})).rejects.toBeTruthy();
    expect(broker.list()).toHaveLength(0);
    await client.close();
  });
});
