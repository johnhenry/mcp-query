import { describe, it, expect, vi } from "vitest";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { MCPClient } from "../src/core/client.js";
import { MCPError } from "../src/core/types.js";
import { x402Interceptor, X402ChallengeError } from "../src/server/x402Interceptor.js";
import { parseX402Challenge, type X402Challenge } from "../src/server/x402.js";
import type { Operation } from "../src/core/interceptors.js";

const CHALLENGE: X402Challenge = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "10000",
      payTo: "0xabc",
      asset: "0xdef",
      maxTimeoutSeconds: 60,
    },
  ],
};

// Matches what MCPClient's own execCall/toError() actually produce for a genuine
// 402 SdkHttpError — MCPClient wraps the raw SdkHttpError into an MCPError
// (kind: "transport", data: {sdkCode, status, cause}) INSIDE execCall, before it
// ever reaches an interceptor's next() catch, so interceptors never see a raw
// SdkHttpError. See the real-HTTP integration tests below for end-to-end proof.
function httpError402(body: X402Challenge | string = CHALLENGE): MCPError {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new MCPError("transport", `Error POSTing to endpoint: ${text}`, "s", undefined, {
    sdkCode: "CLIENT_HTTP_NOT_IMPLEMENTED",
    status: 402,
    cause: { status: 402, statusText: "Payment Required", text },
  });
}

function makeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    kind: "call",
    peer: "s",
    target: "paid-tool",
    args: {},
    state: {},
    ...overrides,
  };
}

describe("parseX402Challenge", () => {
  it("parses a well-formed challenge", () => {
    expect(parseX402Challenge(JSON.stringify(CHALLENGE))).toEqual(CHALLENGE);
  });

  it("returns undefined for a non-x402 body", () => {
    expect(parseX402Challenge(JSON.stringify({ message: "not payment related" }))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseX402Challenge("not json{{{")).toBeUndefined();
  });

  it("returns undefined for undefined/empty body", () => {
    expect(parseX402Challenge(undefined)).toBeUndefined();
    expect(parseX402Challenge("")).toBeUndefined();
  });
});

describe("x402Interceptor", () => {
  it("is a pure passthrough when disabled", async () => {
    const next = vi.fn(async () => "ok");
    const interceptor = x402Interceptor({ enabled: false });
    await expect(interceptor(makeOp(), next)).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("throws X402ChallengeError when no gate is configured", async () => {
    const next = vi.fn(async () => {
      throw httpError402();
    });
    const interceptor = x402Interceptor({ enabled: true });
    const op = makeOp();
    await expect(interceptor(op, next)).rejects.toBeInstanceOf(X402ChallengeError);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("throws X402ChallengeError when gate() returns deny", async () => {
    const next = vi.fn(async () => {
      throw httpError402();
    });
    const interceptor = x402Interceptor({ enabled: true, gate: async () => "deny" });
    await expect(interceptor(makeOp(), next)).rejects.toBeInstanceOf(X402ChallengeError);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("gate() 'pay' on an idempotent (read) op retries once and resolves on success", async () => {
    let calls = 0;
    const next = vi.fn(async () => {
      calls++;
      if (calls === 1) throw httpError402();
      return "paid result";
    });
    const interceptor = x402Interceptor({ enabled: true, gate: async () => "pay" });
    const op = makeOp({ kind: "read" });
    await expect(interceptor(op, next)).resolves.toBe("paid result");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("gate() 'pay' on a tool with readOnlyHint retries once", async () => {
    let calls = 0;
    const next = vi.fn(async () => {
      calls++;
      if (calls === 1) throw httpError402();
      return "paid result";
    });
    const interceptor = x402Interceptor({ enabled: true, gate: async () => "pay" });
    const op = makeOp({ def: { name: "paid-tool", annotations: { readOnlyHint: true } } as never });
    await expect(interceptor(op, next)).resolves.toBe("paid result");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("a second consecutive 402 after a paid retry throws (no loop)", async () => {
    const next = vi.fn(async () => {
      throw httpError402();
    });
    const interceptor = x402Interceptor({ enabled: true, gate: async () => "pay" });
    const op = makeOp({ kind: "read" });
    await expect(interceptor(op, next)).rejects.toBeInstanceOf(X402ChallengeError);
    expect(next).toHaveBeenCalledTimes(2); // initial + exactly one retry, never a third call
  });

  it("gate() 'pay' on a non-idempotent op throws WITHOUT retrying (avoids replaying a side effect)", async () => {
    const next = vi.fn(async () => {
      throw httpError402();
    });
    const interceptor = x402Interceptor({ enabled: true, gate: async () => "pay" });
    const op = makeOp({ kind: "call" }); // no readOnlyHint — not idempotent
    const err = await interceptor(op, next).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402ChallengeError);
    expect((err as X402ChallengeError).nonIdempotent).toBe(true);
    expect(next).toHaveBeenCalledTimes(1); // never retried
  });

  it("rethrows the original error unchanged when the 402 body isn't x402-shaped", async () => {
    const original = httpError402("not an x402 challenge");
    const next = vi.fn(async () => {
      throw original;
    });
    const interceptor = x402Interceptor({ enabled: true, gate: async () => "pay" });
    await expect(interceptor(makeOp(), next)).rejects.toBe(original);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passes through non-402 errors untouched", async () => {
    const original = new Error("some other failure");
    const next = vi.fn(async () => {
      throw original;
    });
    const interceptor = x402Interceptor({ enabled: true, gate: async () => "pay" });
    await expect(interceptor(makeOp(), next)).rejects.toBe(original);
  });
});

// Real-HTTP integration: a genuine SdkHttpError produced by StreamableHTTPClientTransport
// parsing an actual (fabricated, in-process) 402 Response — not a hand-built error — routed
// through a real MCPClient's interceptor chain.
describe("x402Interceptor (real HTTP integration)", () => {
  it("intercepts a genuine 402 from the wire and retries transparently once paid", async () => {
    const server = new Server({ name: "paid-server", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "paid-tool", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
    }));
    server.setRequestHandler("tools/call", () => ({ content: [{ type: "text", text: "paid ok" }] }));
    const handler = createMcpHandler(() => server, {});

    let toolCalls = 0;
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.method === "tools/call" && body?.params?.name === "paid-tool") {
        toolCalls++;
        if (toolCalls === 1) {
          return new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } });
        }
      }
      return handler.fetch(new Request(url, init));
    };

    const client = new MCPClient({
      servers: {
        s: {
          transport: () => new StreamableHTTPClientTransport(new URL("http://x402.local/mcp"), { fetch: fetchImpl }),
        },
      },
      interceptors: [x402Interceptor({ enabled: true, gate: async () => "pay" })],
    });
    await client.connect();

    const result = (await client.callTool("s.paid-tool", {})) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe("paid ok");
    expect(toolCalls).toBe(2); // one 402, one paid retry

    await client.close();
    await handler.close();
  });

  it("surfaces X402ChallengeError for a genuine 402 with no gate configured", async () => {
    const server = new Server({ name: "paid-server", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "paid-tool", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler("tools/call", () => ({ content: [{ type: "text", text: "should not reach here" }] }));
    const handler = createMcpHandler(() => server, {});

    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.method === "tools/call" && body?.params?.name === "paid-tool") {
        return new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } });
      }
      return handler.fetch(new Request(url, init));
    };

    const client = new MCPClient({
      servers: {
        s: {
          transport: () => new StreamableHTTPClientTransport(new URL("http://x402.local/mcp"), { fetch: fetchImpl }),
        },
      },
      interceptors: [x402Interceptor({ enabled: true })],
    });
    await client.connect();

    await expect(client.callTool("s.paid-tool", {})).rejects.toBeInstanceOf(X402ChallengeError);

    await client.close();
    await handler.close();
  });
});
