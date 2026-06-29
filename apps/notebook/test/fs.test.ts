import { describe, it, expect } from "vitest";
import { parseDirectory, parseSearch, toolText, baseName } from "../src/fs.js";

describe("fs helpers", () => {
  it("toolText concatenates text content blocks", () => {
    const res = { content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] };
    expect(toolText(res)).toBe("hello world");
    expect(toolText(undefined)).toBe("");
    expect(toolText({ content: "nope" })).toBe("");
  });

  it("parseDirectory keeps only [FILE] entries, sorted, with abs paths + uris", () => {
    const text = "[DIR] sub\n[FILE] welcome.md\n[FILE] a.txt\n";
    const files = parseDirectory(text, "/notes/");
    expect(files.map((f) => f.name)).toEqual(["a.txt", "welcome.md"]);
    expect(files[0]).toEqual({
      name: "a.txt",
      path: "/notes/a.txt",
      uri: "file:///notes/a.txt",
    });
  });

  it("parseSearch splits lines and handles 'No matches'", () => {
    expect(parseSearch("/n/a.md\n/n/b.md")).toEqual(["/n/a.md", "/n/b.md"]);
    expect(parseSearch("No matches found")).toEqual([]);
    expect(parseSearch("   ")).toEqual([]);
  });

  it("baseName returns the trailing path segment", () => {
    expect(baseName("/a/b/c.md")).toBe("c.md");
    expect(baseName("file.txt")).toBe("file.txt");
  });
});
