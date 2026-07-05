import { describe, it, expect } from "vitest";
import { run } from "../src/cli.js";

describe("mcp-bench CLI arg validation", () => {
  it("rejects unknown flags with the known list", async () => {
    await expect(run(["--nope", "x", "--command", "true"])).rejects.toThrow(/unknown flag --nope for mcp-bench \(known: .*--call/);
  });

  it("accepts --call in both syntaxes but rejects malformed specs fast, naming both forms", async () => {
    // parse happens before connecting, so no server is ever spawned for a bad spec
    await expect(run(["--command", "true", "--call", "echo(message"])).rejects.toThrow(/tool:\{"arg":"value"\}.*tool\(arg: "value"/s);
    await expect(run(["--command", "true", "--call", 'echo:{"broken'])).rejects.toThrow(/tool:\{"arg":"value"\}.*tool\(arg: "value"/s);
  });
});
