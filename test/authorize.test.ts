import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { authorize, denyDestructiveUnless, AuthorizationError } from "../src/server/authorize.js";
import type { CallAuditEntry } from "../src/core/client.js";

const server = () =>
  new MockMCPServer({
    tools: [
      { name: "read_thing", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "ok" }] }) },
      { name: "delete_thing", annotations: { destructiveHint: true }, handler: () => ({ content: [{ type: "text", text: "deleted" }] }) },
    ],
    resources: [{ uri: "mem://a", read: () => ({ text: "A" }) }],
  });

describe("authorize interceptor", () => {
  it("allows or denies by policy, keyed off the principal", async () => {
    const policy = vi.fn((req: { context?: { meta?: { principal?: unknown } } }) =>
      (req.context?.meta?.principal === "admin" ? "allow" : "deny") as "allow" | "deny",
    );
    const mock = server();
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [authorize(policy)] });
    await client.connect();

    await expect(client.callTool("s.delete_thing", {}, { context: { meta: { principal: "admin" } } })).resolves.toBeTruthy();
    await expect(client.callTool("s.delete_thing", {}, { context: { meta: { principal: "guest" } } })).rejects.toBeInstanceOf(AuthorizationError);
    expect(policy).toHaveBeenCalled();
    await client.close();
  });

  it("enforces destructiveHint via denyDestructiveUnless", async () => {
    const mock = server();
    const client = new MCPClient({
      servers: { s: { transport: mock.transport } },
      interceptors: [authorize(denyDestructiveUnless((req) => req.context?.meta?.confirmed === true))],
    });
    await client.connect();

    await expect(client.callTool("s.read_thing", {})).resolves.toBeTruthy(); // read-only allowed
    await expect(client.callTool("s.delete_thing", {})).rejects.toBeInstanceOf(AuthorizationError); // destructive, no confirm
    await expect(client.callTool("s.delete_thing", {}, { context: { meta: { confirmed: true } } })).resolves.toBeTruthy();
    expect(mock.callLog.filter((c) => c.name === "delete_thing")).toHaveLength(1); // only the confirmed one hit the server
    await client.close();
  });
});

describe("durable audit (onCall)", () => {
  it("records every op with outcome + timing, distinguishing denied from error", async () => {
    const audit: CallAuditEntry[] = [];
    const mock = new MockMCPServer({
      tools: [{ name: "boom", handler: () => { throw new Error("x"); } }, { name: "delete_thing", annotations: { destructiveHint: true } }],
      resources: [{ uri: "mem://a", read: () => ({ text: "A" }) }],
    });
    const client = new MCPClient({
      servers: { s: { transport: mock.transport } },
      interceptors: [authorize((req) => (req.destructive ? "deny" : "allow"))],
      onCall: (e) => audit.push(e),
    });
    await client.connect();

    await client.readResource("mem://a", { context: { meta: { principal: "u1" } } });
    await client.callTool("s.boom", {}).catch(() => {});
    await client.callTool("s.delete_thing", {}).catch(() => {});

    const byTarget = Object.fromEntries(audit.map((e) => [e.target, e]));
    expect(byTarget["mem://a"]).toMatchObject({ kind: "read", outcome: "ok", principal: "u1" });
    expect(byTarget["boom"]).toMatchObject({ outcome: "error" });
    expect(byTarget["delete_thing"]).toMatchObject({ outcome: "denied" });
    expect(typeof byTarget["mem://a"]!.ms).toBe("number");
    await client.close();
  });
});
