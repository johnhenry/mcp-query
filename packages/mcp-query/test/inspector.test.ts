import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { DevtoolsHub } from "../src/devtools/protocol.js";
import { InteractionBroker } from "../src/core/interactions.js";
import { instrumentAuthProvider } from "../src/core/authDebug.js";
import { parse, coerce } from "../src/cli/inspect.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function settleNext(broker: InteractionBroker, decision: Parameters<InteractionBroker["resolve"]>[1]) {
  for (let i = 0; i < 100; i++) {
    const [next] = broker.list();
    if (next) {
      broker.resolve(next.id, decision);
      return next;
    }
    await tick(5);
  }
  throw new Error("no interaction appeared");
}

describe("raw message log", () => {
  it("emits request/response/notification devtools events with direction", async () => {
    const hub = new DevtoolsHub();
    const mock = new MockMCPServer({
      tools: [{ name: "echo", handler: () => ({ content: [{ type: "text", text: "hi" }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, devtools: hub });
    await client.connect();
    await client.callTool("s.echo", {});

    const requests = hub.events().filter((e) => e.type === "request");
    const responses = hub.events().filter((e) => e.type === "response");
    expect(requests.some((r) => r.type === "request" && r.method === "tools/call")).toBe(true);
    expect(responses.length).toBeGreaterThan(0);
    expect(requests[0]).toHaveProperty("dir");
    await client.close();
  });

  it("does not instrument when no devtools is configured", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect(); // no throw, no tap
    await client.close();
  });

  it("subscribe is bound — safe to pass unbound to subscribe-style consumers", () => {
    const hub = new DevtoolsHub();
    // Consumers (e.g. the Inspector's Reactive.track) pass the method reference directly.
    const subscribe = hub.subscribe;
    let fired = 0;
    const unsub = subscribe(() => fired++); // must not throw on `this.subs`
    hub.emit({ type: "notification", server: "s", method: "x", dir: "in" } as never);
    expect(fired).toBe(1);
    unsub();
    hub.emit({ type: "notification", server: "s", method: "x", dir: "in" } as never);
    expect(fired).toBe(1); // unsubscribed
  });
});

describe("manual (human-as-model) sampling", () => {
  it("lets a human author the sampling result", async () => {
    const broker = new InteractionBroker({ manualSampling: true });
    const mock = new MockMCPServer({
      tools: [
        {
          name: "ask",
          handler: async (_a, ctx) => {
            const r = await ctx.sample({ messages: [{ role: "user", content: { type: "text", text: "2+2?" } }], maxTokens: 10 });
            return { content: [{ type: "text", text: r.content.text ?? "" }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interactions: broker });
    await client.connect();

    const call = client.callTool("s.ask", {}) as Promise<{ content: { text: string }[] }>;
    const interaction = await settleNext(broker, {
      action: "approve",
      editedResult: { role: "assistant", content: { type: "text", text: "4" }, model: "human", stopReason: "endTurn" },
    });
    expect(interaction.manual).toBe(true);
    const res = await call;
    expect(res.content[0]!.text).toBe("4");
    await client.close();
  });

  it("rejects when approved with no authored result", async () => {
    const broker = new InteractionBroker({ manualSampling: true });
    const p = broker.handleSampling("s", { messages: [], maxTokens: 1 });
    await settleNext(broker, { action: "approve" }); // no editedResult
    await expect(p).rejects.toThrow(/requires an authored result/);
  });
});

describe("auth debug recorder", () => {
  it("records steps and redacts secrets", async () => {
    const fakeProvider = {
      get redirectUrl() {
        return "http://localhost/cb";
      },
      async tokens() {
        return { access_token: "SECRET", refresh_token: "SECRET2" };
      },
      async saveTokens(_t: unknown) {},
      async redirectToAuthorization(url: URL) {
        return url;
      },
    };
    const steps: { member: string }[] = [];
    const wrapped = instrumentAuthProvider(fakeProvider, (s) => steps.push(s));

    void wrapped.redirectUrl; // getter read
    await wrapped.tokens();
    await wrapped.saveTokens({ access_token: "SECRET" });
    await wrapped.redirectToAuthorization(new URL("https://idp/authorize"));

    const members = wrapped.authSteps().map((s) => s.member);
    expect(members).toContain("redirectUrl");
    expect(members).toContain("tokens");
    expect(members).toContain("redirectToAuthorization");
    // saveTokens detail is redacted to presence flags, not the raw token.
    const saved = wrapped.authSteps().find((s) => s.member === "saveTokens" && s.phase === "call");
    expect(JSON.stringify(saved?.detail)).not.toContain("SECRET");
    expect(saved?.detail).toMatchObject({ hasAccessToken: true });
  });
});

describe("per-request timeout threading", () => {
  it("times out a slow call when requestOptions.timeout is small", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "slow", handler: async () => (await tick(150), { content: [{ type: "text", text: "late" }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    await expect(client.callTool("s.slow", {}, { requestOptions: { timeout: 20 } })).rejects.toBeTruthy();
    await client.close();
  });
});

describe("inspect CLI argument parsing", () => {
  it("parses flags and repeated --arg key=value pairs", () => {
    const { flags, args } = parse(["--method", "tools/call", "--tool", "echo", "--arg", "message=hi", "--arg", "n=3"]);
    expect(flags.method).toBe("tools/call");
    expect(flags.tool).toBe("echo");
    expect(args).toEqual({ message: "hi", n: "3" });
  });

  it("coerce parses JSON values but falls back to strings", () => {
    expect(coerce("3")).toBe(3);
    expect(coerce("true")).toBe(true);
    expect(coerce("hello")).toBe("hello");
  });
});
