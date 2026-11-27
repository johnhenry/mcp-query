// Sandboxed-iframe mounting: the spec's double-iframe architecture. The host page embeds a
// SANDBOX PROXY page served from a DIFFERENT origin; once the proxy announces readiness the host
// sends it the raw HTML (plus the validated CSP/permissions) and the proxy loads it in an inner
// iframe. All JSON-RPC then flows over postMessage, validated by `event.source`.
import { PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { AppSession } from "./host.js";
import { resolveSandbox, type SandboxOptions } from "./sandbox.js";

export interface MountIframeOptions {
  /** Element the sandbox proxy iframe is appended to. */
  container: Element;
  /** URL of the sandbox proxy page. MUST be a different origin from the host page (enforced). */
  sandboxUrl: string | URL;
  /** `sandbox` attribute of the INNER iframe the proxy creates. Default "allow-scripts" (opaque origin). */
  innerSandbox?: string;
  title?: string;
  /**
   * Host-configurable sandbox tokens (see {@link SandboxOptions}). Defaults are unchanged; tightening is free,
   * loosening needs `sandbox.unsafeLoosen: true`. Takes precedence over `innerSandbox`.
   */
  sandbox?: SandboxOptions;
  /**
   * Supply the sandbox-proxy `<iframe>` yourself (an element, or a factory called with the container's document)
   * instead of having one created, e.g. to pre-style it or use a framework-owned element. The host's
   * `sandbox`, `allow`, `referrerpolicy` and `src` are ALWAYS set by this function after your element is handed
   * over (so it cannot weaken the policy), and an element carrying `srcdoc` is refused (it would inherit the
   * host's origin).
   */
  iframe?: HTMLIFrameElement | ((doc: Document) => HTMLIFrameElement);
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

  // Resolve (and validate) the sandbox policy before touching the DOM.
  const sandbox = resolveSandbox(opts.sandbox, opts.innerSandbox);
  const iframe = typeof opts.iframe === "function" ? opts.iframe(doc) : opts.iframe ?? doc.createElement("iframe");
  if (!iframe || String(iframe.nodeName).toLowerCase() !== "iframe") throw new Error("`iframe` must be (or return) an <iframe> element");
  if (iframe.hasAttribute("srcdoc")) throw new Error("a host-supplied iframe must not use srcdoc: it would run in the host page's origin");
  // allow-same-origin here is the PROXY's own (distinct) origin -- never the host's (checked above).
  iframe.setAttribute("sandbox", sandbox.outer);
  if (session.resource.allow) iframe.setAttribute("allow", session.resource.allow);
  else iframe.removeAttribute("allow");
  // legacy attributes that grant Permission-Policy features outside the `allow` list
  iframe.removeAttribute("allowfullscreen");
  iframe.removeAttribute("allowpaymentrequest");
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
        sandbox: sandbox.inner,
        csp: session.resource.csp,
        permissions: session.resource.permissions,
        // Only when the host customised the CSP: the exact header (the sandbox page is the host's own, so it can read it).
        ...(session.resource.hostCsp ? { cspHeader: session.resource.cspHeader } : {}),
      } as never)
      .catch(() => void session.close());
  });
  await session.connect(new PostMessageTransport(win, win));
  return { iframe, dispose: () => session.close() };
}
