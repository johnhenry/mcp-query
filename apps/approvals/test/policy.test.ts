import { describe, it, expect } from "vitest";
import { evaluatePolicy, makePolicyVerdict, ruleMatches, type PolicyConfig } from "../src/policy.js";
import { toNDJSON } from "../src/audit.js";
import type { AuditEntry } from "mcp-query";

describe("policy verdict", () => {
  const config: PolicyConfig = {
    rules: [
      { id: "1", type: "elicitation", server: "*", verdict: "allow" },
      { id: "2", type: "sampling", server: "trusted", verdict: "allow" },
      { id: "3", type: "sampling", server: "*", verdict: "ask" },
      { id: "4", type: "confirm", server: "*", verdict: "deny" },
    ],
    fallback: "ask",
  };

  it("matches by exact type and server", () => {
    expect(ruleMatches({ id: "x", type: "sampling", server: "trusted", verdict: "allow" }, { type: "sampling", server: "trusted" })).toBe(true);
    expect(ruleMatches({ id: "x", type: "sampling", server: "trusted", verdict: "allow" }, { type: "sampling", server: "other" })).toBe(false);
  });

  it('treats "*" as a wildcard for type and server', () => {
    expect(ruleMatches({ id: "x", type: "*", server: "*", verdict: "ask" }, { type: "elicitation", server: "anything" })).toBe(true);
  });

  it("allows elicitation everywhere", () => {
    expect(evaluatePolicy(config, { type: "elicitation", server: "everything", payload: {} })).toBe("allow");
  });

  it("auto-allows sampling on a trusted server but asks elsewhere (first match wins)", () => {
    expect(evaluatePolicy(config, { type: "sampling", server: "trusted", payload: {} })).toBe("allow");
    expect(evaluatePolicy(config, { type: "sampling", server: "everything", payload: {} })).toBe("ask");
  });

  it("denies confirm", () => {
    expect(evaluatePolicy(config, { type: "confirm", server: "everything", payload: {} })).toBe("deny");
  });

  it("falls back when no rule matches", () => {
    const empty: PolicyConfig = { rules: [], fallback: "deny" };
    expect(evaluatePolicy(empty, { type: "sampling", server: "x", payload: {} })).toBe("deny");
  });

  it("makePolicyVerdict reads the latest config on each call", () => {
    let live: PolicyConfig = { rules: [], fallback: "ask" };
    const verdict = makePolicyVerdict(() => live);
    expect(verdict({ type: "sampling", server: "x", payload: {} })).toBe("ask");
    live = { rules: [{ id: "1", type: "*", server: "*", verdict: "deny" }], fallback: "ask" };
    expect(verdict({ type: "sampling", server: "x", payload: {} })).toBe("deny");
  });
});

describe("NDJSON export", () => {
  it("serializes one JSON object per line", () => {
    const entries: AuditEntry[] = [
      { id: 1, at: 1000, server: "everything", type: "sampling", outcome: "approved" },
      { id: 2, at: 2000, server: "everything", type: "elicitation", outcome: "denied", reason: "no thanks" },
    ];
    const ndjson = toNDJSON(entries);
    const lines = ndjson.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(entries[0]);
    expect(JSON.parse(lines[1]!).reason).toBe("no thanks");
    // No trailing newline; each line is independently parseable.
    expect(ndjson.endsWith("\n")).toBe(false);
  });

  it("produces empty string for no entries", () => {
    expect(toNDJSON([])).toBe("");
  });
});
