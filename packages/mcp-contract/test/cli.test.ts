import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { run } from "../src/cli.js";

describe("mcp-contract CLI arg validation", () => {
  it("rejects unknown flags with the known list", async () => {
    await expect(run(["snapshot", "--nope", "x"])).rejects.toThrow(/unknown flag --nope for mcp-contract \(known: .*--contract/);
  });

  it("verify treats --server as a live connection source (registry names resolve)", async () => {
    const pin = join(tmpdir(), `mcp-contract-pin-${Date.now()}.json`);
    await writeFile(pin, JSON.stringify({ tools: [], resources: [], resourceTemplates: [], prompts: [] }), "utf8");
    try {
      // before --server counted as "live", this fell through to
      // "provide --url/--command for a live server, or a contract file path"
      await expect(run(["verify", "--server", "no-such-server-xyz", "--contract", pin])).rejects.toThrow(
        /unknown server "no-such-server-xyz"/,
      );
    } finally {
      await rm(pin, { force: true });
    }
  });
});
