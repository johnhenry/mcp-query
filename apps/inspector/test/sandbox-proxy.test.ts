// @ts-expect-error plain-JS module served to the browser as-is
import { buildCsp, injectCsp, sanitizeSandbox, permissionsToAllow, startProxy, READY, RESOURCE_READY } from "../sandbox/proxy-lib.js";
import { describe, expect, it, vi } from "vitest";

describe("sandbox proxy helpers", () => {
  it("builds the spec's restrictive default CSP when nothing is declared", () => {
    const csp = buildCsp({});
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("widens only with declared, well-formed sources and drops injection attempts", () => {
    const csp = buildCsp({ connectDomains: ["https://api.example.com", "https://a.com; script-src *", "'unsafe-eval'", "*"], resourceDomains: ["https://cdn.example.com"] });
    expect(csp).toContain("connect-src 'self' https://api.example.com;");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src \*/);
  });

  it("injects the CSP meta ahead of the app's own markup", () => {
    expect(injectCsp("<html><head><title>x</title></head></html>", {})).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    expect(injectCsp("<p>bare</p>", {})).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
  });

  it("never lets the inner iframe share the proxy's origin or navigate away", () => {
    expect(sanitizeSandbox("allow-scripts allow-same-origin")).toBe("allow-scripts");
    expect(sanitizeSandbox("allow-scripts allow-top-navigation allow-popups allow-forms")).toBe("allow-scripts allow-forms");
    expect(sanitizeSandbox(undefined)).toBe("allow-scripts");
    expect(sanitizeSandbox("allow-same-origin")).toBe("allow-scripts");
  });

  it("maps declared permissions to a Permission Policy list", () => {
    expect(permissionsToAllow({ camera: {}, clipboardWrite: {} })).toBe("camera; clipboard-write");
    expect(permissionsToAllow(undefined)).toBe("");
  });
});

describe("startProxy", () => {
  function setup() {
    document.body.innerHTML = "";
    const parent = { postMessage: vi.fn() };
    const listeners: Array<(e: unknown) => void> = [];
    const win = { parent, addEventListener: (_: string, fn: (e: unknown) => void) => void listeners.push(fn) };
    startProxy({ win, doc: document, hostOrigin: "http://localhost:5173" });
    const fire = (source: unknown, data: unknown, origin = "http://localhost:5173") => listeners.forEach((l) => l({ source, data, origin }));
    return { parent, fire };
  }

  it("announces readiness, builds the inner iframe from the resource, and relays other traffic", () => {
    const { parent, fire } = setup();
    expect(parent.postMessage).toHaveBeenCalledWith({ jsonrpc: "2.0", method: READY, params: {} }, "http://localhost:5173");
    fire(parent, { jsonrpc: "2.0", method: RESOURCE_READY, params: { html: "<p>hi</p>", sandbox: "allow-scripts allow-same-origin", csp: {} } });
    const inner = document.querySelector("iframe")!;
    expect(inner.getAttribute("sandbox")).toBe("allow-scripts");
    expect(inner.srcdoc).toContain("Content-Security-Policy");
    expect(inner.srcdoc).toContain("<p>hi</p>");

    const innerWin = { postMessage: vi.fn() };
    vi.spyOn(inner, "contentWindow", "get").mockReturnValue(innerWin as never);
    fire(parent, { jsonrpc: "2.0", id: 1, method: "ui/notifications/tool-input", params: {} });
    expect(innerWin.postMessage).toHaveBeenCalledOnce();
    parent.postMessage.mockClear();
    fire(innerWin, { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    expect(parent.postMessage).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }, "http://localhost:5173");
  });

  it("drops messages from an unexpected origin and does not relay sandbox control messages", () => {
    const { parent, fire } = setup();
    fire(parent, { jsonrpc: "2.0", method: RESOURCE_READY, params: { html: "x" } }, "http://evil.example");
    expect(document.querySelector("iframe")).toBeNull();
    fire(parent, { jsonrpc: "2.0", method: RESOURCE_READY, params: { html: "x" } });
    const innerWin = { postMessage: vi.fn() };
    vi.spyOn(document.querySelector("iframe")!, "contentWindow", "get").mockReturnValue(innerWin as never);
    fire(parent, { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: {} });
    expect(innerWin.postMessage).not.toHaveBeenCalled();
  });
});
