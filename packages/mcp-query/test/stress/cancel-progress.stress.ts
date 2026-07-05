// Cancellation + progress under load: 200 concurrent long calls with progress ticks,
// half aborted mid-flight. Aborted calls must reject with an abort error, their onProgress
// must go silent after the abort, and the surviving calls must complete correctly.
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import { tick } from "./helpers.js";

const TOTAL = 200;
const ABORTED = 100;

describe("cancellation + progress storm", () => {
  it("aborts 100 of 200 in-flight calls cleanly", async () => {
    const server = new MockMCPServer({
      tools: [
        {
          name: "work",
          handler: async (args, ctx) => {
            for (let step = 1; step <= 5; step++) {
              ctx.progress(step, 5);
              await tick(10);
            }
            return { content: [{ type: "text", text: `done-${args.i}` }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const progressAfterAbort: number[] = [];
    const aborted = new Set<number>();
    const controllers = new Map<number, AbortController>();

    const calls = Array.from({ length: TOTAL }, (_, i) => {
      const ac = new AbortController();
      controllers.set(i, ac);
      return client
        .callTool(
          "work",
          { i },
          {
            signal: ac.signal,
            onProgress: () => {
              if (aborted.has(i)) progressAfterAbort.push(i);
            },
          },
        )
        .then(
          (r) => ({ i, ok: true as const, r }),
          (e: unknown) => ({ i, ok: false as const, e }),
        );
    });

    // Let the first progress ticks flow, then abort the first half.
    await tick(15);
    for (let i = 0; i < ABORTED; i++) {
      aborted.add(i);
      controllers.get(i)!.abort();
    }

    const settled = await Promise.all(calls);
    const okOnes = settled.filter((s) => s.ok);
    const failed = settled.filter((s) => !s.ok);

    // Everything we didn't abort completed; everything we aborted rejected.
    expect(okOnes.map((s) => s.i).every((i) => i >= ABORTED)).toBe(true);
    expect(okOnes.length).toBe(TOTAL - ABORTED);
    expect(failed.length).toBe(ABORTED);
    for (const f of failed) {
      // MCPError is a real Error subclass and aborts classify as kind "cancelled".
      const err = (f as { e: { kind?: string; message?: string } }).e;
      expect(err).toBeInstanceOf(Error);
      expect(err.kind).toBe("cancelled");
      expect(String(err.message).toLowerCase()).toMatch(/abort|cancel/);
    }

    // Give any straggler notifications a beat, then assert silence post-abort.
    await tick(100);
    expect(progressAfterAbort).toEqual([]);

    await client.close();
  });
});
