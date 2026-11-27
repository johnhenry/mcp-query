import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/sha256.js";

describe("sha256Hex (browser-safe, no node:crypto)", () => {
  const cases = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(65), "héllo wörld ✓ 🎞", JSON.stringify({ interactions: Array.from({ length: 500 }, (_, i) => ({ i, m: "tools/call" })) })];
  for (const input of cases) {
    it(`matches node:crypto for a ${input.length}-char input`, () => {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
    });
  }
});
