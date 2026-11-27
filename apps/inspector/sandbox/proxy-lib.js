// Pure helpers for the sandbox proxy page (kept apart from the DOM wiring so they are unit-tested).
// Follows SEP-1865 "Sandbox proxy": build the CSP from the host-validated metadata, never loosen it.

/** A CSP source we are willing to emit: no whitespace, `;`, `,` or quotes, and an http(s)/ws(s) origin. */
const SAFE_SOURCE = /^(?:https?|wss?):\/\/(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&()*+=:@%/-]*)?$/;
const safe = (list) => (Array.isArray(list) ? [...new Set(list.filter((s) => typeof s === "string" && s.length <= 512 && SAFE_SOURCE.test(s)))] : []);

/** The spec's CSP for a View: restrictive default, widened only by declared (and re-validated) domains. */
export function buildCsp(csp = {}) {
  const res = safe(csp.resourceDomains).join(" ");
  const sp = (x) => (res ? `${x} ${res}` : x);
  const connect = safe(csp.connectDomains);
  const frame = safe(csp.frameDomains);
  const base = safe(csp.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src ${sp("'self' 'unsafe-inline'")}`,
    `style-src ${sp("'self' 'unsafe-inline'")}`,
    `connect-src ${connect.length ? `'self' ${connect.join(" ")}` : "'none'"}`,
    `img-src ${sp("'self' data:")}`,
    `font-src ${sp("'self'")}`,
    `media-src ${sp("'self' data:")}`,
    `frame-src ${frame.length ? frame.join(" ") : "'none'"}`,
    "object-src 'none'",
    `base-uri ${base.length ? base.join(" ") : "'self'"}`,
  ].join("; ");
}

/** Put the CSP first in the document so it governs every script that follows. */
export function injectCsp(html, csp) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(csp).replace(/"/g, "&quot;")}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + meta) : meta + html;
}

/**
 * The inner iframe must keep an opaque origin: drop `allow-same-origin` (and any navigation/popup
 * escape) whatever the host asked for. Default is `allow-scripts`.
 */
export function sanitizeSandbox(requested) {
  const banned = /^allow-(?:same-origin|top-navigation.*|popups.*|modals?)$/;
  const tokens = String(requested ?? "allow-scripts").split(/\s+/).filter((t) => /^allow-[a-z-]+$/.test(t) && !banned.test(t));
  return (tokens.length ? [...new Set(tokens)] : ["allow-scripts"]).join(" ");
}

/** Permission Policy `allow=` value for the inner iframe from the resource's `permissions`. */
export function permissionsToAllow(p) {
  if (!p || typeof p !== "object") return "";
  const map = { camera: "camera", microphone: "microphone", geolocation: "geolocation", clipboardWrite: "clipboard-write" };
  return Object.entries(map).filter(([k]) => p[k]).map(([, v]) => v).join("; ");
}

export const READY = "ui/notifications/sandbox-proxy-ready";
export const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

/**
 * Wire the proxy: announce readiness to the parent, build the inner iframe once the host sends the
 * resource, then relay every other JSON-RPC message untouched in both directions.
 * `hostOrigin` pins the parent (from `?host=`); messages from any other source are dropped.
 */
export function startProxy({ win, doc, hostOrigin }) {
  if (win.parent === win) throw new Error("sandbox proxy must be embedded in the host page");
  const parent = win.parent;
  let inner = null;

  win.addEventListener("message", (e) => {
    if (e.source === parent) {
      if (hostOrigin && e.origin !== hostOrigin) return;
      const m = e.data;
      if (m && m.method === RESOURCE_READY) {
        if (inner) return; // one View per proxy
        const p = m.params ?? {};
        inner = doc.createElement("iframe");
        inner.setAttribute("sandbox", sanitizeSandbox(p.sandbox));
        const allow = permissionsToAllow(p.permissions);
        if (allow) inner.setAttribute("allow", allow);
        inner.style.cssText = "border:0;width:100%;height:100%;display:block";
        inner.srcdoc = injectCsp(String(p.html ?? ""), p.csp);
        doc.body.appendChild(inner);
        return;
      }
      if (m && typeof m.method === "string" && m.method.startsWith("ui/notifications/sandbox-")) return; // not for the View
      inner?.contentWindow?.postMessage(m, "*"); // opaque-origin target
    } else if (inner && e.source === inner.contentWindow) {
      parent.postMessage(e.data, hostOrigin || "*");
    }
  });

  parent.postMessage({ jsonrpc: "2.0", method: READY, params: {} }, hostOrigin || "*");
}
