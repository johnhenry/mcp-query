import { afterEach, describe, expect, it } from "vitest";
import { APP_URI, makeFixture } from "./fixture.js";
import { applyHostCspDirectives, buildAppCsp, resolveSandbox } from "../src/index.js";

let fx: Awaited<ReturnType<typeof makeFixture>> | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

const open = async (frame: NonNullable<Parameters<typeof makeFixture>[1]>["frame"]) => {
  fx = await makeFixture({}, { frame });
  return fx.host.open({ uri: APP_URI });
};

describe("frame.csp.directives (host CSP)", () => {
  it("defaults are unchanged without frame options", async () => {
    fx = await makeFixture();
    const s = await fx.host.open({ uri: APP_URI });
    expect(s.resource.cspHeader).toBe(buildAppCsp(s.resource.csp));
    expect(s.resource.hostCsp).toBeUndefined();
  });

  it("tightens: narrows a declared source, drops unsafe-inline, adds restrictive-only directives", async () => {
    const s = await open({
      csp: { directives: { "connect-src": "'none'", "script-src": ["'self'", "https://cdn.example.com"], "form-action": "'none'", "frame-ancestors": "'none'", "report-uri": "https://csp.host.example/r" } },
    });
    const h = s.resource.cspHeader;
    expect(h).toContain("connect-src 'none'");
    expect(h).toContain("script-src 'self' https://cdn.example.com;");
    expect(h).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(h).toContain("form-action 'none'");
    expect(h).toContain("frame-ancestors 'none'");
    expect(h).toContain("report-uri https://csp.host.example/r");
    expect(h).toContain("default-src 'none'"); // untouched
    expect(s.resource.hostCsp).toBe(true);
  });

  it("refuses to loosen without the opt-in (extra source, unsafe-eval, new fetch directive, wider default)", async () => {
    await expect(open({ csp: { directives: { "connect-src": "https://evil.example.com" } } })).rejects.toThrow(/loosen/);
    await expect(open({ csp: { directives: { "script-src": "'self' 'unsafe-eval'" } } })).rejects.toThrow(/loosen/);
    await expect(open({ csp: { directives: { "worker-src": "https://w.example.com" } } })).rejects.toThrow(/loosen/); // would fall back to default-src 'none'
    await expect(open({ csp: { directives: { "default-src": "https:" } } })).rejects.toThrow(/loosen/);
    await expect(open({ csp: { directives: { "made-up-directive": "x" } } })).rejects.toThrow(/may add/);
  });

  it("allows loosening only with csp.unsafeLoosen, and still syntax-checks sources", async () => {
    const s = await open({ csp: { unsafeLoosen: true, directives: { "connect-src": "'self' https://other.example.com" } } });
    expect(s.resource.cspHeader).toContain("connect-src 'self' https://other.example.com");
    await expect(open({ csp: { unsafeLoosen: true, directives: { "connect-src": "https://a.com; script-src *" } } })).rejects.toThrow(/invalid source/);
    await expect(open({ csp: { unsafeLoosen: true, directives: { "bad name": "x" } } })).rejects.toThrow(/invalid directive name/);
  });

  it("addDomains (host-added sources) is loosening: refused without the opt-in, merged and validated with it", async () => {
    expect(() => makeFixture({}, { frame: { csp: { addDomains: { connectDomains: ["https://x.example.com"] } } } })).rejects.toThrow(/unsafeLoosen/);
    const s = await open({ csp: { unsafeLoosen: true, addDomains: { connectDomains: ["https://x.example.com", "https://a.com; script-src *"] } } });
    expect(s.resource.csp.connectDomains).toEqual(["https://api.example.com", "https://x.example.com"]);
    expect(s.resource.cspHeader).not.toContain("script-src *");
  });

  it("the app-declared CSP can only be narrowed: a host cannot widen the declaration by naming a new domain", async () => {
    const s = await open({ csp: { directives: { "connect-src": "'self' https://api.example.com" } } });
    expect(s.resource.cspHeader).toContain("connect-src 'self' https://api.example.com");
  });
});

describe("applyHostCspDirectives (unit)", () => {
  const base = buildAppCsp({ connectDomains: ["https://*.example.com"] });
  it("wildcard-subdomain sources cover concrete subdomains but not other hosts", () => {
    expect(applyHostCspDirectives(base, { "connect-src": "https://a.example.com" })).toContain("connect-src https://a.example.com");
    expect(() => applyHostCspDirectives(base, { "connect-src": "https://a.other.com" })).toThrow();
    expect(() => applyHostCspDirectives(base, { "connect-src": "http://a.example.com" })).toThrow();
  });
});

describe("frame.permissions (allow list)", () => {
  it("narrows the declared permissions (outer allow + inner permissions)", async () => {
    const s = await open({ permissions: { allow: () => false } });
    expect(s.resource.allow).toBe("");
    expect(s.resource.permissions).toEqual({});
  });
  it("keeps declared permissions by default; adding undeclared ones needs the opt-in", async () => {
    const s = await open({ permissions: { allow: (p) => p === "camera" } });
    expect(s.resource.allow).toBe("camera");
    await expect(makeFixture({}, { frame: { permissions: { add: { microphone: {} } } } })).rejects.toThrow(/unsafeLoosen/);
    const s2 = await open({ permissions: { add: { microphone: {} }, unsafeLoosen: true } });
    expect(s2.resource.allow.split("; ").sort()).toEqual(["camera", "microphone"]);
  });
});

describe("resolveSandbox (unit)", () => {
  it("defaults are the spec's: outer `allow-scripts allow-same-origin`, inner `allow-scripts`", () => {
    expect(resolveSandbox(undefined, undefined)).toEqual({ outer: "allow-scripts allow-same-origin", inner: "allow-scripts" });
  });
  it("the deprecated innerSandbox string is validated exactly like sandbox.inner", () => {
    expect(resolveSandbox(undefined, "allow-scripts").inner).toBe("allow-scripts");
    expect(resolveSandbox(undefined, "").inner).toBe(""); // tightening to inert is free
    expect(() => resolveSandbox(undefined, "allow-scripts allow-forms")).toThrow(/innerSandbox "allow-forms".*sandbox\.unsafeLoosen: true/);
    expect(resolveSandbox({ unsafeLoosen: true }, "allow-scripts allow-forms").inner).toBe("allow-scripts allow-forms");
    // the previously unvalidated pass-through: allow-same-origin is refused with or without the opt-in
    expect(() => resolveSandbox(undefined, "allow-scripts allow-same-origin")).toThrow(/innerSandbox may not include allow-same-origin/);
    expect(() => resolveSandbox({ unsafeLoosen: true }, "allow-scripts allow-same-origin")).toThrow(/allow-same-origin/);
    expect(() => resolveSandbox(undefined, "allow-scrpts")).toThrow(/unknown sandbox token "allow-scrpts" in innerSandbox/);
    expect(() => resolveSandbox({ inner: "allow-scripts" }, "allow-scripts")).toThrow(/either `innerSandbox` \(deprecated\) or `sandbox\.inner`/);
  });
  it("tightens freely, loosens only with unsafeLoosen, never grants the inner frame allow-same-origin", () => {
    expect(resolveSandbox({ inner: [] }, undefined).inner).toBe("");
    expect(() => resolveSandbox({ inner: "allow-scripts allow-forms" }, undefined)).toThrow(/unsafeLoosen/);
    expect(resolveSandbox({ inner: "allow-scripts allow-forms", unsafeLoosen: true }, undefined).inner).toBe("allow-scripts allow-forms");
    expect(() => resolveSandbox({ extraOuter: ["allow-popups"] }, undefined)).toThrow(/unsafeLoosen/);
    expect(resolveSandbox({ extraOuter: ["allow-popups"], unsafeLoosen: true }, undefined).outer).toBe("allow-scripts allow-same-origin allow-popups");
    expect(() => resolveSandbox({ inner: "allow-scripts allow-same-origin", unsafeLoosen: true }, undefined)).toThrow(/allow-same-origin/);
    expect(() => resolveSandbox({ inner: "allow-scrpts" }, undefined)).toThrow(/unknown sandbox token/);
  });
});
