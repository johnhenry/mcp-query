// Regression tests for two CRITICAL findings that shared one root cause: `replayServer`
// used to fall back to `firstByMethod.get(method)` on any non-exact match, silently
// returning a stale or entirely unrelated tool's recorded result instead of erroring.
// See: https://github.com/johnhenry/mcp-query/issues/30

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { createCassette } from "../src/cassette.js";
import { recordTransport } from "../src/record.js";
import { replayTransport } from "../src/replay.js";

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function record(build: (client: Client) => Promise<void>) {
  const mock = new MockMCPServer({
    tools: [
      { name: "foo", handler: (a) => ({ content: [{ type: "text", text: `foo:${JSON.stringify(a)}` }] }) },
      { name: "bar", handler: (a) => ({ content: [{ type: "text", text: `bar:${JSON.stringify(a)}` }] }) },
    ],
  });
  const cassette = createCassette();
  const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await rec.connect(recordTransport(mock.transport(), cassette));
  await build(rec);
  await rec.close();
  return cassette;
}

describe("replay safety: no silent method-only fallback", () => {
  it("throws instead of returning a stale result for a params mismatch on the same tool", async () => {
    const cassette = await record(async (rec) => {
      await rec.callTool({ name: "foo", arguments: { x: 1 } }); // record foo({x:1}) only
    });

    const rp = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rp.connect(replayTransport(cassette)());

    // Replaying foo({x:2}) — different params, same tool — must NOT return the foo({x:1}) result.
    await expect(rp.callTool({ name: "foo", arguments: { x: 2 } })).rejects.toThrow(/no recorded interaction matches this request/);
    await rp.close();
  });

  it("throws instead of cross-contaminating with a different, never-recorded tool", async () => {
    const cassette = await record(async (rec) => {
      await rec.callTool({ name: "foo", arguments: { x: 1 } }); // only foo is ever recorded
    });

    const rp = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rp.connect(replayTransport(cassette)());

    // bar was never recorded at all — must not silently return foo's cached response,
    // since both share the "tools/call" JSON-RPC method.
    await expect(rp.callTool({ name: "bar", arguments: { y: 99 } })).rejects.toThrow(/no recorded interaction matches this request/);
    await rp.close();
  });

  it("still replays an exact match correctly (no regression on the happy path)", async () => {
    const cassette = await record(async (rec) => {
      await rec.callTool({ name: "foo", arguments: { x: 1 } });
      await rec.callTool({ name: "bar", arguments: { y: 99 } });
    });

    const rp = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rp.connect(replayTransport(cassette)());
    expect(text(await rp.callTool({ name: "foo", arguments: { x: 1 } }))).toBe('foo:{"x":1}');
    expect(text(await rp.callTool({ name: "bar", arguments: { y: 99 } }))).toBe('bar:{"y":99}');
    await rp.close();
  });
});
