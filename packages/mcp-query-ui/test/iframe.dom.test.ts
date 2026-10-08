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
