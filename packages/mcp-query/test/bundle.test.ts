import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), "mcpq-bundle-"));
const bundle = `${outDir}/mcp-query.js`;
const min = `${outDir}/mcp-query.min.js`;

describe("single browser bundle (#64)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    // Bundle straight from source (the package build runs the same function against dist/).
    const { buildBundle } = (await import(/* @vite-ignore */ `${root}scripts/bundle.mjs`)) as { buildBundle: (o: object) => Promise<unknown> };
    await buildBundle({ entry: `${root}src/browser.ts`, outDir });
  }, 120_000);

  it("is fully self-contained: no import or export-from of any other module", () => {
    for (const f of [bundle, min]) {
      expect(existsSync(f)).toBe(true);
      const code = readFileSync(f, "utf8");
      expect(code).not.toMatch(/(^|[;\n}])\s*import\s*(\{|\*|["'\w])[^;]*?from\s*["']/);
      expect(code).not.toMatch(/\bimport\s*\(\s*["']/);
      expect(code).not.toMatch(/\bnode:/);
      expect(code).not.toMatch(/from\s*["'](\.|\/|[a-z@])/);
    }
  });

  it("one import works with no Node globals: MCPClient talks to a server over the bundled in-memory transport", async () => {
    const m = (await import(/* @vite-ignore */ bundle)) as typeof import("../src/browser.js");
    expect(typeof m.MCPClient).toBe("function");
    expect(typeof m.StreamableHTTPClientTransport).toBe("function");
    expect(typeof m.WebSocketBridgeTransport).toBe("function");
    expect(typeof m.authorize).toBe("function");
    expect(typeof m.mcpCorsHeaders).toBe("function");

    const server = new McpServer({ name: "s", version: "1" });
    server.registerTool("add", { description: "add", inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));
    const [ct, st] = m.InMemoryTransport.createLinkedPair();
    await server.connect(st as never);
    const client = new m.MCPClient({ servers: { s: { transport: () => ct as never } } });
    await client.connect();
    const r = (await client.callTool("add", { a: 2, b: 3 })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("5");
    await client.close();
  });

  it("writes a size table", () => {
    const sizes = JSON.parse(readFileSync(`${outDir}/sizes.json`, "utf8")) as { file: string; bytes: number; gzip: number }[];
    expect(sizes.map((s) => s.file)).toEqual(["mcp-query.js", "mcp-query.min.js"]);
    for (const s of sizes) expect(s.gzip).toBeGreaterThan(1000);
  });
});
