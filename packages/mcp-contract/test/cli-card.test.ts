// `mcp-contract snapshot --card`: pin the Server Card (SEP-2127) alongside the capability surface.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { run } from "../src/cli.js";
import { cardForContract, type Contract, type ContractCard } from "../src/index.js";

let http: Server | undefined;
let mock: MockMCPServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  await mock?.close();
  http = mock = undefined;
});

async function serve(cardBody: (base: string) => unknown): Promise<string> {
  mock = new MockMCPServer({ tools: [{ name: "echo", description: "e", handler: () => ({ content: [] }) }] }, { era: "legacy" });
  const dispatch = (mock as unknown as { dispatch(r: Request): Promise<Response> }).dispatch;
  let base = "";
  http = createServer((req, res) => {
    void (async () => {
      if (req.url === "/mcp/server-card") {
        res.writeHead(200, { "content-type": "application/mcp-server-card+json" }).end(JSON.stringify(cardBody(base)));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await dispatch.call(mock, new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
    })().catch(() => res.end());
  });
  await new Promise<void>((r) => http!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return `${base}/mcp`;
}

describe("mcp-contract snapshot --card", () => {
  const cardDoc = (base: string) => ({
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "example-org/echo",
    version: "1.0.0",
    description: "Echo.",
    remotes: [{ type: "streamable-http", url: `${base}/mcp`, supportedProtocolVersions: ["2026-07-28", "2025-11-25"] }],
  });

  it("--card auto reads <url>/server-card and pins identity + remotes in the contract", async () => {
    const url = await serve(cardDoc);
    const dir = await mkdtemp(join(tmpdir(), "contract-card-"));
    const out = join(dir, "c.json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run(["snapshot", "--url", url, "--card", "auto", "--out", out]);
      const contract = JSON.parse(await readFile(out, "utf8")) as Contract;
      expect(contract.card).toEqual({
        url: `${url}/server-card`,
        name: "example-org/echo",
        remotes: [{ type: "streamable-http", url, supportedProtocolVersions: ["2025-11-25", "2026-07-28"] }],
      });
      // Without the flag nothing is fetched or recorded.
      await run(["snapshot", "--url", url, "--out", out]);
      expect(JSON.parse(await readFile(out, "utf8"))).not.toHaveProperty("card");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--card <url> names the card explicitly; a stdio server needs it spelled out", async () => {
    const url = await serve(cardDoc);
    const dir = await mkdtemp(join(tmpdir(), "contract-card-"));
    const out = join(dir, "c.json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run(["snapshot", "--url", url, "--card", `${url}/server-card`, "--out", out]);
      expect((JSON.parse(await readFile(out, "utf8")) as Contract).card?.name).toBe("example-org/echo");
      await expect(run(["snapshot", "--command", "true", "--card", "auto"])).rejects.toThrow(/--card auto.*needs --url/);
      await expect(run(["snapshot", "--url", url, "--card", `${url}/nope`])).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cardForContract and the card types are part of the package entry", async () => {
    const entry = await import("../src/index.js");
    expect(typeof entry.cardForContract).toBe("function");
    const c: ContractCard = cardForContract({ name: "a/b", remotes: [{ type: "streamable-http", url: "https://x/mcp" }] });
    expect(c.remotes).toHaveLength(1);
    const browser = await import("../src/index.browser.js");
    expect(typeof browser.cardForContract).toBe("function");
  });
});
