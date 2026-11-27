// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_URI, makeFixture } from "./fixture.js";
import { mountIframe, SANDBOX_PROXY_SANDBOX } from "../src/index.js";

let fx: Awaited<ReturnType<typeof makeFixture>> | undefined;
beforeEach(() => {
  // never let the DOM shim fetch the (fake) sandbox page
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  // happy-dom exposes no contentWindow without loading the page; hand back a stand-in window.
  vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window as never);
});
afterEach(async () => {
  await fx?.close();
  fx = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("mountIframe (double-iframe sandbox)", () => {
  it("creates the proxy iframe with the mandated sandbox tokens, the permission-policy allow list, and removes it on close", async () => {
    fx = await makeFixture();
    const session = await fx.host.open({ uri: APP_URI });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { iframe } = await mountIframe(session, { container, sandboxUrl: "https://sandbox.example.test/proxy.html" });
    expect(iframe.getAttribute("sandbox")).toBe(SANDBOX_PROXY_SANDBOX);
    expect(SANDBOX_PROXY_SANDBOX.split(" ").sort()).toEqual(["allow-same-origin", "allow-scripts"]);
    expect(iframe.getAttribute("allow")).toBe("camera");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.src).toBe("https://sandbox.example.test/proxy.html");
    expect(container.contains(iframe)).toBe(true);
    expect(session.getState().status).toBe("connecting");

    await session.close();
    expect(container.contains(iframe)).toBe(false);
    expect(session.getState().status).toBe("closed");
  });

  it("answers sandbox-proxy-ready with the raw HTML plus the validated CSP/permissions", async () => {
    fx = await makeFixture();
    const session = await fx.host.open({ uri: APP_URI });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const posted: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const proxyWin = { postMessage: (m: { method?: string; params?: Record<string, unknown> }) => void posted.push(m) };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(proxyWin as never);
    await mountIframe(session, { container, sandboxUrl: "https://sandbox.example.test/proxy.html" });
    window.dispatchEvent(
      new MessageEvent("message", { data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, source: proxyWin as never }),
    );
    await vi.waitFor(() => expect(posted.some((m) => m.method === "ui/notifications/sandbox-resource-ready")).toBe(true));
    const msg = posted.find((m) => m.method === "ui/notifications/sandbox-resource-ready")!;
    expect(msg.params).toMatchObject({
      html: expect.stringContaining("demo app"),
      sandbox: "allow-scripts",
      csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] },
      permissions: { camera: {} },
    });
  });

  it("refuses a same-origin or plain-http sandbox URL (the proxy must not share the host's origin)", async () => {
    fx = await makeFixture();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const s1 = await fx.host.open({ uri: APP_URI });
    await expect(mountIframe(s1, { container, sandboxUrl: `${window.location.origin}/proxy.html` })).rejects.toThrow(/different origin/);
    await expect(mountIframe(s1, { container, sandboxUrl: "http://sandbox.example.test/proxy.html" })).rejects.toThrow(/https/);
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("mountIframe host options (#66)", () => {
  const mount = async (extra: Parameters<typeof mountIframe>[1] extends infer O ? Partial<O> : never) => {
    fx = await makeFixture();
    const session = await fx.host.open({ uri: APP_URI });
    const container = document.createElement("div");
    document.body.appendChild(container);
    return { session, container, run: () => mountIframe(session, { container, sandboxUrl: "https://sandbox.example.test/proxy.html", ...extra }) };
  };

  it("uses a host-supplied iframe element but still stamps the policy attributes on it", async () => {
    const own = document.createElement("iframe");
    own.setAttribute("sandbox", "allow-top-navigation allow-scripts"); // a weaker policy the host element tried to bring
    own.setAttribute("allowfullscreen", "");
    own.setAttribute("class", "viaframe");
    const { run, container } = await mount({ iframe: own });
    const { iframe } = await run();
    expect(iframe).toBe(own);
    expect(iframe.getAttribute("class")).toBe("viaframe");
    expect(iframe.getAttribute("sandbox")).toBe(SANDBOX_PROXY_SANDBOX);
    expect(iframe.hasAttribute("allowfullscreen")).toBe(false);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.src).toBe("https://sandbox.example.test/proxy.html");
    expect(container.contains(own)).toBe(true);
  });

  it("accepts an iframe factory", async () => {
    const seen: Document[] = [];
    const { run } = await mount({ iframe: (doc) => (seen.push(doc), doc.createElement("iframe")) });
    const { iframe } = await run();
    expect(seen).toEqual([document]);
    expect(iframe.getAttribute("sandbox")).toBe(SANDBOX_PROXY_SANDBOX);
  });

  it("refuses a supplied element that is not an iframe or that carries srcdoc (host-origin document)", async () => {
    const bad = document.createElement("iframe");
    bad.setAttribute("srcdoc", "<script>parent.x</script>");
    const a = await mount({ iframe: bad });
    await expect(a.run()).rejects.toThrow(/srcdoc/);
    const b = await mount({ iframe: (() => document.createElement("div")) as never });
    await expect(b.run()).rejects.toThrow(/<iframe>/);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("still refuses a same-origin sandbox URL when the iframe is host-supplied", async () => {
    const { session, container } = await mount({});
    await expect(mountIframe(session, { container, sandboxUrl: `${window.location.origin}/p.html`, iframe: document.createElement("iframe") })).rejects.toThrow(/different origin/);
  });

  it("applies host sandbox tokens: tighten freely, loosen only with unsafeLoosen, inner never gets allow-same-origin", async () => {
    const posted: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const proxyWin = { postMessage: (m: { method?: string; params?: Record<string, unknown> }) => void posted.push(m) };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(proxyWin as never);
    const { run } = await mount({ sandbox: { inner: [], extraOuter: ["allow-popups"], unsafeLoosen: true } });
    const { iframe } = await run();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups");
    window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, source: proxyWin as never }));
    await vi.waitFor(() => expect(posted.some((m) => m.method === "ui/notifications/sandbox-resource-ready")).toBe(true));
    expect(posted.find((m) => m.method === "ui/notifications/sandbox-resource-ready")!.params).toMatchObject({ sandbox: "" });

    const bad = await mount({ sandbox: { inner: "allow-scripts allow-forms" } });
    await expect(bad.run()).rejects.toThrow(/unsafeLoosen/);
    const worse = await mount({ sandbox: { inner: "allow-scripts allow-same-origin", unsafeLoosen: true } });
    await expect(worse.run()).rejects.toThrow(/allow-same-origin/);
  });

  it("validates the deprecated innerSandbox like sandbox.inner, and refuses both together", async () => {
    const forms = await mount({ innerSandbox: "allow-scripts allow-forms" });
    await expect(forms.run()).rejects.toThrow(/innerSandbox "allow-forms".*unsafeLoosen/);
    const same = await mount({ innerSandbox: "allow-scripts allow-same-origin", sandbox: { unsafeLoosen: true } });
    await expect(same.run()).rejects.toThrow(/innerSandbox may not include allow-same-origin/);
    const typo = await mount({ innerSandbox: "allow-scrpts" });
    await expect(typo.run()).rejects.toThrow(/unknown sandbox token/);
    const both = await mount({ innerSandbox: "allow-scripts", sandbox: { inner: "allow-scripts" } });
    await expect(both.run()).rejects.toThrow(/not both/);
    // nothing was appended to the DOM by a refused mount
    expect(document.querySelectorAll("iframe").length).toBe(0);

    const posted: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const proxyWin = { postMessage: (m: { method?: string; params?: Record<string, unknown> }) => void posted.push(m) };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(proxyWin as never);
    const ok = await mount({ innerSandbox: "allow-scripts allow-forms", sandbox: { unsafeLoosen: true } });
    await ok.run();
    window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, source: proxyWin as never }));
    await vi.waitFor(() => expect(posted.some((m) => m.method === "ui/notifications/sandbox-resource-ready")).toBe(true));
    expect(posted.find((m) => m.method === "ui/notifications/sandbox-resource-ready")!.params).toMatchObject({ sandbox: "allow-scripts allow-forms" });
  });

  it("sends the host-customised CSP header to the sandbox proxy, and nothing extra by default", async () => {
    const posted: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const proxyWin = { postMessage: (m: { method?: string; params?: Record<string, unknown> }) => void posted.push(m) };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(proxyWin as never);
    fx = await makeFixture({}, { frame: { csp: { directives: { "connect-src": "'none'" } } } });
    const session = await fx.host.open({ uri: APP_URI });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mountIframe(session, { container, sandboxUrl: "https://sandbox.example.test/proxy.html" });
    window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, source: proxyWin as never }));
    await vi.waitFor(() => expect(posted.some((m) => m.method === "ui/notifications/sandbox-resource-ready")).toBe(true));
    const params = posted.find((m) => m.method === "ui/notifications/sandbox-resource-ready")!.params!;
    expect(String(params.cspHeader)).toContain("connect-src 'none'");
  });
});
