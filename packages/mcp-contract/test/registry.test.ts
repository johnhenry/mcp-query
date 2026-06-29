import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveServer,
  resolveConnect,
  entryToConnectOptions,
  expandEnv,
  addServer,
  getServer,
  removeServer,
  importFrom,
} from "../src/registry.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "mcpq-reg-")), "servers.json");

beforeEach(() => {
  delete process.env.MCPQ_TEST_VAR;
});

describe("registry", () => {
  it("resolves a registered stdio + http server to ConnectOptions", () => {
    const file = tmp();
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
          remote: { type: "http", url: "https://host/mcp", headers: { "X-Tenant": "acme" } },
        },
      }),
    );
    expect(resolveServer("everything", { config: file })).toEqual({ command: "npx", args: "-y @modelcontextprotocol/server-everything", env: undefined, cwd: undefined });
    expect(resolveServer("remote", { config: file })).toEqual({ url: "https://host/mcp", headers: { "X-Tenant": "acme" } });
  });

  it("treats a URL ref as an ad-hoc server", () => {
    expect(resolveServer("https://host/mcp")).toEqual({ url: "https://host/mcp", headers: {} });
  });

  it("throws a helpful error for an unknown name", () => {
    expect(() => resolveServer("nope", { config: tmp() })).toThrow(/mcpq add nope/);
  });

  it("expands ${VAR} and ${VAR:-default} from the environment", () => {
    process.env.MCPQ_TEST_VAR = "secret";
    expect(expandEnv("Bearer ${MCPQ_TEST_VAR}")).toBe("Bearer secret");
    expect(expandEnv("${MISSING:-fallback}")).toBe("fallback");
    expect(entryToConnectOptions({ url: "https://h/mcp", headers: { Authorization: "Bearer ${MCPQ_TEST_VAR}" } }).headers).toEqual({ Authorization: "Bearer secret" });
  });

  it("add / get / remove round-trip against an explicit config file", () => {
    const file = tmp();
    const path = addServer("linear", { type: "http", url: "https://mcp.linear.app/mcp" }, "home", { config: file });
    expect(path).toBe(file);
    expect(getServer("linear", { config: file })).toMatchObject({ url: "https://mcp.linear.app/mcp" });
    expect(removeServer("linear", "home", { config: file })).toBe(file);
    expect(getServer("linear", { config: file })).toBeUndefined();
  });

  it("resolveConnect: --server wins (with --bearer augmenting), else falls back to flags", () => {
    const file = tmp();
    writeFileSync(file, JSON.stringify({ mcpServers: { up: { url: "https://h/mcp" } } }));
    const viaName = resolveConnect({ server: "up", bearer: "T", config: file }, []);
    expect(viaName).toEqual({ url: "https://h/mcp", headers: { Authorization: "Bearer T" } });
    const viaFlags = resolveConnect({ command: "npx", args: "-y x" }, []);
    expect(viaFlags).toMatchObject({ command: "npx", args: "-y x" });
  });

  it("imports servers from a Claude-shaped config (nested under projects)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "mcpq-imp-")), "claude.json");
    writeFileSync(file, JSON.stringify({ projects: { "/a": { mcpServers: { fs: { command: "fs-server" } } }, "/b": { mcpServers: { gh: { command: "gh-server" } } } } }));
    expect(Object.keys(importFrom(file)).sort()).toEqual(["fs", "gh"]);
  });
});
