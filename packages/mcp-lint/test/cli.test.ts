import { describe, it, expect } from "vitest";
import { run } from "../src/cli.js";

describe("mcp-lint CLI arg validation", () => {
  it("rejects unknown flags with the known list", async () => {
    await expect(run(["--max-warings", "0", "--command", "true"])).rejects.toThrow(
      /unknown flag --max-warings for mcp-lint \(known: .*--max-warnings/,
    );
  });
});
