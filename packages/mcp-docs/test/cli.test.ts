import { describe, it, expect } from "vitest";
import { run } from "../src/cli.js";

describe("mcp-docs CLI arg validation", () => {
  it("rejects unknown flags with the known list", async () => {
    await expect(run(["--titel", "My API", "--command", "true"])).rejects.toThrow(/unknown flag --titel for mcp-docs \(known: .*--title/);
  });
});
