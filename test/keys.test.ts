import { describe, it, expect } from "vitest";
import { argsHash, serializeKey } from "../src/core/keys.js";

describe("argsHash", () => {
  it("is stable regardless of key order", () => {
    expect(argsHash({ a: 1, b: 2 })).toBe(argsHash({ b: 2, a: 1 }));
  });

  it("distinguishes different values", () => {
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });

  it("handles nested objects and arrays deterministically", () => {
    expect(argsHash({ x: [1, { p: 1, q: 2 }] })).toBe(argsHash({ x: [1, { q: 2, p: 1 }] }));
  });

  it("treats null and undefined args as a stable key", () => {
    expect(argsHash(undefined)).toBe(argsHash(null));
  });
});

describe("serializeKey", () => {
  it("encodes resource keys with server and uri", () => {
    expect(serializeKey({ kind: "resource", server: "fs", uri: "file:///a" })).toBe("resource fs file:///a");
  });

  it("encodes list keys with just the server", () => {
    expect(serializeKey({ kind: "toolList", server: "gh" })).toBe("toolList gh");
  });

  it("encodes tool-result keys with the args hash", () => {
    expect(serializeKey({ kind: "toolResult", server: "gh", tool: "x", argsHash: "h" })).toBe(
      "toolResult gh x h",
    );
  });
});
