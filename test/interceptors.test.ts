import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import type { RequestInterceptor } from "../src/core/interceptors.js";
import type { CacheKey } from "../src/core/keys.js";

const echoServer = () =>
  new MockMCPServer({
    tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }],
    resources: [{ uri: "mem://a", read: () => ({ text: "A" }) }],
  });

async function clientWith(interceptors: RequestInterceptor[], mock = echoServer()) {
  const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors });
  await client.connect();
  return { client, mock };
}

describe("interceptor chain", () => {
  it("wraps the operation onion-style, in order", async () => {
    const log: string[] = [];
    const mk =
      (name: string): RequestInterceptor =>
      async (op, next) => {
        log.push(`>${name}`);
        const r = await next(op);
        log.push(`<${name}`);
        return r;
      };
    const { client } = await clientWith([mk("A"), mk("B")]);
    await client.callTool("s.echo", { msg: "hi" });
    expect(log).toEqual([">A", ">B", "<B", "<A"]);
    await client.close();
  });

  it("can short-circuit without hitting the server", async () => {
    const shortCircuit: RequestInterceptor = async (op) =>
      op.kind === "call" ? { content: [{ type: "text", text: "from-cache" }] } : undefined;
    const { client, mock } = await clientWith([shortCircuit]);
    const r = (await client.callTool("s.echo", { msg: "x" })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("from-cache");
    expect(mock.callLog).toHaveLength(0); // server never called
    await client.close();
  });

  it("can mutate args before the operation runs", async () => {
    const rewrite: RequestInterceptor = (op, next) => {
      if (op.args) op.args = { ...op.args, msg: "REWRITTEN" };
      return next(op);
    };
    const { client } = await clientWith([rewrite]);
    const r = (await client.callTool("s.echo", { msg: "orig" })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("REWRITTEN");
    await client.close();
  });

  it("can inject context (partition) that the cache honors", async () => {
    const tenancy: RequestInterceptor = (op, next) => {
      op.context = { ...op.context, partition: "tenant-7" };
      return next(op);
    };
    const { client } = await clientWith([tenancy]);
    await client.readResource("mem://a");
    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://a", partition: "tenant-7" };
    expect(client.cache.getSnapshot(key)?.status).toBe("success");
    expect(client.cache.getSnapshot({ kind: "resource", server: "s", uri: "mem://a" })).toBeUndefined();
    await client.close();
  });

  it("observes errors (and can rethrow/transform)", async () => {
    const onError = vi.fn();
    const observer: RequestInterceptor = async (op, next) => {
      try {
        return await next(op);
      } catch (e) {
        onError(e);
        throw e;
      }
    };
    const mock = new MockMCPServer({ tools: [{ name: "boom", handler: () => { throw new Error("nope"); } }] });
    const { client } = await clientWith([observer], mock);
    await expect(client.callTool("s.boom", {})).rejects.toBeTruthy();
    expect(onError).toHaveBeenCalled();
    await client.close();
  });
});
