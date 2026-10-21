import { describe, it, expect } from "vitest";
import { compilePolicy, explainPolicy, policyListFilter, policyListAnnotator } from "../src/policy.js";
import { redactValue, redact } from "../src/redact-entry.js";
import { validateGateConfig } from "../src/validate.js";

const req = (target: string, destructive = false, server = "fs") => ({ kind: "call" as const, server, target, destructive, readOnly: false });
const upstreams = { a: { url: "http://x.test/mcp" } };

describe("emptyAllow", () => {
  it("defaults to deny: an empty allow list denies everything", async () => {
    expect(await compilePolicy({ allow: [] })(req("read"))).toBe("deny");
    expect(await compilePolicy({ allow: [] }, { emptyAllow: "deny" })(req("read"))).toBe("deny");
  });
  it('"ignore" treats an empty allow list as no allow list', async () => {
    expect(await compilePolicy({ allow: [] }, { emptyAllow: "ignore" })(req("read"))).toBe("allow");
    expect(await compilePolicy({ allow: [], approve: ["fs.w*"] }, { emptyAllow: "ignore" })(req("write"))).toBe("approve");
  });
  it('"ignore" does not affect a non-empty allow list', async () => {
    expect(await compilePolicy({ allow: ["fs.r*"] }, { emptyAllow: "ignore" })(req("write"))).toBe("deny");
  });
  it("applies to discovery filtering too", () => {
    expect(policyListFilter({ allow: [] }, "visible", { emptyAllow: "ignore" })).toBeUndefined();
    expect(policyListFilter({ allow: [] })!("fs", "tool", "x")).toBe(false);
  });
});

describe("scope: tool", () => {
  it("defaults to server.tool ids", async () => {
    expect(await compilePolicy({ allow: ["read*"] })(req("read_file"))).toBe("deny");
  });
  it("matches globs against the bare tool name", async () => {
    const p = compilePolicy({ allow: ["read*"], deny: ["read_secret"], approve: ["read_big"] }, { scope: "tool" });
    expect(await p(req("read_file"))).toBe("allow");
    expect(await p(req("read_secret"))).toBe("deny");
    expect(await p(req("read_big"))).toBe("approve");
    expect(await p(req("write"))).toBe("deny");
    expect(await p(req("read_file", false, "other"))).toBe("allow");
  });
  it("can be set per server", async () => {
    const p = compilePolicy({ allow: ["read*"] }, { scope: { fs: "tool" } });
    expect(await p(req("read_file", false, "fs"))).toBe("allow");
    expect(await p(req("read_file", false, "web"))).toBe("deny");
  });
  it("applies to discovery filter and annotator", () => {
    const f = policyListFilter({ allow: ["read*"] }, "visible", { scope: "tool" })!;
    expect(f("fs", "tool", "read_file")).toBe(true);
    expect(f("fs", "tool", "write")).toBe(false);
    const a = policyListAnnotator({ approve: ["write*"] }, "annotated", { scope: "tool" })!;
    expect(a("fs", "tool", "write_x")).toEqual({ requiresApproval: true });
  });
});

describe("explainPolicy", () => {
  it("names the deny glob", async () => {
    expect(await explainPolicy({ deny: ["fs.rm*"] })(req("rm_rf"))).toEqual({ decision: "deny", rule: { list: "deny", glob: "fs.rm*" } });
  });
  it("names denyDestructive without a glob", async () => {
    expect(await explainPolicy({ denyDestructive: true })(req("x", true))).toEqual({ decision: "deny", rule: { list: "denyDestructive" } });
  });
  it("allow-list miss is a deny by the allow list, no glob", async () => {
    expect(await explainPolicy({ allow: ["fs.r*"] })(req("w"))).toEqual({ decision: "deny", rule: { list: "allow" } });
    expect(await explainPolicy({ allow: [] })(req("w"))).toEqual({ decision: "deny", rule: { list: "allow" } });
  });
  it("names the approve glob and the allow glob", async () => {
    expect(await explainPolicy({ approve: ["fs.w*"] })(req("write"))).toEqual({ decision: "approve", rule: { list: "approve", glob: "fs.w*" } });
    expect(await explainPolicy({ allow: ["fs.r*"] })(req("read"))).toEqual({ decision: "allow", rule: { list: "allow", glob: "fs.r*" } });
  });
  it("omits rule when the default applied", async () => {
    const d = await explainPolicy({ deny: ["fs.rm"] })(req("read"));
    expect(d).toEqual({ decision: "allow" });
    expect("rule" in d).toBe(false);
  });
  it("reports the glob as written under scope: tool", async () => {
    expect(await explainPolicy({ approve: ["write*"] }, { scope: "tool" })(req("write_x"))).toEqual({ decision: "approve", rule: { list: "approve", glob: "write*" } });
  });
  it("wraps a function policy", async () => {
    expect(await explainPolicy(() => "approve")(req("x"))).toEqual({ decision: "approve" });
  });
  it("agrees with compilePolicy", async () => {
    const pol = { allow: ["fs.*"], deny: ["fs.rm"], approve: ["fs.w*"], denyDestructive: true };
    for (const t of ["rm", "write", "read"]) for (const d of [false, true])
      expect((await explainPolicy(pol)(req(t, d))).decision).toBe(await compilePolicy(pol)(req(t, d)));
  });
});

describe("redact flags and defaultReplacement", () => {
  it("flags make a string pattern case-insensitive (g added)", () => {
    expect(redactValue([{ pattern: "secret", flags: "i" }], "Secret SECRET")).toBe("[REDACTED] [REDACTED]");
  });
  it("flags replace a RegExp's flags", () => {
    expect(redactValue([{ pattern: /a.b/g, flags: "gs" }], "a\nb")).toBe("[REDACTED]");
  });
  it("defaultReplacement replaces the built-in text but not an explicit replacement", () => {
    const rules = [{ pattern: "x" }, { pattern: "y", replacement: "[Y]" }];
    expect(redactValue(rules, "x y", { defaultReplacement: "[redacted]" })).toBe("[redacted] [Y]");
    expect(redactValue(rules, "x y")).toBe("[REDACTED] [Y]");
  });
  it("redact interceptor takes the options", async () => {
    const i = redact([{ pattern: "tok", flags: "i" }], { defaultReplacement: "[r]" });
    expect(await i({} as never, async () => "a TOK b")).toBe("a [r] b");
  });
  it("validation accepts valid flags and rejects bad ones", () => {
    expect(() => validateGateConfig({ upstreams, redact: [{ pattern: "x", flags: "gimsu" }] })).not.toThrow();
    expect(() => validateGateConfig({ upstreams, redact: [{ pattern: "x", flags: "q" }] })).toThrow(/flags.*redact rule #0/);
    expect(() => validateGateConfig({ upstreams, redact: [{ pattern: "x", flags: 3 }] })).toThrow(/"flags" in redact rule #0 must be a string/);
  });
});
