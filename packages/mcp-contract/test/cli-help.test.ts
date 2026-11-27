import { describe, it, expect, vi } from "vitest";
import { run } from "../src/cli.js";

describe("mcp-contract --help", () => {
  it("prints usage and resolves without connecting or exiting non-zero", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["--help"]);
    await run(["-h"]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0]![0])).toContain("usage:");
    log.mockRestore();
  });
});
