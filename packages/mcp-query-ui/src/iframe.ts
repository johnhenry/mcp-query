// Sandboxed-iframe mounting: the spec's double-iframe architecture. The host page embeds a
// SANDBOX PROXY page served from a DIFFERENT origin; once the proxy announces readiness the host
// sends it the raw HTML (plus the validated CSP/permissions) and the proxy loads it in an inner
// iframe. All JSON-RPC then flows over postMessage, validated by `event.source`.
import { PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { AppSession } from "./host.js";

export interface MountIframeOptions {
  /** Element the sandbox proxy iframe is appended to. */
  container: Element;
  /** URL of the sandbox proxy page. MUST be a different origin from the host page (enforced). */
  sandboxUrl: string | URL;
  /** `sandbox` attribute of the INNER iframe the proxy creates. Default "allow-scripts" (opaque origin). */
  innerSandbox?: string;
  title?: string;
}

export interface MountedIframe {
  iframe: HTMLIFrameElement;
  /** Closes the session (removing the iframe). */
  dispose(): Promise<void>;
}

/** Outer-iframe `sandbox` token set the spec mandates for the proxy page. */
export const SANDBOX_PROXY_SANDBOX = "allow-scripts allow-same-origin";

export async function mountIframe(session: AppSession, opts: MountIframeOptions): Promise<MountedIframe> {
  const doc = opts.container.ownerDocument;
  const hostOrigin = doc.defaultView?.location.origin;
  const url = new URL(String(opts.sandboxUrl), doc.defaultView?.location.href);
  if (url.origin === hostOrigin) {
    throw new Error(`sandboxUrl must be served from a different origin than the host page (${hostOrigin}); a same-origin proxy would give the app the host's origin`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("sandboxUrl must use https (http is only accepted for localhost)");
  }

  const iframe = doc.createElement("iframe");
  // allow-same-origin here is the PROXY's own (distinct) origin -- never the host's.
  iframe.setAttribute("sandbox", SANDBOX_PROXY_SANDBOX);
  if (session.resource.allow) iframe.setAttribute("allow", session.resource.allow);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", opts.title ?? "MCP App");
  iframe.src = url.href;
  opts.container.appendChild(iframe);
  session.addCleanup(() => iframe.remove());

  const win = iframe.contentWindow;
  if (!win) {
    await session.close();
    throw new Error("sandbox iframe has no contentWindow");
  }
  session.bridge.addEventListener("sandboxready", () => {
    void session.bridge
      .sendSandboxResourceReady({
        html: session.resource.html,
        sandbox: opts.innerSandbox ?? "allow-scripts",
        csp: session.resource.csp,
        permissions: session.resource.permissions,
      })
      .catch(() => void session.close());
  });
  await session.connect(new PostMessageTransport(win, win));
  return { iframe, dispose: () => session.close() };
}
