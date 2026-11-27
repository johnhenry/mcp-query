import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { APP_URI, makeFixture } from "./fixture.js";

// The peer floor (`@johnhenry/mcp-query >=0.5.0`) was verified against the published 0.5.0 and 0.6.0 with
// `scripts/peer-floor-smoke.mjs` (needs the registry; run it by hand before raising a client call below the
// floor). These two tests keep it honest offline.
let fx: Awaited<ReturnType<typeof makeFixture>> | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

describe("peer floor (offline)", () => {
  it("the host only touches MCPClient members that exist at the floor, or guards them", () => {
    const src = ["host.ts", "iframe.ts", "react.ts"].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // code only
    const used = new Set([...src.matchAll(/\bclient\.([A-Za-z]+)/g)].map((m) => m[1]!));
    // Present in @johnhenry/mcp-query 0.5.0. `discover` arrived in 0.6.0 and is called only behind a typeof check.
    const atFloor = new Set(["listTools", "listResources", "listPrompts", "connection", "callTool", "readResource", "interactions"]);
    expect([...used].filter((m) => !atFloor.has(m) && m !== "discover")).toEqual([]);
    expect(src).toMatch(/typeof client\.discover === "function"/);
  });

  it("opted-in resources/list falls back to the synchronous list when the client has no `discover`", async () => {
    fx = await makeFixture({}, { appCapabilities: { resourcesList: true, promptsList: true } }, { prompts: true });
    const client = fx.gate.client as unknown as { discover?: unknown };
    Object.defineProperty(client, "discover", { value: undefined, configurable: true }); // what a 0.5.0 client looks like
    const { app, session } = await fx.openAndConnect();
    expect((await app.listServerResources()).resources.map((r) => r.uri)).toContain(APP_URI);
    expect(session.getState().calls.find((c) => c.kind === "resources-list")?.outcome).toBe("ok");
  });
});
