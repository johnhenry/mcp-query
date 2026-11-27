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

// ── Host-configurable frame policy (issue #66) ──────────────────────────────────────────────
// The app's declared CSP is the CEILING. A host may tighten it freely; anything that would add
// sources the app/spec did not already grant needs the explicit `unsafeLoosen` opt-in.

/** Host-supplied CSP configuration (`AppHostOptions.frame.csp`). */
export interface HostCspOptions {
  /**
   * Extra / overriding CSP directives, e.g. `{ "connect-src": "'none'", "form-action": "'none'", "report-uri": "https://csp.host.example/r" }`.
   * Without `unsafeLoosen`, each fetch directive must be a SUBSET of what the spec-derived policy already
   * allows (so it can only narrow), and directives the policy lacks must be restrictive-only ones
   * (`form-action`, `frame-ancestors`, `sandbox`, `report-uri`, `report-to`, ...). `open()` throws otherwise.
   */
  directives?: Record<string, string | readonly string[]>;
  /** Domains the host adds on top of what the app declared. LOOSENING: requires `unsafeLoosen`. */
  addDomains?: McpUiResourceCsp;
  /**
   * Explicit opt-in to loosening: lets `directives` replace a directive with a wider one and lets `addDomains`
   * widen the declared sources. Sources are still syntax-checked. Never needed to tighten.
   */
  unsafeLoosen?: boolean;
}

/** Fetch directives: when absent they fall back to `default-src`, so adding one can widen the policy. */
const FETCH_DIRECTIVES = new Set([
  "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr",
  "connect-src", "img-src", "font-src", "media-src", "frame-src", "child-src", "worker-src", "manifest-src", "object-src", "prefetch-src",
]);
/** Directives that can only restrict (or report) when they are not already present. */
const RESTRICTIVE_WHEN_NEW = new Set([
  "form-action", "frame-ancestors", "sandbox", "report-uri", "report-to", "upgrade-insecure-requests", "block-all-mixed-content",
  "require-trusted-types-for", "navigate-to",
]);
const DIRECTIVE_NAME = /^[a-z][a-z0-9-]*$/;
const DIRECTIVE_TOKEN = /^[\x21-\x7e]+$/; // visible ASCII, no whitespace

function parseDirectiveValue(name: string, value: string | readonly string[]): string[] {
  const tokens = (typeof value === "string" ? value.split(/\s+/) : [...value]).map((t) => String(t).trim()).filter(Boolean);
  for (const t of tokens) {
    if (!DIRECTIVE_TOKEN.test(t) || /[;,]/.test(t)) throw new Error(`frame.csp.directives[${JSON.stringify(name)}]: invalid source ${JSON.stringify(t)}`);
  }
  return tokens;
}

/** Validate the shape of a host CSP config (throws on syntax problems / loosening without the opt-in). Cheap; run at `createAppHost`. */
export function assertHostCspOptions(o: HostCspOptions | undefined): void {
  if (!o) return;
  if (o.addDomains && !o.unsafeLoosen) {
    throw new Error("frame.csp.addDomains adds sources the app did not declare (it loosens the CSP); set frame.csp.unsafeLoosen: true to opt in");
  }
  for (const [name, value] of Object.entries(o.directives ?? {})) {
    if (!DIRECTIVE_NAME.test(name.toLowerCase())) throw new Error(`frame.csp.directives: invalid directive name ${JSON.stringify(name)}`);
    parseDirectiveValue(name, value);
  }
}

/** Does allowed source `b` cover candidate `v`? Exact match, or `scheme://*.host` covering a subdomain, or an origin covering a path under it. */
function sourceCovers(b: string, v: string): boolean {
  if (b.toLowerCase() === v.toLowerCase()) return true;
  const mb = /^([a-z]+):\/\/(\*\.)?([^/:]+)(:\d+)?(\/.*)?$/i.exec(b);
  const mv = /^([a-z]+):\/\/(\*\.)?([^/:]+)(:\d+)?(\/.*)?$/i.exec(v);
  if (!mb || !mv || mb[1]!.toLowerCase() !== mv[1]!.toLowerCase()) return false;
  if ((mb[4] ?? "") !== (mv[4] ?? "")) return false;
  const bHost = mb[3]!.toLowerCase();
  const vHost = mv[3]!.toLowerCase();
  const hostOk = mb[2] ? vHost.endsWith(`.${bHost}`) || (mv[2] !== undefined && vHost === bHost) : !mv[2] && vHost === bHost;
  if (!hostOk) return false;
  // a path-less base covers any path; a base path must prefix the candidate's
  return !mb[5] || (mv[5] !== undefined && mv[5].startsWith(mb[5]));
}

function isNarrowerOrEqual(next: readonly string[], base: readonly string[]): boolean {
  if (next.length === 0) return true; // an empty fetch directive blocks everything
  return next.every((t) => t.toLowerCase() === "'none'" || base.some((b) => sourceCovers(b, t)));
}

function parseHeader(header: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) m.set(name.toLowerCase(), rest);
  }
  return m;
}

/**
 * Apply the host's directives to the spec-derived header. Narrowing only unless `unsafeLoosen`.
 * Directive order of the base header is preserved; new directives are appended.
 */
export function applyHostCspDirectives(baseHeader: string, directives: Record<string, string | readonly string[]>, opts: { unsafeLoosen?: boolean } = {}): string {
  const policy = parseHeader(baseHeader);
  for (const [rawName, value] of Object.entries(directives)) {
    const name = rawName.toLowerCase();
    if (!DIRECTIVE_NAME.test(name)) throw new Error(`frame.csp.directives: invalid directive name ${JSON.stringify(rawName)}`);
    const tokens = parseDirectiveValue(rawName, value);
    if (!opts.unsafeLoosen) {
      const existing = policy.get(name) ?? (FETCH_DIRECTIVES.has(name) ? policy.get("default-src") : undefined);
      if (existing) {
        if (!isNarrowerOrEqual(tokens, existing)) {
          throw new Error(`frame.csp.directives[${JSON.stringify(rawName)}] would loosen the app's CSP (allowed: ${existing.join(" ") || "nothing"}); narrow it, or set frame.csp.unsafeLoosen: true to opt in`);
        }
      } else if (!RESTRICTIVE_WHEN_NEW.has(name)) {
        throw new Error(`frame.csp.directives[${JSON.stringify(rawName)}] is not a directive the host may add without frame.csp.unsafeLoosen: true`);
      }
    }
    policy.set(name, tokens);
  }
  return [...policy].map(([n, t]) => (t.length ? `${n} ${t.join(" ")}` : n)).join("; ");
}

/** Merge host-added domains (already gated by `unsafeLoosen`) into a sanitized CSP. Every source is syntax-checked. */
export function mergeHostDomains(csp: McpUiResourceCsp, add: McpUiResourceCsp | undefined): McpUiResourceCsp {
  if (!add) return csp;
  const extra = sanitizeCsp(add);
  const out: McpUiResourceCsp = { ...csp };
  for (const [key] of KEYS) {
    if (extra[key]?.length) out[key] = [...new Set([...(csp[key] ?? []), ...extra[key]!])];
  }
  return out;
}

/** Host-supplied Permission-Policy configuration (`AppHostOptions.frame.permissions`). */
export interface HostPermissionOptions {
  /** Narrow what the app declared: return false to drop a permission. */
  allow?: (permission: keyof McpUiResourcePermissions) => boolean;
  /** Permissions the host grants beyond the app's declaration. LOOSENING: requires `unsafeLoosen`. */
  add?: McpUiResourcePermissions;
  /** Explicit opt-in to granting permissions the app did not declare. */
  unsafeLoosen?: boolean;
}

const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const;

export function assertHostPermissionOptions(o: HostPermissionOptions | undefined): void {
  if (o?.add && Object.keys(o.add).length && !o.unsafeLoosen) {
    throw new Error("frame.permissions.add grants permissions the app did not declare (it loosens the allow list); set frame.permissions.unsafeLoosen: true to opt in");
  }
}

export function applyHostPermissions(declared: McpUiResourcePermissions | undefined, o: HostPermissionOptions | undefined): McpUiResourcePermissions | undefined {
  if (!o) return declared;
  const out: McpUiResourcePermissions = {};
  for (const k of PERMISSION_KEYS) {
    if (declared?.[k] && (o.allow ? o.allow(k) : true)) out[k] = declared[k];
    else if (o.add?.[k] && o.unsafeLoosen) out[k] = o.add[k];
  }
  return declared === undefined && Object.keys(out).length === 0 ? undefined : out;
}
