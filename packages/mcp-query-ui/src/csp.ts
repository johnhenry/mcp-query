// CSP / Permission-Policy construction for MCP Apps resources (SEP-1865, "Content Security
// Policy Enforcement"). The host never loosens what the server declared, and it must not let
// hostile metadata inject extra directives, so every declared source is validated first.
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiResourceCsp, McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps/app-bridge";

export type CspDomainKind = "connect" | "resource" | "frame" | "baseUri";

/** A CSP host-source we are willing to emit: an http(s)/ws(s) origin (wildcard subdomain allowed), optionally with a path. */
const SAFE_SOURCE = /^(?:https?|wss?):\/\/(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&()*+=:@%/-]*)?$/;

export function isSafeCspSource(s: unknown): s is string {
  return typeof s === "string" && s.length <= 512 && SAFE_SOURCE.test(s);
}

const KEYS: Array<[keyof McpUiResourceCsp, CspDomainKind]> = [
  ["connectDomains", "connect"],
  ["resourceDomains", "resource"],
  ["frameDomains", "frame"],
  ["baseUriDomains", "baseUri"],
];

/** Keep only well-formed, host-approved sources. Undeclared stays undeclared (restrictive default). */
export function sanitizeCsp(csp: McpUiResourceCsp | undefined, allow?: (domain: string, kind: CspDomainKind) => boolean): McpUiResourceCsp {
  const out: McpUiResourceCsp = {};
  if (!csp || typeof csp !== "object") return out;
  for (const [key, kind] of KEYS) {
    const list = csp[key];
    if (!Array.isArray(list)) continue;
    out[key] = [...new Set(list.filter(isSafeCspSource).filter((d) => (allow ? allow(d, kind) : true)))];
  }
  return out;
}

/**
 * The CSP header value a sandbox proxy must apply to the View, per the spec's "CSP Construction
 * from Metadata". With no declared domains this is exactly the spec's restrictive default.
 */
export function buildAppCsp(csp: McpUiResourceCsp = {}): string {
  const res = (csp.resourceDomains ?? []).join(" ");
  const sp = (x: string) => (res ? `${x} ${res}` : x);
  return [
    "default-src 'none'",
    `script-src ${sp("'self' 'unsafe-inline'")}`,
    `style-src ${sp("'self' 'unsafe-inline'")}`,
    `connect-src ${(csp.connectDomains ?? []).length ? `'self' ${csp.connectDomains!.join(" ")}` : "'none'"}`,
    `img-src ${sp("'self' data:")}`,
    `font-src ${sp("'self'")}`,
    `media-src ${sp("'self' data:")}`,
    `frame-src ${(csp.frameDomains ?? []).length ? csp.frameDomains!.join(" ") : "'none'"}`,
    "object-src 'none'",
    `base-uri ${(csp.baseUriDomains ?? []).length ? csp.baseUriDomains!.join(" ") : "'self'"}`,
  ].join("; ");
}

export function permissionsAllowAttribute(p: McpUiResourcePermissions | undefined): string {
  return buildAllowAttribute(p);
}
