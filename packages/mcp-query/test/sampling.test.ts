import { describe, it, expect, vi } from "vitest";
import {
  chromeBuiltinAISampling,
  ModelUnavailableError,
  SamplingDeclinedError,
  type LanguageModelLike,
} from "../src/handlers/chromeAI.js";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

// A fake Prompt API that echoes how the request was mapped onto a session.
function fakeLM(over: Partial<LanguageModelLike> = {}): LanguageModelLike {
  return {
    availability: async () => "available",
    create: async (o) => ({
      prompt: async (input) =>
        `OUT[init=${(o.initialPrompts ?? []).map((p) => `${p.role}:${p.content}`).join("|")}][in=${input}]`,
      destroy: () => {},
    }),
    ...over,
  };
}

const msg = (text: string, role: "user" | "assistant" = "user") =>
  ({ role, content: { type: "text", text } }) as const;

describe("chromeBuiltinAISampling — unit", () => {
  it("maps system + history into initialPrompts and the last turn into prompt()", async () => {
    const handler = chromeBuiltinAISampling({ languageModel: fakeLM() });
    const res = await handler({
      systemPrompt: "be terse",
      messages: [msg("prior", "assistant"), msg("summarize this")],
      maxTokens: 100,
    });
    expect(res.role).toBe("assistant");
    expect(res.model).toBe("gemini-nano");
    expect(res.content.text).toContain("system:be terse");
    expect(res.content.text).toContain("assistant:prior");
    expect(res.content.text).toContain("in=summarize this");
  });

  it("throws ModelUnavailableError when no LanguageModel is present", async () => {
    const handler = chromeBuiltinAISampling(); // no injection, no browser global
    await expect(handler({ messages: [msg("hi")], maxTokens: 10 })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
  });

  it("throws when the model reports unavailable", async () => {
    const handler = chromeBuiltinAISampling({
      languageModel: fakeLM({ availability: async () => "unavailable" }),
    });
    await expect(handler({ messages: [msg("hi")], maxTokens: 10 })).rejects.toThrow(/unavailable/);
  });

  it("declines via the human-in-the-loop gate", async () => {
    const approve = vi.fn().mockResolvedValue(false);
    const handler = chromeBuiltinAISampling({ languageModel: fakeLM(), approve });
    await expect(handler({ messages: [msg("hi")], maxTokens: 10 })).rejects.toBeInstanceOf(
      SamplingDeclinedError,
    );
    expect(approve).toHaveBeenCalledOnce();
  });

  it("declines requests over the on-device token ceiling", async () => {
    const handler = chromeBuiltinAISampling({ languageModel: fakeLM(), maxTokensCeiling: 50 });
    await expect(handler({ messages: [msg("hi")], maxTokens: 4096 })).rejects.toThrow(/ceiling/);
  });

  it("destroys the session after use", async () => {
    const destroy = vi.fn();
    const lm = fakeLM({
      create: async () => ({ prompt: async () => "ok", destroy }),
    });
    const handler = chromeBuiltinAISampling({ languageModel: lm });
    await handler({ messages: [msg("hi")], maxTokens: 10 });
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("sampling round-trip through the client", () => {
  it("lets a server borrow the host model via sampling/createMessage", async () => {
    const mock = new MockMCPServer({
      tools: [
        {
          name: "summarize",
          handler: async (args, ctx) => {
            const r = await ctx.sample({
              messages: [{ role: "user", content: { type: "text", text: `summarize: ${args.text}` } }],
              maxTokens: 100,
            });
            return { content: [{ type: "text", text: r.content.text ?? "" }] };
          },
        },
      ],
    });

    const client = new MCPClient({
      servers: { srv: { transport: mock.transport } },
      handlers: { sampling: chromeBuiltinAISampling({ languageModel: fakeLM() }) },
    });
    await client.connect();

    const res = (await client.callTool("srv.summarize", { text: "hello world" })) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toContain("in=summarize: hello world");
    await client.close();
  });

  it("propagates a declined sampling request back to the server as an error", async () => {
    const mock = new MockMCPServer({
      tools: [
        {
          name: "needs_ai",
          handler: async (_args, ctx) => {
            await ctx.sample({ messages: [{ role: "user", content: { type: "text", text: "x" } }], maxTokens: 10 });
            return { content: [{ type: "text", text: "unreachable" }] };
          },
        },
      ],
    });

    const client = new MCPClient({
      servers: { srv: { transport: mock.transport } },
      handlers: { sampling: chromeBuiltinAISampling({ languageModel: fakeLM(), approve: () => false }) },
    });
    await client.connect();

    await expect(client.callTool("srv.needs_ai", {})).rejects.toBeTruthy();
    await client.close();
  });
});
