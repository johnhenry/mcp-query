// Regression test for the HIGH finding: cassettes had no tamper-evidence — a hand-edited
// cassette file was indistinguishable from a genuine recording. `sealCassette` now stamps
// a SHA-256 integrity hash at record time, and `loadCassette` verifies it at load time.
// See: https://github.com/johnhenry/mcp-query/issues/31

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { createCassette, sealCassette, loadCassette, cassetteHash, type Cassette } from "../src/cassette.js";
import { recordTransport } from "../src/record.js";

async function recordSample(): Promise<Cassette> {
  const mock = new MockMCPServer({
    tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }],
  });
  const cassette = createCassette();
  const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await rec.connect(recordTransport(mock.transport(), cassette));
  await rec.callTool({ name: "echo", arguments: { msg: "hi" } });
  await rec.close();
  return cassette;
}

describe("cassette tamper-evidence", () => {
  const files: string[] = [];
  afterEach(async () => {
    await Promise.all(files.splice(0).map((f) => rm(f, { force: true })));
  });

  it("sealCassette stamps a hash that loadCassette accepts unmodified", async () => {
    const cassette = sealCassette(await recordSample());
    expect(cassette.integrity).toBe(cassetteHash(cassette));

    const path = join(tmpdir(), `mcp-record-integrity-ok-${Date.now()}.json`);
    files.push(path);
    await writeFile(path, JSON.stringify(cassette, null, 2), "utf8");

    const loaded = loadCassette(await readFile(path, "utf8"));
    expect(loaded.interactions).toEqual(cassette.interactions);
  });

  it("loadCassette refuses a cassette whose result field was hand-edited after sealing", async () => {
    const cassette = sealCassette(await recordSample());
    const path = join(tmpdir(), `mcp-record-integrity-tampered-${Date.now()}.json`);
    files.push(path);
    await writeFile(path, JSON.stringify(cassette, null, 2), "utf8");

    // Simulate hand-editing the file on disk: mutate a recorded result but leave the
    // (now stale) integrity hash in place, exactly as a manual edit would.
    const raw = await readFile(path, "utf8");
    const tampered = raw.replace('"hi"', '"pwned"');
    expect(tampered).not.toBe(raw);
    await writeFile(path, tampered, "utf8");

    expect(() => loadCassette(tampered)).toThrow(/integrity check failed/);
  });

  it("loadCassette lets an unsealed cassette (no integrity field) through unchecked", () => {
    const cassette = createCassette();
    cassette.interactions.push({ method: "tools/call", params: { name: "echo" }, result: { ok: true } });
    const json = JSON.stringify(cassette);
    expect(() => loadCassette(json)).not.toThrow();
  });
});
