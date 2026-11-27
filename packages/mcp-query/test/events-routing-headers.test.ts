// What a strict Streamable HTTP server sees from the events client and from raw request()s that
// have no typed API (events, skills, gateway extension pass-through), over the SDK's real
// Streamable HTTP client transport against an in-process SDK HTTP handler. SEP-2243 / SEP-3415 / SEP-2663.

import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { MCPClient } from "../src/core/client.js";
import { sdkSupportsModernTasks } from "../src/core/tasksProbe.js";
import { createGatewayHandler } from "../src/server/gateway.js";
import { httpUpstream } from "./support/httpUpstream.js";

const V = "2026-07-28";
const EVENTS = "io.modelcontextprotocol/events";
const REGION_SCHEMA = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } };
const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  while (closers.length) await Promise.resolve(closers.pop()!()).catch(() => {});
});
async function until(cond: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function connect(spec: Parameters<typeof httpUpstream>[0]) {
  const up = httpUpstream(spec);
  const client = new MCPClient({ servers: { s: { transport: up.transport, versions: [V], maxRetries: 0 } } });
  await client.connect();
  closers.push(async () => {
    await client.close();
    await up.close();
  });
  return { up, client };
}
const fast = { pollFloorMs: 0, retry: { baseMs: 10, maxMs: 40 } };

describe("raw request() on a 2026-07-28 HTTP connection", () => {
  it("sets Mcp-Method for methods outside the SDK registry (events/*), and Mcp-Name only where the extension defines it", async () => {
    const { up, client } = await connect({ events: [{ name: "incident.created" }] });
    await client.listEvents("s");
    const sub = client.events("s", "incident.created", {}, fast);
    closers.push(() => sub.close());
    await until(() => up.calls("events/poll").length > 0, "a poll");
    const list = up.calls("events/list")[0]!.headers;
    expect(list["mcp-method"]).toBe("events/list");
    expect(list).not.toHaveProperty("mcp-name"); // events/list has no params.name (SEP-3415)
    const poll = up.calls("events/poll")[0]!.headers;
    expect(poll).toMatchObject({ "mcp-method": "events/poll", "mcp-protocol-version": V });
    // Mcp-Name for events/* (SEP-3415) is set by SDK 2.0.0's transport (it copies any params.name) but NOT by
    // >= 2.3, whose name table lacks events/*, and `mcp-name` is reserved in per-request headers: through the
    // public API mcp-query cannot add it there. Whatever is sent must be right.
    expect([undefined, "incident.created"]).toContain(poll["mcp-name"]);
    expect(up.calls("events/poll")[0]!.status).toBe(200);
  });

  it("the SDK's own transport sets Mcp-Method on the skills methods too", async () => {
    // skills/list over the same raw path: the connection's SDK client, no typed API in the SDK.
    const { up, client } = await connect({});
    const sdk = client.connection("s")!.sdk;
    await sdk.request({ method: "skills/list", params: {} } as never, z.looseObject({}) as never).catch(() => {});
    expect(up.calls("skills/list")[0]!.headers).toMatchObject({ "mcp-method": "skills/list", "mcp-protocol-version": V });
  });

  it("tasks/get carries Mcp-Name = taskId (SDK >= 2.3; the SDK blocks tasks/* before the wire on 2.0.0, where this is a no-op)", async () => {
    const { up, client } = await connect({});
    if (!(await sdkSupportsModernTasks(client.connection("s")!.sdk as never))) return expect(up.calls("tasks/get")).toHaveLength(0);
    await client.connection("s")!.sdk.request({ method: "tasks/get", params: { taskId: "t-1" } } as never, z.looseObject({}) as never).catch(() => {});
    expect(up.calls("tasks/get")[0]!.headers).toMatchObject({ "mcp-method": "tasks/get", "mcp-name": "t-1" });
  });
});

describe("events client: Mcp-Param-* from the event type's x-mcp-header annotations (SEP-3415)", () => {
  it("sends Mcp-Param-{Name} on events/poll", async () => {
    const { up, client } = await connect({ events: [{ name: "incident.created", inputSchema: REGION_SCHEMA }] });
    const sub = client.events("s", "incident.created", { region: "us-west1" }, fast);
    closers.push(() => sub.close());
    await until(() => up.calls("events/poll").length > 0, "a poll");
    const h = up.calls("events/poll")[0]!.headers;
    expect(h).toMatchObject({ "mcp-method": "events/poll", "mcp-param-region": "us-west1" });
    expect([undefined, "incident.created"]).toContain(h["mcp-name"]); // see above
  });

  it("encodes a value that is not plain ASCII, and omits the header when the argument is absent", async () => {
    const { up, client } = await connect({ events: [{ name: "e", inputSchema: REGION_SCHEMA }] });
    const a = client.events("s", "e", { region: "Zürich" }, fast);
    closers.push(() => a.close());
    await until(() => up.calls("events/poll").length > 0, "a poll");
    expect(up.calls("events/poll")[0]!.headers["mcp-param-region"]).toBe("=?base64?WsO8cmljaA==?=");
    a.close();
    up.wire.length = 0;
    const b = client.events("s", "e", {}, fast);
    closers.push(() => b.close());
    await until(() => up.calls("events/poll").length > 0, "a poll");
    expect(up.calls("events/poll")[0]!.headers).not.toHaveProperty("mcp-param-region");
  });

  it("after a HeaderMismatch re-reads events/list and retries with the headers the current schema calls for", async () => {
    const spec = { events: [{ name: "e", inputSchema: { type: "object", properties: { region: { type: "string" } } } as Record<string, unknown> }], requireParamHeader: undefined as string | undefined };
    const { up, client } = await connect(spec);
    const sub = client.events("s", "e", { region: "us" }, fast);
    closers.push(() => sub.close());
    await until(() => up.calls("events/poll").length > 0, "the first poll");
    expect(up.calls("events/poll")[0]!.headers).not.toHaveProperty("mcp-param-region");
    // The server starts mirroring `region` into a header and demands it.
    spec.events[0]!.inputSchema = REGION_SCHEMA;
    spec.requireParamHeader = "mcp-param-region";
    await until(() => up.calls("events/poll").some((w) => w.headers["mcp-param-region"] === "us" && w.status === 200), "a poll with the header");
    expect(up.calls("events/list").length).toBeGreaterThanOrEqual(2); // re-listed
    expect(sub.getSnapshot().status).not.toBe("error");
  });
});

describe("gateway pass-through of events/*: Mcp-Param-* both ways", () => {
  async function gate(spec: Parameters<typeof httpUpstream>[0]) {
    const { up, client } = await connect(spec);
    const h = createGatewayHandler(client, { extensions: { passthrough: { [EVENTS]: { methods: ["events/list", "events/poll"] } } } });
    closers.push(() => h.close());
    return { up, h };
  }
  const poll = (h: { fetch: (r: Request) => Promise<Response> }, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
    h
      .fetch(
        new Request("http://gw.local/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": V, "mcp-method": "events/poll", "mcp-name": "e", ...headers },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "events/poll",
            params: { name: "e", arguments: args, cursor: null, _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientCapabilities": { extensions: { [EVENTS]: {} } } } },
          }),
        }),
      )
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => undefined) }));

  it("forwards the consumer's event poll upstream with the Mcp-Param header its schema calls for", async () => {
    const { up, h } = await gate({ events: [{ name: "e", inputSchema: REGION_SCHEMA }] });
    const r = await poll(h, { region: "eu-1" }, { "mcp-param-region": "eu-1" });
    expect(r.body.result.cursor).toBe("c1");
    expect(up.calls("events/poll")[0]!.headers).toMatchObject({ "mcp-method": "events/poll", "mcp-param-region": "eu-1" });
    expect([undefined, "e"]).toContain(up.calls("events/poll")[0]!.headers["mcp-name"]);
  });

  it("answers HeaderMismatch when the consumer's Mcp-Param header disagrees with its arguments", async () => {
    const { up, h } = await gate({ events: [{ name: "e", inputSchema: REGION_SCHEMA }] });
    const r = await poll(h, { region: "eu-1" }, { "mcp-param-region": "us-1" });
    expect(r.body.error.code).toBe(-32020);
    expect(up.calls("events/poll")).toHaveLength(0);
  });
});
