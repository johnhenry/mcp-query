import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntryPoint } from "../src/cli/entry.js";

describe("isEntryPoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-query-entry-"));
  const real = join(dir, "cli.js");
  writeFileSync(real, "");
  const link = join(dir, "bin-link");
  symlinkSync(real, link);
  const url = pathToFileURL(real).href;

  it("matches the script path itself", () => {
    expect(isEntryPoint(url, real)).toBe(true);
  });

  it("matches through a symlink, as an installed bin is", () => {
    expect(isEntryPoint(url, link)).toBe(true);
  });

  it("does not match another script", () => {
    const other = join(dir, "other.js");
    writeFileSync(other, "");
    expect(isEntryPoint(url, other)).toBe(false);
  });

  it("is false with no script path or a missing one", () => {
    expect(isEntryPoint(url, undefined)).toBe(false);
    expect(isEntryPoint(url, "")).toBe(false);
    expect(isEntryPoint(url, join(dir, "missing.js"))).toBe(false);
  });
});
