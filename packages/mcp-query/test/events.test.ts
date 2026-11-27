// Events extension (io.modelcontextprotocol/events, SEP-3415) against MockMCPServer's events
// fixture on the modern (2026-07-28) wire. Poll delivery only. Runs on every supported SDK:
// the extension methods are outside the SDK's spec registry, so SDK 2.0.0 carries them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { MCPClient } from "../src/core/client.js";
import { MCPError } from "../src/core/types.js";
import { EVENTS_EXT, EVENTS_LIST_CHANGED } from "../src/core/eventsExt.js";
import { sdkSupportsEventMethods } from "../src/core/eventsProbe.js";
import type { Operation, RequestInterceptor } from "../src/core/interceptors.js";
import type { EventsSnapshot, EventSubscription } from "../src/core/events.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { authorize } from "../src/server/index.js";

const opened: Array<{ close(): Promise<void> }> = [];
const subs: EventSubscription[] = [];
afterEach(async () => {
  while (subs.length) subs.pop()!.close();
  while (opened.length) await opened.pop()!.close();
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

const TYPES = [
  {
    name: "incident.created",
    description: "A new incident",
    delivery: ["poll", "push"],
    inputSchema: { type: "object", properties: { severity: { type: "string" } } },
    match: (d: Record<string, unknown>, a: Record<string, unknown>) => !a.severity || d.severity === a.severity,
  },
  { name: "deploy.done" },
];

/** Fast poll cadence: the server suggests 0 and the client floor is 0, so tests do not wait. */
function setup(opts: { interceptors?: RequestInterceptor[]; era?: "both" | "legacy" | "modern"; events?: boolean; nextPollMs?: number; versions?: string[] } = {}) {
  const server = new MockMCPServer(
    opts.events === false
      ? { tools: [{ name: "t", handler: () => ({ content: [] }) }] }
      : { tools: [{ name: "t", handler: () => ({ content: [] }) }], events: { types: TYPES, nextPollMs: opts.nextPollMs ?? 0 } },
    { era: opts.era ?? "both" },
  );
  const client = new MCPClient({
    servers: { s: { transport: server.transport, versions: opts.versions ?? ["2026-07-28", "2025-11-25"], maxRetries: 0 } },
    ...(opts.interceptors ? { interceptors: opts.interceptors } : {}),
  });
  opened.push(client, server);
  return { server, client, src: server.events! };
}

const fast = { pollFloorMs: 0, retry: { baseMs: 10, maxMs: 40 } };
function open(client: MCPClient, name: string, input: Record<string, unknown> = {}, o: Parameters<MCPClient["events"]>[3] = {}) {
  const sub = client.events("s", name, input, { ...fast, ...o });
  subs.push(sub);
  return sub;
}
const snap = (s: EventSubscription): EventsSnapshot => s.getSnapshot();

describe("capability + listing", () => {
  it("connection.supports('events') follows the advertised extension", async () => {
    const a = setup();
    await a.client.connect();
    expect(a.client.connection("s")!.supports("events")).toBe(true);
    expect(a.client.connection("s")!.era).toBe("modern");

    const b = setup({ events: false });
    await b.client.connect();
    expect(b.client.connection("s")!.supports("events")).toBe(false);
  });

  it("listEvents tags each type with its server, follows pagination, and caches", async () => {
    const { server, client, src } = setup();
    server.spec.events!.listPageSize = 1;
    await client.connect();
    const types = await client.listEvents("s");
    expect(types.map((t) => [t.server, t.name, t.delivery])).toEqual([
      ["s", "incident.created", ["poll", "push"]],
      ["s", "deploy.done", ["poll"]],
    ]);
    expect(types[0]!.inputSchema).toBeTruthy();
    expect(src.listCalls).toBe(2); // two pages
    await client.listEvents("s");
    expect(src.listCalls).toBe(2); // cached
    await client.listEvents("s", { force: true });
    expect(src.listCalls).toBe(4);
  });

  it("with no server, unions the events-capable servers and skips (and reports) a failing one", async () => {
    const good = new MockMCPServer({ events: { types: TYPES } });
    const bad = new MockMCPServer({ events: { types: TYPES } });
    const none = new MockMCPServer({ tools: [{ name: "t" }] });
    const client = new MCPClient({
      servers: {
        good: { transport: good.transport, versions: ["2026-07-28"] },
        bad: { transport: bad.transport, versions: ["2026-07-28"] },
        none: { transport: none.transport, versions: ["2026-07-28"] },
      },
    });
    opened.push(client, good, bad, none);
    await client.connect();
    bad.events!.spec.types = TYPES;
    // make `bad`'s listing throw: its events/list handler reads spec.types
    (bad.events!.spec as { types: unknown }).types = null;
    const errors: string[] = [];
    const all = await client.listEvents(undefined, { onError: (s) => errors.push(s) });
    expect(all.map((t) => t.server)).toEqual(["good", "good"]);
    expect(errors).toEqual(["bad"]);
  });

  it("is scoped per partition", async () => {
    const { client, src } = setup();
    await client.connect();
    await client.scope({ partition: "a" }).listEvents("s");
    await client.scope({ partition: "b" }).listEvents("s");
    expect(src.listCalls).toBe(2);
    await client.scope({ partition: "a" }).listEvents("s");
    expect(src.listCalls).toBe(2);
  });

  it("a list_changed notification marks the cached listing stale; the next read re-fetches the new set", async () => {
    const { server, client, src } = setup();
    await client.connect();
    expect((await client.listEvents("s")).map((t) => t.name)).toEqual(["incident.created", "deploy.done"]);
    expect(src.listCalls).toBe(1);

    server.spec.events!.types = [...TYPES, { name: "late.type" }];
    const key = { kind: "eventList" as const, server: "s" };
    expect(client.cache.isStale(key)).toBe(false);
    // The mock cannot push this on a modern listen stream, so deliver it as the SDK would: through the transport.
    const transport = client.connection("s")!.sdk.transport as { onmessage?: (m: unknown) => void };
    transport.onmessage!({ jsonrpc: "2.0", method: EVENTS_LIST_CHANGED });
    await until(() => client.cache.isStale(key), "listing to be marked stale");

    expect((await client.listEvents("s")).map((t) => t.name)).toContain("late.type");
    expect(src.listCalls).toBe(2);
  });

  it("asks for eventsListChanged on the listen stream when the server advertises listChanged", async () => {
    const { client } = setup();
    await client.connect();
    const listen = client.connection("s")!.listen;
    await until(() => listen.honoredFilter !== undefined, "the listen stream to be acknowledged");
  });
});

describe("why it refuses", () => {
  it("a server without the extension: clear MCPError, nothing on the wire", async () => {
    const { client } = setup({ events: false });
    await client.connect();
    await expect(client.listEvents("s")).rejects.toThrow(/does not advertise the events extension/);
    const sub = open(client, "x");
    await sub.done;
    expect(snap(sub).status).toBe("error");
    expect(snap(sub).error).toBeInstanceOf(MCPError);
  });

  it("a 2025-era connection: names the protocol requirement", async () => {
    // Capabilities are advertised, but the connection negotiated the 2025 handshake.
    const { client } = setup({ era: "legacy", versions: ["2025-11-25"] });
    await client.connect();
    expect(client.connection("s")!.era).toBe("legacy");
    expect(client.connection("s")!.supports("events")).toBe(true);
    await expect(client.listEvents("s")).rejects.toThrow(/2026-07-28/);
  });

  it("mode 'stream' is not implemented: rejects synchronously with an MCPError that says so", async () => {
    const { client } = setup();
    await client.connect();
    expect(() => client.events("s", "incident.created", {}, { mode: "stream" })).toThrow(/events\/stream/);
    expect(() => client.events("nope", "x")).toThrow(/unknown server/);
    expect(() => client.events("s", "x", {}, { mode: "bogus" as never })).toThrow(/unknown events mode/);
  });

  it("an unknown event name ends the subscription with NotFound (-32023) before any poll", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "nope.nothing");
    await sub.done;
    expect(snap(sub).status).toBe("error");
    expect(snap(sub).error!.code).toBe(-32023);
    expect(src.polls).toHaveLength(0);
  });

  it("an event type without poll delivery ends with Unsupported (-32026)", async () => {
    const { server, client } = setup();
    server.spec.events!.types = [{ name: "push.only", delivery: ["push", "webhook"] }];
    await client.connect();
    const sub = open(client, "push.only");
    await sub.done;
    expect(snap(sub).error!.code).toBe(-32026);
    expect(snap(sub).error!.message).toMatch(/poll/);
  });

  it("the probe's failure path: an SDK that era-gates events/* is reported with the reason", async () => {
    const { client, src } = setup();
    await client.connect();
    const sdk = client.connection("s")!.sdk;
    const real = sdk.request.bind(sdk) as (...a: unknown[]) => Promise<unknown>;
    (sdk as unknown as { request: unknown }).request = (req: { method: string }, ...rest: unknown[]) => {
      if (req.method.startsWith("events/")) {
        return Promise.reject(new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Method '${req.method}' is not supported by the negotiated protocol version`));
      }
      return real(req, ...rest);
    };
    await expect(client.listEvents("s")).rejects.toThrow(/blocks io\.modelcontextprotocol\/events requests/);
    const sub = open(client, "incident.created");
    await sub.done;
    expect(snap(sub).status).toBe("error");
    expect(snap(sub).error!.message).toMatch(/Upgrade @modelcontextprotocol\/client/);
    expect(src.listCalls).toBe(0); // nothing reached the server
  });

  it("sdkSupportsEventMethods: true for the installed SDK, false only for the era-gate error, cached per client", async () => {
    const { client } = setup();
    await client.connect();
    expect(await sdkSupportsEventMethods(client.connection("s")!.sdk)).toBe(true);

    let calls = 0;
    const gated = {
      request: async () => {
        calls++;
        throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, "gated");
      },
    };
    expect(await sdkSupportsEventMethods(gated)).toBe(false);
    expect(await sdkSupportsEventMethods(gated)).toBe(false);
    expect(calls).toBe(1);
    // Any other failure (here: the aborted-signal rejection itself) means the gate let it through.
    expect(await sdkSupportsEventMethods({ request: async () => Promise.reject(new Error("aborted")) })).toBe(true);
  });
});

describe("poll subscription", () => {
  it("starts from now, delivers new events in order, and advances the cursor", async () => {
    const { client, src } = setup();
    await client.connect();
    src.emit("incident.created", { id: 0 }); // before subscribing: not delivered (null cursor = from now)
    const got: string[] = [];
    const sub = open(client, "incident.created", {}, { onEvent: (e) => got.push(e.eventId) });
    await until(() => snap(sub).status === "live", "first poll");
    expect(snap(sub).events).toEqual([]);
    expect(snap(sub).cursor).toBe(src.head());
    expect(src.polls[0]!.cursor).toBeNull();

    const a = src.emit("incident.created", { id: 1 });
    const b = src.emit("incident.created", { id: 2 });
    src.emit("deploy.done", {}); // another type: not ours
    await until(() => snap(sub).events.length === 2, "two events");
    expect(snap(sub).events.map((e) => e.eventId)).toEqual([a.eventId, b.eventId]);
    expect(got).toEqual([a.eventId, b.eventId]);
    expect(snap(sub).delivered).toBe(2);
    expect(snap(sub).cursor).toBe(src.head());
  });

  it("passes the subscription arguments, so the server filters", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created", { severity: "P1" });
    await until(() => snap(sub).status === "live", "first poll");
    src.emit("incident.created", { severity: "P3" });
    const p1 = src.emit("incident.created", { severity: "P1" });
    await until(() => snap(sub).events.length === 1, "the P1 event");
    expect(snap(sub).events[0]!.eventId).toBe(p1.eventId);
    expect(src.polls.at(-1)!.arguments).toEqual({ severity: "P1" });
  });

  it("dedupes on eventId within the subscription", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created");
    await until(() => snap(sub).status === "live", "first poll");
    src.emit("incident.created", { n: 1 }, { eventId: "evt_dup" });
    await until(() => snap(sub).delivered === 1, "first copy");
    src.emit("incident.created", { n: 1 }, { eventId: "evt_dup" }); // upstream duplicate (e.g. webhook + backfill)
    src.emit("incident.created", { n: 2 }, { eventId: "evt_next" });
    await until(() => snap(sub).delivered === 2, "the next event");
    expect(snap(sub).events.map((e) => e.eventId)).toEqual(["evt_dup", "evt_next"]);
  });

  it("drains a backlog with hasMore, ignoring nextPollMs", async () => {
    const { client, src } = setup({ nextPollMs: 60_000 });
    await client.connect();
    for (let i = 0; i < 5; i++) src.emit("incident.created", { i }); // history before the cursor exists...
    const start = src.head();
    for (let i = 0; i < 5; i++) src.emit("incident.created", { i }); // ...and a backlog after it
    const sub = open(client, "incident.created", {}, { cursor: start, maxEvents: 2, pollFloorMs: 60_000 });
    await until(() => snap(sub).delivered === 5, "all five events");
    expect(src.polls.map((p) => p.maxEvents)).toEqual([2, 2, 2]); // 2 + 2 + 1, back to back
    expect(snap(sub).nextPollMs).toBe(60_000);
  });

  it("honours nextPollMs, and never polls faster than the floor", async () => {
    const slow = setup({ nextPollMs: 400 });
    await slow.client.connect();
    const a = open(slow.client, "incident.created", {}, { pollFloorMs: 0 });
    await until(() => snap(a).status === "live", "first poll");
    await tick(150);
    expect(slow.src.polls).toHaveLength(1); // still waiting out the server's 400ms
    await until(() => slow.src.polls.length >= 2, "the second poll", 3000);

    const quick = setup({ nextPollMs: 0 });
    await quick.client.connect();
    open(quick.client, "incident.created", {}, { pollFloorMs: 300 });
    await tick(150);
    expect(quick.src.polls).toHaveLength(1); // the server asked for 0; the floor says 300
    await until(() => quick.src.polls.length >= 2, "the second poll after the floor", 3000);
  });

  it("refresh() polls now instead of waiting", async () => {
    const { client, src } = setup({ nextPollMs: 60_000 });
    await client.connect();
    const sub = open(client, "incident.created", {}, { pollFloorMs: 60_000 });
    await until(() => snap(sub).status === "live", "first poll");
    const e = src.emit("incident.created", {});
    sub.refresh();
    await until(() => snap(sub).delivered === 1, "the refreshed poll");
    expect(snap(sub).events[0]!.eventId).toBe(e.eventId);
  });

  it("notifies subscribers on change and stops after close()", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created");
    const seen: EventsSnapshot[] = [];
    const off = sub.subscribe(() => seen.push(snap(sub)));
    await until(() => snap(sub).status === "live", "first poll");
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length); // a fresh object per change
    off();

    sub.close();
    sub.close(); // idempotent
    await sub.done;
    expect(snap(sub).status).toBe("closed");
    const n = src.polls.length;
    await tick(60);
    expect(src.polls.length).toBe(n);
  });

  it("an abort signal ends it; an already-aborted signal never polls", async () => {
    const { client, src } = setup();
    await client.connect();
    const ac = new AbortController();
    const sub = open(client, "incident.created", {}, { signal: ac.signal });
    await until(() => snap(sub).status === "live", "first poll");
    ac.abort();
    await sub.done;
    expect(snap(sub).status).toBe("closed");

    const before = src.polls.length;
    const done = new AbortController();
    done.abort();
    const sub2 = open(client, "incident.created", {}, { signal: done.signal });
    await sub2.done;
    expect(snap(sub2).status).toBe("closed");
    expect(src.polls.length).toBe(before);
  });

  it("bounds the buffer but counts everything delivered", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created", {}, { maxBuffer: 3 });
    await until(() => snap(sub).status === "live", "first poll");
    for (let i = 0; i < 6; i++) src.emit("incident.created", { i });
    await until(() => snap(sub).delivered === 6, "six events");
    expect(snap(sub).events.map((e) => e.data.i)).toEqual([3, 4, 5]);
  });

  it("a type with no replay: cursor stays null and events still arrive", async () => {
    const { server, client, src } = setup();
    server.spec.events!.types = [{ name: "tick", replay: false }];
    await client.connect();
    const cursors: Array<string | null> = [];
    const sub = open(client, "tick", {}, { onCursor: (c) => cursors.push(c) });
    await until(() => snap(sub).status === "live", "first poll");
    src.emit("tick", { n: 1 });
    await until(() => snap(sub).delivered === 1, "the event");
    expect(snap(sub).cursor).toBeNull();
    expect(src.polls.every((p) => p.cursor === null)).toBe(true);
    expect(cursors).toEqual([]); // null -> null is not a change
  });

  it("sends maxAgeMs only with a cursor (the spec ignores it for 'from now')", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created", {}, { maxAgeMs: 5000 });
    await until(() => src.polls.length >= 2, "two polls");
    expect(src.polls[0]!.maxAgeMs).toBeUndefined();
    expect(src.polls[1]!.maxAgeMs).toBe(5000);
    sub.close();
  });

  it("declares the extension in the request's client capabilities, alongside the client's own", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created");
    await until(() => src.polls.length >= 1, "a poll");
    const ext = src.polls[0]!.clientExtensions!;
    expect(ext[EVENTS_EXT]).toEqual({});
    expect(ext["io.modelcontextprotocol/tasks"]).toEqual({}); // the connection's own declaration is kept
    sub.close();
  });
});

describe("resume and gaps", () => {
  it("resumes from the last cursor after transient failures (and reports reconnecting)", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created");
    await until(() => snap(sub).status === "live", "first poll");
    const first = src.emit("incident.created", { n: 1 });
    await until(() => snap(sub).delivered === 1, "first event");
    const cursor = snap(sub).cursor;

    src.fail({ code: -32025, message: "ResourceExhausted", data: { limit: "polls" } }, 2); // retryable
    const during = src.emit("incident.created", { n: 2 }); // happens while polls are failing
    await until(() => snap(sub).status === "reconnecting", "reconnecting");
    expect(snap(sub).error!.code).toBe(-32025);
    await until(() => snap(sub).delivered === 2, "the event emitted during the outage");
    expect(snap(sub).status).toBe("live");
    expect(snap(sub).error).toBeUndefined();
    expect(snap(sub).events.map((e) => e.eventId)).toEqual([first.eventId, during.eventId]);
    // every retry resumed from the cursor it last had, never from now
    expect(src.polls.filter((p) => p.cursor === cursor).length).toBeGreaterThanOrEqual(3); // 2 failed + 1 answered
    expect(src.polls.slice(1).every((p) => p.cursor !== null)).toBe(true); // never restarted from now
    expect(snap(sub).truncated).toBe(false);
  });

  it("resumes across a real connection drop and re-connect with no loss", async () => {
    const { server, client, src } = setup();
    // Wake quickly after the drop.
    (client.connection("s") as unknown as { cfg: { retryDelay?: () => number; maxRetries?: number } }).cfg.retryDelay = () => 20;
    (client.connection("s") as unknown as { cfg: { maxRetries?: number } }).cfg.maxRetries = 5;
    await client.connect();
    const sub = open(client, "incident.created", {}, { retry: { baseMs: 10, maxMs: 30 } });
    await until(() => snap(sub).status === "live", "first poll");
    const a = src.emit("incident.created", { n: 1 });
    await until(() => snap(sub).delivered === 1, "first event");
    const cursor = snap(sub).cursor;
    const sdkBefore = client.connection("s")!.sdk;

    await sdkBefore.transport?.close(); // the connection drops under the subscription
    const b = src.emit("incident.created", { n: 2 }); // emitted while it is down
    await until(() => client.connection("s")!.sdk !== sdkBefore && client.serverState("s") === "ready", "the reconnect", 8000);
    await until(() => snap(sub).delivered === 2, "the event from the outage", 8000);
    expect(snap(sub).events.map((e) => e.eventId)).toEqual([a.eventId, b.eventId]);
    expect(snap(sub).truncated).toBe(false);
    // it carried its cursor onto the new connection
    expect(src.polls.some((p) => p.cursor === cursor)).toBe(true);
    expect(server.connectCount).toBeGreaterThanOrEqual(2);
  });

  it("a persisted cursor resumes in a new subscription, and onCursor hands it out", async () => {
    const { client, src } = setup();
    await client.connect();
    const cursors: Array<string | null> = [];
    const one = open(client, "incident.created", {}, { onCursor: (c) => cursors.push(c) });
    await until(() => snap(one).status === "live", "first poll");
    src.emit("incident.created", { n: 1 });
    await until(() => snap(one).delivered === 1, "first event");
    const saved = cursors.at(-1)!;
    expect(saved).toBe(snap(one).cursor);
    one.close();
    await one.done;

    const missed = src.emit("incident.created", { n: 2 }); // while nobody was subscribed
    const two = open(client, "incident.created", {}, { cursor: saved });
    await until(() => snap(two).delivered === 1, "replay from the saved cursor");
    expect(snap(two).events[0]!.eventId).toBe(missed.eventId);
    expect(snap(two).truncated).toBe(false);
  });

  it("surfaces truncated: true as an explicit gap (never silent), and keeps delivering", async () => {
    const { client, src } = setup();
    await client.connect();
    const first = open(client, "incident.created");
    await until(() => snap(first).status === "live", "first poll");
    src.emit("incident.created", { n: 1 });
    await until(() => snap(first).delivered === 1, "first event");
    const stale = snap(first).cursor!;
    first.close();
    await first.done;

    src.emit("incident.created", { n: 2 }); // will be lost
    src.emit("incident.created", { n: 3 }); // will be lost
    src.truncate(); // the server's retention window moves past the stale cursor
    const kept = src.emit("incident.created", { n: 4 });

    const gaps: Array<{ previousCursor: string | null; cursor: string | null }> = [];
    const second = open(client, "incident.created", {}, { cursor: stale, onGap: (g) => gaps.push(g) });
    await until(() => snap(second).truncated, "the gap to be reported");
    expect(snap(second).gaps).toHaveLength(1);
    expect(snap(second).gaps[0]).toMatchObject({ reason: "truncated", previousCursor: stale });
    expect(gaps).toHaveLength(1);
    expect(snap(second).gaps[0]!.cursor).toBe(snap(second).cursor); // the fresh position is what it persists
    await until(() => snap(second).delivered === 1, "the retained event");
    expect(snap(second).events[0]!.eventId).toBe(kept.eventId);
    expect(snap(second).status).toBe("live"); // it did not reconnect or end

    // new events keep flowing and the gap list does not grow without a new truncation
    src.emit("incident.created", { n: 5 });
    await until(() => snap(second).delivered === 2, "a later event");
    expect(snap(second).gaps).toHaveLength(1);
  });
});

describe("ending", () => {
  it("a terminal server error (Forbidden -32024) ends the subscription and is not retried", async () => {
    const { client, src } = setup();
    await client.connect();
    const sub = open(client, "incident.created");
    await until(() => snap(sub).status === "live", "first poll");
    src.fail({ code: -32024, message: "Forbidden", data: { reason: "Access revoked" } });
    sub.refresh();
    await sub.done;
    expect(snap(sub).status).toBe("error");
    expect(snap(sub).error).toBeInstanceOf(MCPError);
    expect(snap(sub).error!.code).toBe(-32024);
    const n = src.polls.length;
    await tick(60);
    expect(src.polls.length).toBe(n);
  });

  it("closing the client ends every live subscription", async () => {
    const { client } = setup();
    await client.connect();
    const sub = open(client, "incident.created");
    await until(() => snap(sub).status === "live", "first poll");
    await client.close();
    await sub.done;
    expect(snap(sub).status).toBe("closed");
  });

  it("onEvent / onGap / listener exceptions are contained", async () => {
    const { client, src } = setup();
    await client.connect();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = open(client, "incident.created", {}, {
      onEvent: () => {
        throw new Error("app bug");
      },
    });
    await until(() => snap(sub).status === "live", "first poll");
    src.emit("incident.created", {});
    await until(() => snap(sub).delivered === 1, "the event");
    expect(spy).toHaveBeenCalled();
    expect(snap(sub).status).toBe("live");
    spy.mockRestore();
  });
});

describe("through the interceptor chain (kind: 'event')", () => {
  const record = (ops: Operation[]): RequestInterceptor => (op, next) => {
    ops.push({ ...op, args: op.args ? { ...op.args } : undefined });
    return next(op);
  };

  it("listEvents and every poll are event operations, audited through onCall", async () => {
    const ops: Operation[] = [];
    const audit: Array<{ kind: string; target: string; outcome: string }> = [];
    const server = new MockMCPServer({ events: { types: TYPES, nextPollMs: 0 } });
    const client = new MCPClient({
      servers: { s: { transport: server.transport, versions: ["2026-07-28"] } },
      interceptors: [record(ops)],
      onCall: (e) => void audit.push({ kind: e.kind, target: e.target, outcome: e.outcome }),
    });
    opened.push(client, server);
    await client.connect();
    await client.listEvents("s");
    const sub = open(client, "incident.created", { severity: "P1" });
    await until(() => server.events!.polls.length >= 2, "two polls");
    sub.close();

    const list = ops.find((o) => o.method === "events/list")!;
    expect(list).toMatchObject({ kind: "event", peer: "s", target: "events" });
    const poll = ops.find((o) => o.method === "events/poll")!;
    expect(poll).toMatchObject({ kind: "event", peer: "s", target: "incident.created", args: { severity: "P1" } });
    expect(audit).toContainEqual({ kind: "event", target: "incident.created", outcome: "ok" });
    expect(audit).toContainEqual({ kind: "event", target: "events", outcome: "ok" });
  });

  it("an interceptor can redact poll results, and what it returns is what the subscriber sees", async () => {
    const redact: RequestInterceptor = async (op, next) => {
      const res = (await next(op)) as { events?: Array<{ data: Record<string, unknown> }> };
      if (op.kind === "event" && op.method === "events/poll") for (const e of res.events ?? []) e.data = { ...e.data, secret: "[redacted]" };
      return res;
    };
    const { client, src } = setup({ interceptors: [redact] });
    await client.connect();
    const sub = open(client, "incident.created");
    await until(() => snap(sub).status === "live", "first poll");
    src.emit("incident.created", { secret: "hunter2", ok: 1 });
    await until(() => snap(sub).delivered === 1, "the event");
    expect(snap(sub).events[0]!.data).toEqual({ secret: "[redacted]", ok: 1 });
  });

  it("a denying interceptor ends the subscription (denied is terminal, not retried) and audits as denied", async () => {
    const audit: string[] = [];
    const server = new MockMCPServer({ events: { types: TYPES, nextPollMs: 0 } });
    const client = new MCPClient({
      servers: { s: { transport: server.transport, versions: ["2026-07-28"] } },
      interceptors: [authorize((req) => (req.kind === "event" && req.target === "incident.created" ? "deny" : "allow"))],
      onCall: (e) => void audit.push(`${e.kind}:${e.target}:${e.outcome}`),
    });
    opened.push(client, server);
    await client.connect();
    const sub = open(client, "incident.created");
    await sub.done;
    expect(snap(sub).status).toBe("error");
    expect(snap(sub).error!.code).toBe(-32003);
    expect(server.events!.polls).toHaveLength(0);
    expect(audit).toContain("event:incident.created:denied");
    // the listing itself was allowed
    expect(audit).toContain("event:events:ok");
  });

  it("with no server, listEvents reports a denied server and returns the rest", async () => {
    const a = new MockMCPServer({ events: { types: TYPES } });
    const b = new MockMCPServer({ events: { types: TYPES } });
    const client = new MCPClient({
      servers: { a: { transport: a.transport, versions: ["2026-07-28"] }, b: { transport: b.transport, versions: ["2026-07-28"] } },
      interceptors: [authorize((req) => (req.kind === "event" && req.server === "b" ? "deny" : "allow"))],
    });
    opened.push(client, a, b);
    await client.connect();
    const denied: string[] = [];
    const types = await client.listEvents(undefined, { onError: (s, e) => denied.push(`${s}:${e.code}`) });
    expect([...new Set(types.map((t) => t.server))]).toEqual(["a"]);
    expect(denied).toEqual(["b:-32003"]);
  });
});
