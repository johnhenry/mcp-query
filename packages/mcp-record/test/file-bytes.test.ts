// EXPERIMENTAL files extension: a cassette stores file metadata and a digest, never the bytes.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { createCassette, interactionKey, scrubFileBytes } from "../src/cassette.js";
import { recordTransport } from "../src/record.js";
import { replayTransport } from "../src/replay.js";

const bytes = "top-secret-file-contents";
const b64 = Buffer.from(bytes).toString("base64");
const file = { id: "file-1", name: "a.txt", mimeType: "text/plain", size: bytes.length, data: b64 };
const digest = createHash("sha256").update(bytes).digest("base64url");

describe("scrubFileBytes", () => {
  it("replaces inline data with a digest, keeps metadata, keeps a sender digest, and is idempotent", () => {
    const out = scrubFileBytes({ arguments: { f: file, n: 1 } }) as { arguments: { f: Record<string, unknown>; n: number } };
    expect(out.arguments.f).toEqual({ id: "file-1", name: "a.txt", mimeType: "text/plain", size: bytes.length, digest: { algorithm: "sha-256", value: digest }, dataOmitted: true });
    expect(out.arguments.n).toBe(1);
    expect(scrubFileBytes(out)).toEqual(out);
    const own = { algorithm: "sha-256", value: "sender" };
    expect((scrubFileBytes({ ...file, digest: own }) as { digest: unknown }).digest).toBe(own);
    expect(scrubFileBytes("x")).toBe("x");
    expect(scrubFileBytes([file])).toHaveLength(1);
  });
  it("leaves objects that are not file inputs alone", () => {
    const v = { id: "x", mimeType: "a/b", size: 1 };
    expect(scrubFileBytes({ v })).toEqual({ v });
    expect(interactionKey("tools/call", { f: file })).toBe(interactionKey("tools/call", scrubFileBytes({ f: file })));
  });
});

describe("record -> replay with a file argument", () => {
  it("stores no bytes, and the replayed call (same bytes) still matches", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "save", handler: () => ({ content: [{ type: "text", text: "saved" }] }) }] }, { era: "legacy" });
    const cassette = createCassette();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(recordTransport(mock.transport(), cassette));
    await client.callTool({ name: "save", arguments: { file } });
    await client.close();
    await mock.close();
    const json = JSON.stringify(cassette);
    expect(json).not.toContain(b64);
    expect(json).not.toContain(bytes);
    expect(json).toContain(digest);
    const replay = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await replay.connect(replayTransport(cassette)());
    const res = await replay.callTool({ name: "save", arguments: { file } });
    expect((res as { content: { text: string }[] }).content[0]!.text).toBe("saved");
    await replay.close();
  });
});
