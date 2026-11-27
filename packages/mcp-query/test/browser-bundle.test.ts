// The single-file browser bundle (dist/browser/mcp-query.browser.js, `./browser-bundle` export, #64).
// Static checks always run; the real-Chromium test needs Playwright, which is not a dependency of
// this repo: it runs when `require("playwright")` resolves (or PLAYWRIGHT_MODULE points at one)
// and a Chromium can launch, and is skipped otherwise (CI-safe).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const bundlePath = fileURLToPath(new URL("../dist/browser/mcp-query.browser.js", import.meta.url));
const built = existsSync(bundlePath);

async function loadChromium(): Promise<any | undefined> {
  const req = createRequire(import.meta.url);
  for (const id of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
    if (!id) continue;
    try {
      const chromium = req(id).chromium;
      const b = await chromium.launch();
      await b.close();
      return chromium;
    } catch { /* not installed / no browser */ }
  }
  return undefined;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>bundle</title><script type="module">
import * as m from "/mcp-query.browser.js";

// A hand-written in-page transport: answers initialize / tools/list / tools/call locally.
function fakeServer() {
  const t = {
    onmessage: undefined, onclose: undefined, onerror: undefined,
    async start() {},
    async close() { t.onclose?.(); },
    async send(msg) {
      if (msg.id === undefined) return; // notification
      const reply = (result) => queueMicrotask(() => t.onmessage?.({ jsonrpc: "2.0", id: msg.id, result }));
      if (msg.method === "initialize") {
        reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "in-page", version: "1.0.0" } });
      } else if (msg.method === "tools/list") {
        reply({ tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }] });
      } else if (msg.method === "tools/call") {
        reply({ content: [{ type: "text", text: "echo: " + msg.params.arguments.msg + " sk-abc123" }] });
      } else if (msg.method === "ping") {
        reply({});
      } else {
        queueMicrotask(() => t.onmessage?.({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
      }
    },
  };
  return t;
}

try {
  const client = new m.MCPClient({ servers: { local: { transport: () => fakeServer() } } });
  await client.connect();
  const tools = client.listTools("local").map((t) => t.name);
  const res = await client.callTool("echo", { msg: "hi" });
  await client.close();

  // gate parts: policy + redaction over the same in-page transport
  const gate = await m.createGateClient({
    upstreams: { local: { transport: () => fakeServer() } },
    policy: { deny: ["local.nuke"] },
    redact: [{ pattern: /sk-[a-z0-9]+/g }],
    audit: () => {},
  });
  const redacted = await gate.client.callTool("echo", { msg: "yo" });
  await gate.close();

  window.__result = {
    ok: true, tools, text: res.content[0].text, redacted: redacted.content[0].text,
    exports: ["MCPClient", "createGateClient", "StreamableHTTPClientTransport", "compilePolicy"].filter((k) => k in m),
  };
} catch (e) {
  window.__result = { ok: false, error: String(e && e.stack || e) };
}
</script>`;

describe.skipIf(!built)("browser bundle (#64)", () => {
  it("is a single file with no import/export specifiers left to resolve", () => {
    const code = readFileSync(bundlePath, "utf8");
    // Static `import x from "..."`, `import "..."`, `export ... from "..."`, and dynamic import("...")
    expect(code).not.toMatch(/(^|[;}\s])import\s*(?:[\w${},*\s]+from\s*)?["'][^"']+["']/);
    expect(code).not.toMatch(/\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']/);
    expect(code).not.toMatch(/\bimport\(\s*["']/);
    expect(code).not.toMatch(/\brequire\(\s*["']/);
    expect(code).not.toMatch(/node:/);
  });

  it("exposes the core client, transports and the gate's browser parts", async () => {
    const m: Record<string, unknown> = await import(/* @vite-ignore */ bundlePath);
    for (const k of ["MCPClient", "MCPCache", "StreamableHTTPClientTransport", "InMemoryTransport", "createGateClient", "compilePolicy", "redactValue"]) {
      expect(typeof m[k], k).toBe("function");
    }
    // Node-only / gateway pieces and React hooks stay out
    for (const k of ["createGate", "resolveUpstream", "StdioClientTransport", "useTool", "MCPProvider"]) expect(m[k], k).toBeUndefined();
  });

  describe("in a real browser", () => {
    let server: Server;
    let origin = "";
    let chromium: any;
    beforeAll(async () => {
      chromium = await loadChromium();
      server = createServer((req, res) => {
        if (req.url === "/") res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
        else if (req.url === "/mcp-query.browser.js") res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(bundlePath));
        else res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 60_000);
    afterAll(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

    it("one import, zero further requests, constructs MCPClient and talks to an in-page transport", async (ctx) => {
      if (!chromium) return ctx.skip();
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        const requested: string[] = [];
        // Interception proves it: every request is recorded; anything off-origin is aborted.
        await page.route("**/*", (route: any) => {
          requested.push(route.request().url());
          return route.request().url().startsWith(origin + "/") ? route.continue() : route.abort();
        });
        await page.goto(origin + "/");
        await page.waitForFunction(() => (window as any).__result, undefined, { timeout: 20_000 });
        const result = await page.evaluate(() => (window as any).__result);
        expect(result.error).toBeUndefined();
        expect(result).toMatchObject({
          ok: true,
          tools: ["echo"],
          text: "echo: hi sk-abc123",
          redacted: "echo: yo [REDACTED]",
          exports: ["MCPClient", "createGateClient", "StreamableHTTPClientTransport", "compilePolicy"],
        });
        expect(requested.filter((u) => !u.endsWith("/favicon.ico")).sort()).toEqual([origin + "/", origin + "/mcp-query.browser.js"]);
      } finally {
        await browser.close();
      }
    }, 60_000);
  });
});
