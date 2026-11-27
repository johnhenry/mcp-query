import { describe, it, expect, afterEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { requireBearerAuth, OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGate, type Gate } from "../src/index.js";

// Fronting the gate: the host verifies the bearer token with the SDK's requireBearerAuth, hands
// the verified AuthInfo to the gate's HTTP handler, and `inboundAuth` maps it into the call
// context where `policy` and `partitionFrom` read it.

const future = () => Math.floor(Date.now() / 1000) + 3600;
const TOKENS: Record<string, AuthInfo> = {
  "tok-alice": { token: "tok-alice", clientId: "app-1", scopes: ["mcp"], expiresAt: future(), extra: { sub: "alice" } },
  "tok-bob": { token: "tok-bob", clientId: "app-1", scopes: ["mcp"], expiresAt: future(), extra: { sub: "bob" } },
};
const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = TOKENS[token];
    if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, "unknown token");
    return info;
  },
};

let gate: Gate | undefined;
let handler: ReturnType<Gate["handler"]> | undefined;
afterEach(async () => {
  await handler?.close();
  await gate?.close();
  gate = handler = undefined;
});

async function front(config: Parameters<typeof createGate>[0], requiredScopes?: string[]) {
  gate = await createGate(config);
  handler = gate.handler();
  const guard = requireBearerAuth({ verifier, requiredScopes });
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const auth = await guard(request);
    if (auth instanceof Response) return auth; // 401 / 403 challenge, built by the SDK
    return handler!.fetch(request, { authInfo: auth });
  };
  const connect = async (token?: string) => {
    const client = new Client({ name: "consumer", version: "1" }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://gate.local/mcp"), {
        fetch: fetchImpl,
        ...(token ? { authProvider: { token: async () => token } } : {}),
      }),
    );
    return client;
  };
  return { connect };
}

const upstream = () =>
  new MockMCPServer({ tools: [{ name: "echo", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "pong" }] }) }] });

describe("inbound bearer auth in front of the gate", () => {
  it("maps the verified principal into policy, partitionFrom and the audit trail", async () => {
    const audit: { principal?: unknown; outcome: string }[] = [];
    const partitions: (string | undefined)[] = [];
    const { connect } = await front({
      upstreams: { up: { transport: upstream().transport } },
      inboundAuth: true,
      // The policy reads the VERIFIED principal.
      policy: (req) => {
        const m = req.context?.meta as { principal?: string } | undefined;
        return m?.principal === "alice" || req.kind === "list" ? "allow" : "deny";
      },
      partitionFrom: (meta) => {
        const p = (meta as { principal?: string } | undefined)?.principal;
        partitions.push(p);
        return p;
      },
      audit: (e) => audit.push(e as never),
    });

    const alice = await connect("tok-alice");
    const ok = (await alice.callTool({ name: "up.echo", arguments: {} })) as { content: { text: string }[] };
    expect(ok.content[0]!.text).toBe("pong");
    expect(audit.find((e) => e.outcome === "ok" && e.principal === "alice")).toBeTruthy();
    expect(partitions).toContain("alice");

    const bob = await connect("tok-bob");
    await expect(bob.callTool({ name: "up.echo", arguments: {} })).rejects.toThrow(/denied/i);
    expect(audit.some((e) => e.principal === "bob")).toBe(true);
    await alice.close();
    await bob.close();
  });

  it("a caller cannot claim another principal in its own _meta", async () => {
    const seen: unknown[] = [];
    const { connect } = await front({
      upstreams: { up: { transport: upstream().transport } },
      inboundAuth: true,
      audit: (e) => seen.push((e as { principal?: unknown }).principal),
    });
    const bob = await connect("tok-bob");
    await bob.callTool({ name: "up.echo", arguments: {}, _meta: { principal: "alice", authScopes: ["admin"] } });
    expect(seen).toContain("bob");
    expect(seen).not.toContain("alice");
    await bob.close();
  });

  it("requireBearerAuth refuses an unknown token and a missing one before the gate sees anything", async () => {
    const audit: unknown[] = [];
    const { connect } = await front({ upstreams: { up: { transport: upstream().transport } }, inboundAuth: { required: true }, audit: (e) => audit.push(e) });
    audit.length = 0; // discard the gate's own startup listing
    await expect(connect("tok-nobody")).rejects.toBeTruthy();
    await expect(connect()).rejects.toBeTruthy();
    expect(audit).toHaveLength(0);
  });

  it("requiredScopes are enforced by the SDK guard (403 insufficient_scope)", async () => {
    const { connect } = await front({ upstreams: { up: { transport: upstream().transport } }, inboundAuth: true, audit: () => {} }, ["admin"]);
    await expect(connect("tok-alice")).rejects.toBeTruthy();
  });

  it("without inboundAuth the verified principal is not mapped (opt-in)", async () => {
    const seen: unknown[] = [];
    const { connect } = await front({ upstreams: { up: { transport: upstream().transport } }, audit: (e) => seen.push((e as { principal?: unknown }).principal) });
    const alice = await connect("tok-alice");
    await alice.callTool({ name: "up.echo", arguments: {} });
    expect(seen).not.toContain("alice");
    await alice.close();
  });
});
