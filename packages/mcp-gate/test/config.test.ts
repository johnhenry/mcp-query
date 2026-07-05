import { describe, it, expect } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGate, resolveUpstream, validateGateConfig, type GateConfig } from "../src/index.js";

describe("declarative upstreams (spec → transport mapping)", () => {
  it("maps { command, args, env } to a stdio transport factory", () => {
    const cfg = resolveUpstream({ command: "node", args: ["server.js"], env: { FOO: "bar" } });
    expect(typeof cfg.transport).toBe("function");
    expect(cfg.transport()).toBeInstanceOf(StdioClientTransport); // constructing doesn't spawn
    expect(cfg.transport()).not.toBe(cfg.transport()); // a *factory*: fresh transport per call (reconnect)
  });

  it("maps { url, headers } to a Streamable HTTP transport factory", () => {
    const cfg = resolveUpstream({ url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
    expect(cfg.transport()).toBeInstanceOf(StreamableHTTPClientTransport); // constructing doesn't connect
  });

  it("passes factory-style ConnectionConfigs through untouched", () => {
    const up = { transport: () => new StdioClientTransport({ command: "true" }), maxRetries: 2 };
    expect(resolveUpstream(up)).toBe(up);
  });
});

describe("config validation", () => {
  const upstreams: GateConfig["upstreams"] = { up: { command: "true" } };

  it("rejects a typo'd redact rule key (replace vs replacement), naming the valid keys", async () => {
    // validation runs before any upstream connects, so createGate rejects without spawning `true`
    await expect(
      createGate({ upstreams, redact: [{ pattern: /x/g, replace: "y" }] } as unknown as GateConfig),
    ).rejects.toThrow(/unknown key "replace" in redact rule #0 .*pattern, replacement/);
  });

  it("rejects an upstream with both command and url", async () => {
    await expect(
      createGate({ upstreams: { both: { command: "true", url: "https://example.com/mcp" } } } as unknown as GateConfig),
    ).rejects.toThrow(/upstream "both" has both "command" and "url"/);
  });

  it("rejects an upstream matching no shape, naming the accepted shapes", () => {
    expect(() => validateGateConfig({ upstreams: { odd: { arg: "x" } } })).toThrow(
      /upstream "odd".*transport: \(\) => Transport.*command.*url/s,
    );
  });

  it("rejects unknown top-level keys, naming the valid ones", () => {
    expect(() => validateGateConfig({ upstreams, rateLimits: { concurrency: 1 } })).toThrow(
      /unknown key "rateLimits" in GateConfig .*rateLimit/,
    );
  });

  it("rejects unknown keys in policy / rateLimit / circuitBreaker", () => {
    expect(() => validateGateConfig({ upstreams, policy: { denyDestructive: true, blocklist: [] } })).toThrow(
      /unknown key "blocklist" in policy .*allow, deny, denyDestructive/,
    );
    expect(() => validateGateConfig({ upstreams, rateLimit: { concurency: 4 } })).toThrow(
      /unknown key "concurency" in rateLimit .*concurrency/,
    );
    expect(() => validateGateConfig({ upstreams, circuitBreaker: { treshold: 3 } })).toThrow(
      /unknown key "treshold" in circuitBreaker .*threshold, cooldownMs/,
    );
  });

  it("rejects wrong basic types, naming the key", () => {
    expect(() => validateGateConfig({ upstreams: { up: { command: 42 } } })).toThrow(/"command" in upstream "up" must be a string \(got number\)/);
    expect(() => validateGateConfig({ upstreams: { up: { url: "not a url" } } })).toThrow(/"url" in upstream "up" is not a valid URL/);
    expect(() => validateGateConfig({ upstreams, namespace: "yes" })).toThrow(/"namespace" in GateConfig must be a boolean \(got string\)/);
    expect(() => validateGateConfig({ upstreams, rateLimit: { concurrency: "4" } })).toThrow(/"concurrency" in rateLimit must be a number/);
  });

  it("rejects a missing/malformed upstreams map and non-object configs", () => {
    expect(() => validateGateConfig({})).toThrow(/missing required key "upstreams"/);
    expect(() => validateGateConfig(null)).toThrow(/expected a GateConfig object \(got null\)/);
  });

  it("accepts every valid shape (factory, stdio spec, http spec, undefined optionals)", () => {
    expect(() =>
      validateGateConfig({
        upstreams: {
          fac: { transport: () => new StdioClientTransport({ command: "true" }), lazy: true, idleMs: 1000 },
          stdio: { command: "npx", args: ["-y", "pkg"], env: { A: "b" } },
          http: { url: "https://example.com/mcp", headers: undefined }, // explicit undefined counts as absent
        },
        policy: { allow: ["*.read*"], deny: ["*.rm"], denyDestructive: true },
        redact: [{ pattern: /x/g }, { pattern: "y", replacement: "[Y]" }],
        rateLimit: { concurrency: 2 },
        circuitBreaker: { threshold: 3, cooldownMs: 500 },
        namespace: false,
        audit: () => {},
        clientInfo: { name: "g", version: "1" },
      }),
    ).not.toThrow();
  });
});
