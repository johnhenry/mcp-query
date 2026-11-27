import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { run } from "../src/cli.js";
import { showCard } from "../src/discovery-verbs.js";

const SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
let server: Server;
let base: string;
let dir: string;
let cfg: string;

const card = (over: Record<string, unknown> = {}) => ({
  $schema: SCHEMA,
  name: "example-org/weather",
  version: "1.0.0",
  description: "Weather lookups.\u001b[31m (ansi)\u001b[0m",
  remotes: [{ type: "streamable-http", url: "http://127.0.0.1:9/mcp", supportedProtocolVersions: ["2025-11-25"] }],
  ...over,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, type: string, body: unknown) => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    switch (req.url) {
      case "/card":
        return send(200, "application/mcp-server-card+json", card());
      case "/templated":
        return send(200, "application/mcp-server-card+json", card({ name: "example-org/tpl", remotes: [{ type: "streamable-http", url: "http://127.0.0.1:9/{tenant}/mcp", variables: { tenant: { isRequired: true } }, headers: [{ name: "X-Key", isRequired: true, isSecret: true }] }] }));
      case "/insecure":
        return send(200, "application/mcp-server-card+json", card({ remotes: [{ type: "streamable-http", url: "http://example.com/mcp" }] }));
      case "/evil-name":
        return send(200, "application/mcp-server-card+json", card({ name: "x/__proto__" }));
      case "/no-remotes":
        return send(200, "application/mcp-server-card+json", card({ remotes: undefined }));
      case "/bad":
        return send(200, "text/html", "<html>");
      case "/.well-known/ai-catalog.json":
        return send(200, "application/ai-catalog+json", {
          specVersion: "1.0",
          entries: [
            { identifier: "urn:air:fixture:mcp:weather", type: "application/mcp-server-card+json", url: "/card" },
            { identifier: "urn:air:fixture:mcp:tpl", type: "application/mcp-server-card+json", url: "/templated" },
          ],
        });
      default:
        return send(404, "text/plain", "no");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), "mcpq-cards-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
afterEach(() => vi.restoreAllMocks());
function freshConfig(): string {
  cfg = join(dir, `servers-${n++}.json`);
  return cfg;
}
const reg = (): Record<string, Record<string, unknown>> => (existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")).mcpServers : {});

function capture() {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m)));
  return out;
}
const L = ["--allow-insecure-localhost"];

describe("mcp-query add --from-card", () => {
  it("registers the card's remote and prints the (sanitized) card", async () => {
    freshConfig();
    const out = capture();
    await run(["add", "weather", "--from-card", `${base}/card`, "--config", cfg, ...L]);
    expect(reg().weather).toEqual({ type: "http", url: "http://127.0.0.1:9/mcp", description: "Weather lookups. (ansi)" });
    const text = out.join("\n");
    expect(text).toContain("untrusted");
    expect(text).toContain("example-org/weather");
    expect(text).not.toContain("\u001b");
  });

  it("refuses plain http for the card URL by default and writes nothing", async () => {
    freshConfig();
    await expect(run(["add", "weather", "--from-card", `${base}/card`, "--config", cfg])).rejects.toThrow(/plain http/);
    expect(reg()).toEqual({});
  });

  it("refuses a card whose remote is non-loopback http, even with the localhost option", async () => {
    freshConfig();
    capture();
    await expect(run(["add", "w", "--from-card", `${base}/insecure`, "--config", cfg, ...L])).rejects.toThrow(/plain http/);
    expect(reg()).toEqual({});
  });

  it("needs --var for templated URLs, lists required headers but never writes them", async () => {
    freshConfig();
    const out = capture();
    await expect(run(["add", "tpl", "--from-card", `${base}/templated`, "--config", cfg, ...L])).rejects.toThrow(/tenant/);
    await run(["add", "tpl", "--from-card", `${base}/templated`, "--var", "tenant=acme", "--config", cfg, ...L]);
    expect(reg().tpl).toMatchObject({ url: "http://127.0.0.1:9/acme/mcp", type: "http" });
    expect(reg().tpl).not.toHaveProperty("headers");
    expect(out.join("\n")).toMatch(/required header "X-Key" \(secret\)/);
  });

  it("does not overwrite an existing name without --force, and rejects unsafe names / no remotes", async () => {
    freshConfig();
    capture();
    writeFileSync(cfg, JSON.stringify({ mcpServers: { weather: { url: "https://old.example/mcp", type: "http" } } }));
    await expect(run(["add", "weather", "--from-card", `${base}/card`, "--config", cfg, ...L])).rejects.toThrow(/already registered/);
    expect(reg().weather!.url).toBe("https://old.example/mcp");
    await run(["add", "weather", "--from-card", `${base}/card`, "--config", cfg, "--force", ...L]);
    expect(reg().weather!.url).toBe("http://127.0.0.1:9/mcp");
    await expect(run(["add", "__proto__", "--from-card", `${base}/card`, "--config", cfg, ...L])).rejects.toThrow(/not a usable server name/);
    await expect(run(["add", "nr", "--from-card", `${base}/no-remotes`, "--config", cfg, ...L])).rejects.toThrow(/no remotes/);
  });

  it("surfaces fetch failures (wrong content type)", async () => {
    freshConfig();
    await expect(run(["add", "x", "--from-card", `${base}/bad`, "--config", cfg, ...L])).rejects.toThrow(/content-type/);
  });
});

describe("mcp-query add --from-domain", () => {
  const domain = () => base.replace("http://", "");

  it("lists entries and refuses to add without --pick or a matching name (non-interactive)", async () => {
    freshConfig();
    const out = capture();
    await expect(run(["add", "--from-domain", domain(), "--config", cfg, ...L])).rejects.toThrow(/--pick/);
    expect(reg()).toEqual({});
    expect(out.join("\n")).toContain("urn:air:fixture:mcp:weather");
    expect(out.join("\n")).toContain("urn:air:fixture:mcp:tpl");
    await expect(run(["add", "nope", "--from-domain", domain(), "--config", cfg, ...L])).rejects.toThrow(/matches no entry/);
    expect(reg()).toEqual({});
  });

  it("--json lists entries as JSON", async () => {
    freshConfig();
    const out = capture();
    await expect(run(["add", "--from-domain", domain(), "--json", "--config", cfg, ...L])).rejects.toThrow();
    const j = JSON.parse(out.join("\n"));
    expect(j.entries.map((e: { id: string }) => e.id)).toContain("urn:air:fixture:mcp:weather");
  });

  it("adds the entry chosen by --pick (name derived from the card) or by a matching name", async () => {
    freshConfig();
    capture();
    await run(["add", "--from-domain", domain(), "--pick", "urn:air:fixture:mcp:weather", "--config", cfg, ...L]);
    expect(Object.keys(reg())).toEqual(["weather"]);
    await run(["add", "wx", "--from-domain", domain(), "--pick", "example-org/weather", "--config", cfg, ...L]);
    expect(reg().wx!.url).toBe("http://127.0.0.1:9/mcp");
    await run(["add", "weather", "--from-domain", domain(), "--force", "--config", cfg, ...L]);
    expect(reg().weather).toBeDefined();
  });

  it("rejects mixing --from-card/--from-domain with a url", async () => {
    freshConfig();
    await expect(run(["add", "x", "https://a.example/mcp", "--from-card", `${base}/card`, "--config", cfg, ...L])).rejects.toThrow(/drop the url/);
    await expect(run(["add", "x", "--from-card", `${base}/card`, "--from-domain", "a.example", "--config", cfg])).rejects.toThrow(/not both/);
    await expect(run(["add", "x", "--from-card", "--config", cfg])).rejects.toThrow(/needs a URL/);
  });
});

describe("mcp-query card", () => {
  const liveClient = async () => {
    const mock = new MockMCPServer({ tools: [] });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(mock.transport());
    return { client, close: () => client.close() };
  };

  it("prints the card and compares it with the live server's negotiated facts", async () => {
    freshConfig();
    writeFileSync(cfg, JSON.stringify({ mcpServers: { wx: { type: "http", url: "http://127.0.0.1:9/mcp" } } }));
    const out = capture();
    await showCard({ ref: "wx", fromCard: `${base}/card`, config: cfg, allowInsecureLocalhost: true }, { connectLive: liveClient });
    const text = out.join("\n");
    expect(text).toContain("example-org/weather");
    expect(text).toContain("live server vs card");
    expect(text).toContain('DIFFERS  card name "example-org/weather" vs live serverInfo.name "mock"');
  });

  it("--strict fails on disagreement; --json reports findings; unreachable live server is reported not fatal", async () => {
    freshConfig();
    writeFileSync(cfg, JSON.stringify({ mcpServers: { wx: { type: "http", url: "http://127.0.0.1:9/mcp" } } }));
    capture();
    await expect(showCard({ ref: "wx", fromCard: `${base}/card`, config: cfg, allowInsecureLocalhost: true, strict: true }, { connectLive: liveClient })).rejects.toThrow(/disagreement/);

    const out = capture();
    await showCard({ ref: "wx", fromCard: `${base}/card`, config: cfg, allowInsecureLocalhost: true, json: true }, { connectLive: liveClient });
    const j = JSON.parse(out.at(-1)!);
    expect(j.findings.some((f: { field: string }) => f.field === "name")).toBe(true);

    const out2 = capture();
    await showCard({ ref: "wx", fromCard: `${base}/card`, config: cfg, allowInsecureLocalhost: true }, { connectLive: async () => { throw new Error("ECONNREFUSED"); } });
    expect(out2.join("\n")).toContain("could not reach the live server");
  });

  it("works without a live server (--from-card only) and derives <url>/server-card for a registered server", async () => {
    freshConfig();
    const out = capture();
    await showCard({ fromCard: `${base}/card`, allowInsecureLocalhost: true });
    expect(out.join("\n")).toContain("no live server given");

    writeFileSync(cfg, JSON.stringify({ mcpServers: { local: { command: "node" } } }));
    await expect(showCard({ ref: "local", config: cfg })).rejects.toThrow(/stdio/);
  });
});
