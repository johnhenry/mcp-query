// list_changed storm: the server mutates its tool list and fires 1,000 tools/list_changed
// notifications. The client's final view must equal the final spec, and the number of
// upstream re-lists must stay bounded (documents whether notifications coalesce; if they
// don't, this pins the correctness floor and the re-list count flags the perf gap).
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import { BUDGET, tick } from "./helpers.js";

const STORMS = 1_000;

describe("list_changed storm", () => {
  it(`stays coherent through ${STORMS} tools/list_changed notifications`, async () => {
    const mkTool = (i: number) => ({
      name: `tool-${i}`,
      handler: () => ({ content: [{ type: "text", text: String(i) }] }),
    });
    const server = new MockMCPServer({ tools: [mkTool(0)] });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();
    await client.listTools("s");
    const listsBefore = countLists(server);

    const started = performance.now();
    for (let i = 1; i <= STORMS; i++) {
      server.spec = { tools: [mkTool(i)] };
      await server.notifyToolListChanged();
    }
    // Let refetches settle, then assert convergence on the final spec.
    await expect
      .poll(async () => (await client.listTools("s")).map((t) => t.name).join(","), {
        timeout: 30_000,
        interval: 50,
      })
      .toBe(`tool-${STORMS}`);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(BUDGET.stormMs * 3);

    const relists = countLists(server) - listsBefore;
    // Correctness floor: at least one re-list happened. Perf signal: log the fan-in ratio.
    expect(relists).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.info(`[stress] ${STORMS} list_changed → ${relists} upstream re-lists (${elapsed.toFixed(0)}ms)`);

    await client.close();
    await tick(10);
  });
});

/** tools/list handler invocations, inferred from callLog-free MockMCPServer via connect count-independent counter. */
function countLists(server: MockMCPServer): number {
  // MockMCPServer doesn't count list calls natively; track via a wrapped spec getter.
  const anyServer = server as unknown as { __listCount?: number; spec: unknown };
  if (anyServer.__listCount === undefined) {
    anyServer.__listCount = 0;
    let inner = anyServer.spec;
    Object.defineProperty(server, "spec", {
      get() {
        anyServer.__listCount!++;
        return inner;
      },
      set(v) {
        inner = v;
      },
    });
  }
  return anyServer.__listCount;
}
