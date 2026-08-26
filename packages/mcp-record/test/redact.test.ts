// Regression test for the MEDIUM finding: recording captured params/results verbatim with
// no way to keep sensitive fields (tokens, PII, etc. passed as tool args or returned in
// results) out of the on-disk cassette. `redactPaths` + `recordTransport`'s opt-in `redact`
// option now let callers mask specific fields before they're written.
// See: https://github.com/johnhenry/mcp-query/issues/32

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { createCassette } from "../src/cassette.js";
import { recordTransport, redactPaths } from "../src/record.js";

describe("recordTransport redaction (opt-in)", () => {
  it("with no redact option configured, sensitive params/results are captured verbatim (documented default)", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "login", handler: (a) => ({ content: [{ type: "text", text: `token=${String(a.apiKey)}` }] }) }],
    });
    const cassette = createCassette();
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rec.connect(recordTransport(mock.transport(), cassette));
    await rec.callTool({ name: "login", arguments: { apiKey: "sk-super-secret" } });
    await rec.close();

    const json = JSON.stringify(cassette);
    expect(json).toContain("sk-super-secret");
  });

  it("a configured redaction rule masks the specified field in the on-disk cassette", async () => {
    // This handler does NOT echo the secret back in its result — isolates the assertion to
    // the redacted `params` field (a separate test would be needed to also cover masking a
    // secret that a server returns in its *result*, which `redactPaths` handles identically).
    const mock = new MockMCPServer({
      tools: [{ name: "login", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }],
    });
    const cassette = createCassette();
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    const redact = redactPaths(["params.arguments.apiKey"]);
    await rec.connect(recordTransport(mock.transport(), cassette, { redact }));
    await rec.callTool({ name: "login", arguments: { apiKey: "sk-super-secret" } });
    await rec.close();

    const path = join(tmpdir(), `mcp-record-redact-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(cassette, null, 2), "utf8");
    try {
      const onDisk = await readFile(path, "utf8");
      expect(onDisk).not.toContain("sk-super-secret");

      const call = cassette.interactions.find((i) => i.method === "tools/call");
      const params = call?.params as { arguments?: { apiKey?: unknown } } | undefined;
      expect(params?.arguments?.apiKey).toBe("[REDACTED]");
    } finally {
      await rm(path, { force: true });
    }
  });

  it("redactPaths skips paths that don't resolve, without throwing", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "noop", handler: () => ({ content: [] }) }],
    });
    const cassette = createCassette();
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    const redact = redactPaths(["params.arguments.nonexistent.deeper"]);
    await rec.connect(recordTransport(mock.transport(), cassette, { redact }));
    await expect(rec.callTool({ name: "noop", arguments: {} })).resolves.toBeTruthy();
    await rec.close();
  });
});
