// EXPERIMENTAL, MAY CHANGE. File uploads and downloads over MCP (`io.modelcontextprotocol/files`).
//
// The extension is Experimental upstream: it is not part of the MCP specification, has not been
// proposed as a SEP, and the draft changes under us. Everything in this file follows the draft
// at https://github.com/modelcontextprotocol/experimental-ext-file-uploads
// (specification/draft/file-uploads.md, commit 8a859b8f268926fe4beb84d78565e7cc6f9fa617) and the
// announcement post https://blog.modelcontextprotocol.io/posts/exploring-file-uploads-and-downloads-in-mcp/ .
// Nothing here runs unless the client opts in with `experimental: { files: ... }`.
//
// This module is pure (no I/O, no Node imports) so it loads in a browser bundle and in mcp-gate.

/** The extension identifier. Also the key under a result's `_meta` that carries download targets. */
export const FILES_EXT = "io.modelcontextprotocol/files";
/** The schema keyword that marks a file argument. */
export const FILE_KEYWORD = "x-mcp-file";

/** Settings object of the extension (client: `upload`/`download`; server: `upload`/`maxInlineBytes`). */
export interface FilesSettings {
  upload?: Record<string, never>;
  download?: Record<string, never>;
  maxInlineBytes?: number;
  revision?: string;
}

/** Value of `x-mcp-file` on a tool's argument schema. */
export interface FileInputDescriptor {
  /** Media types or dot-prefixed extensions for a file picker. Servers can reject a file by type. */
  accept?: string[];
  /** Maximum decoded size of each file in bytes, for inline and out-of-band transfer. */
  maxSize?: number;
}

export interface FileDigest {
  algorithm: "sha-256";
  /** base64url, no padding */
  value: string;
}

/** The wire shape of a file argument. */
export interface FileInput {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
  digest?: FileDigest;
  /** RFC 4648 base64. Absent on a non-empty file means "upload out of band". */
  data?: string;
}

export interface UploadForm {
  fields: { name: string; value: string }[];
  fileField: string;
}

export interface UploadTarget {
  fileId: string;
  url?: string;
  path?: string;
  method?: "PUT" | "POST";
  form?: UploadForm;
  headers?: Record<string, string>;
  credentials: "omit" | "include";
  expiresAt?: string;
  _meta?: Record<string, unknown>;
}

export interface DownloadTarget {
  name?: string;
  mimeType: string;
  size: number;
  digest?: FileDigest;
  url?: string;
  path?: string;
  headers?: Record<string, string>;
  credentials: "omit" | "include";
  expiresAt?: string;
  _meta?: Record<string, unknown>;
}

/** The `upload_required` result as the SDK hands it back (an extension result type). */
export interface UploadRequiredShape {
  resultType: "upload_required";
  uploads?: unknown;
  requestState?: unknown;
  [key: string]: unknown;
}

/** True for an interim `upload_required` result: never cache one, never show it to a model. */
export function isUploadRequiredResult(value: unknown): value is UploadRequiredShape {
  return typeof value === "object" && value !== null && (value as { resultType?: unknown }).resultType === "upload_required";
}

/** What a caller may pass for a file parameter. A `File` is a `Blob`. A bare string is UTF-8 text. */
export type FileValue = Blob | { name?: string; mimeType?: string; data: Blob | Uint8Array | ArrayBuffer | string };

/** Options for the experimental files support (`MCPClientConfig.experimental.files`). */
export interface ExperimentalFilesOptions {
  /**
   * Declare `upload` (the out-of-band flow). Default false: on the 2026-07-28 wire the SDK this
   * package is tested against (2.0.0) rejects `resultType: "upload_required"` before mcp-query sees
   * it, so declaring `upload` there would invite a round it cannot complete. See
   * docs/files-extension.md. Inline transfer needs no `upload`.
   */
  upload?: boolean;
  /** Declare `download` (the client accepts download targets). Default true. */
  download?: boolean;
  /** Cap, in bytes, on inline `data` per request. The effective limit is the smaller of this and the server's `maxInlineBytes`. */
  maxInlineBytes?: number;
  /** Injectable `fetch` for uploads and downloads. Defaults to the global. */
  fetch?: typeof fetch;
  /** Permit `http://` targets and loopback addresses (localhost, 127.0.0.0/8, ::1). Default false. */
  allowInsecureLocalhost?: boolean;
  /** Permit targets on private, link-local, loopback or otherwise non-global addresses. Default false. */
  allowPrivateAddresses?: boolean;
  /** Host globs (`files.example.com`, `*.storage.example.com`) a target with `credentials: "include"` may name. Default none: `include` targets are refused. */
  credentialHosts?: string[];
  /** Host globs every target must match (client-side allowlist; the gate has its own). Default: any public host. */
  allowedHosts?: string[];
  /**
   * Resolve a hostname to its addresses so a name that points at a private address is refused. The
   * browser-safe core cannot resolve names itself; in Node pass `dns.promises.lookup`-based code.
   * Without it, only IP-literal hosts and `localhost` names are checked, and DNS rebinding is NOT covered.
   */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Always send a SHA-256 `digest` (otherwise only when the tool's schema requires it). */
  digest?: boolean;
  /** Per-transfer timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Clock, for `expiresAt` checks. Default `Date.now`. */
  now?: () => number;
}

/** Audit detail of a files step. Names, sizes, digests and hosts only: never content, never a URL. */
export interface AuditFiles {
  phase: "upload" | "download";
  fileId?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  digest?: string;
  host?: string;
  method?: string;
  /** A policy (the gate) acted on these hosts without performing the step: `refused` an upload round, `stripped` download targets. */
  hosts?: string[];
  action?: "refused" | "stripped";
}

/** Normalise the config key: `true` is the defaults. */
export function resolveFilesOptions(v: boolean | ExperimentalFilesOptions | undefined): ExperimentalFilesOptions | undefined {
  if (v === undefined || v === false) return undefined;
  return v === true ? {} : v;
}

/** The `extensions` entry a client declares for these options. */
export function clientFilesSettings(o: ExperimentalFilesOptions): FilesSettings {
  return { ...(o.upload ? { upload: {} } : {}), ...(o.download === false ? {} : { download: {} }) };
}

// ── schema ────────────────────────────────────────────────────────────────

/** The top-level properties of a tool's input schema marked `x-mcp-file`. Array items and anyOf/oneOf branches are not scanned (unverified). */
export function findFileParams(inputSchema: unknown): Map<string, { descriptor: FileInputDescriptor; requiresDigest: boolean }> {
  const out = new Map<string, { descriptor: FileInputDescriptor; requiresDigest: boolean }>();
  const props = (inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || typeof props !== "object") return out;
  for (const [name, schema] of Object.entries(props)) {
    const kw = (schema as Record<string, unknown> | null)?.[FILE_KEYWORD];
    if (kw === undefined || kw === null || kw === false) continue;
    const d = typeof kw === "object" ? (kw as FileInputDescriptor) : {};
    const required = (schema as { required?: unknown }).required;
    out.set(name, {
      descriptor: {
        ...(Array.isArray(d.accept) ? { accept: d.accept.filter((x): x is string => typeof x === "string") } : {}),
        ...(typeof d.maxSize === "number" ? { maxSize: d.maxSize } : {}),
      },
      requiresDigest: Array.isArray(required) && required.includes("digest"),
    });
  }
  return out;
}

/** Does `mimeType`/`name` satisfy an `accept` list (`type/subtype`, `type/*`, `.ext`)? An empty/absent list accepts everything. */
export function acceptsFile(accept: readonly string[] | undefined, mimeType: string, name?: string): boolean {
  if (!accept || accept.length === 0) return true;
  const mt = mimeType.toLowerCase().split(";")[0]!.trim();
  const lower = (name ?? "").toLowerCase();
  return accept.some((a) => {
    const x = a.toLowerCase().trim();
    if (x.startsWith(".")) return lower.endsWith(x);
    if (x === "*/*") return true;
    if (x.endsWith("/*")) return mt.startsWith(x.slice(0, -1));
    return mt === x;
  });
}

// ── hosts and addresses ───────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a hostname against host globs (`*` matches any run of characters). Case-insensitive. */
export function hostMatches(host: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  const h = host.toLowerCase();
  return globs.some((g) => new RegExp("^" + g.toLowerCase().split("*").map(escapeRe).join(".*") + "$").test(h));
}

const stripBrackets = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "");

/** Hosts only this machine can reach (loopback addresses and `localhost` names). */
export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(host);
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::ffff:127.0.0.1") return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

function ipv4Octets(h: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : undefined;
}

/** True for an IPv4 or IPv6 literal that is not globally reachable (RFC 6890 special-purpose ranges, loopback, link-local, ULA, multicast). */
export function isNonGlobalAddress(host: string): boolean {
  const h = stripBrackets(host);
  const v4 = ipv4Octets(h);
  if (v4) {
    const [a, b, c] = v4 as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (!h.includes(":")) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) return isNonGlobalAddress(mapped[1]!);
  // ::ffff:7f00:1 style (hex-pair IPv4-mapped, as `new URL` normalises dotted forms)
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isNonGlobalAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (h === "::" || h === "::1") return true;
  const first = parseInt(h.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || h.startsWith("2001:db8:") || h === "2001:db8::";
}

// ── targets ───────────────────────────────────────────────────────────────

/** A target the client refuses. `reason` is stable and safe to log; it never contains the URL or its query. */
export class FileTargetError extends Error {
  constructor(readonly reason: string, message?: string) {
    super(message ?? `file target refused: ${reason}`);
    this.name = "FileTargetError";
  }
}

export interface TargetCheckOptions {
  allowInsecureLocalhost?: boolean;
  allowPrivateAddresses?: boolean;
  credentialHosts?: readonly string[];
  allowedHosts?: readonly string[];
  /** Milliseconds since the epoch. */
  now: number;
}

const TARGET_KEYS_UPLOAD = ["fileId", "url", "path", "method", "form", "headers", "credentials", "expiresAt", "_meta"];
const TARGET_KEYS_DOWNLOAD = ["name", "mimeType", "size", "digest", "url", "path", "headers", "credentials", "expiresAt", "_meta"];

// Fetch's forbidden request headers (https://fetch.spec.whatwg.org/#forbidden-request-header).
const FORBIDDEN_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection",
  "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "set-cookie",
  "te", "trailer", "transfer-encoding", "upgrade", "via", "authorization",
]);
const PROXY_STEERING = new Set(["forwarded", "x-original-url", "x-rewrite-url", "x-http-method-override", "x-http-method", "x-method-override"]);
const FORM_HEADERS = new Set(["content-type", "content-encoding", "content-range", "content-digest", "repr-digest"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface CheckedTarget {
  url: URL;
  method: "PUT" | "POST" | "GET";
  headers: Record<string, string>;
  credentials: "omit" | "include";
  expiresAtMs?: number;
}

/**
 * Validate one upload or download target against the draft's "Targets" rules, plus the safety
 * options. Synchronous: DNS resolution (`resolveHost`) is applied by the caller. `path` targets are
 * refused (they resolve against the MCP address, which this client does not track: unverified, not implemented).
 * A `null` member is treated as absent.
 */
export function checkTarget(raw: unknown, direction: "upload" | "download", o: TargetCheckOptions): CheckedTarget {
  if (!isRecord(raw)) throw new FileTargetError("not-an-object");
  const t: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) t[k] = v;
  const allowed = direction === "upload" ? TARGET_KEYS_UPLOAD : TARGET_KEYS_DOWNLOAD;
  for (const k of Object.keys(t)) if (!allowed.includes(k)) throw new FileTargetError("unknown-member");
  const hasUrl = t.url !== undefined;
  const hasPath = t.path !== undefined;
  if (hasUrl === hasPath) throw new FileTargetError("needs-exactly-one-of-url-and-path");
  if (hasPath) throw new FileTargetError("path-target-unsupported", "file target refused: path targets are not supported by this client");
  if (typeof t.url !== "string") throw new FileTargetError("url-not-a-string");
  if (t.credentials !== "omit" && t.credentials !== "include") throw new FileTargetError("bad-credentials");
  if (direction === "upload" && typeof t.fileId !== "string") throw new FileTargetError("missing-fileId");
  if (direction === "download" && (typeof t.mimeType !== "string" || typeof t.size !== "number" || !Number.isInteger(t.size) || t.size < 0)) {
    throw new FileTargetError("bad-download-metadata");
  }
  const method = direction === "download" ? "GET" : t.method === undefined ? "PUT" : t.method;
  if (method !== "PUT" && method !== "POST" && method !== "GET") throw new FileTargetError("bad-method");
  if (t.form !== undefined) {
    if (direction !== "upload" || method !== "POST") throw new FileTargetError("form-needs-post");
    checkForm(t.form);
  }

  let url: URL;
  try {
    url = new URL(t.url);
  } catch {
    throw new FileTargetError("unparseable-url");
  }
  if (url.username || url.password) throw new FileTargetError("userinfo-in-url");
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:") {
    if (!(loopback && o.allowInsecureLocalhost)) throw new FileTargetError("insecure-scheme", "file target refused: only https targets are accepted (http only for loopback with allowInsecureLocalhost)");
  } else if (url.protocol !== "https:") {
    throw new FileTargetError("unsupported-scheme");
  }
  const host = url.hostname;
  if (!o.allowPrivateAddresses && !(loopback && o.allowInsecureLocalhost) && (loopback || isNonGlobalAddress(host))) {
    throw new FileTargetError("private-address", "file target refused: the host is a loopback, private or link-local address");
  }
  if (o.allowedHosts && o.allowedHosts.length > 0 && !hostMatches(host, o.allowedHosts)) throw new FileTargetError("host-not-allowed");

  const headers: Record<string, string> = {};
  const hdrs = t.headers;
  if (hdrs !== undefined && !isRecord(hdrs)) throw new FileTargetError("bad-headers");
  const include = t.credentials === "include";
  for (const [name, value] of Object.entries(isRecord(hdrs) ? hdrs : {})) {
    const n = name.toLowerCase();
    if (typeof value !== "string" || !TOKEN.test(name) || /[\r\n\0]/.test(value)) throw new FileTargetError("bad-header");
    if (FORBIDDEN_HEADERS.has(n) || n.startsWith("proxy-") || n.startsWith("sec-")) throw new FileTargetError("forbidden-header");
    if (include && (PROXY_STEERING.has(n) || n.startsWith("x-forwarded-"))) throw new FileTargetError("proxy-steering-header");
    if (t.form !== undefined && FORM_HEADERS.has(n)) throw new FileTargetError("form-header");
    headers[name] = value;
  }
  if (include && !hostMatches(host, o.credentialHosts)) {
    throw new FileTargetError("credentials-host-not-allowed", "file target refused: credentials \"include\" is only honoured for hosts on credentialHosts");
  }
  let expiresAtMs: number | undefined;
  if (t.expiresAt !== undefined) {
    if (typeof t.expiresAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(t.expiresAt)) throw new FileTargetError("bad-expiresAt");
    expiresAtMs = Date.parse(t.expiresAt);
    if (Number.isNaN(expiresAtMs)) throw new FileTargetError("bad-expiresAt");
    if (expiresAtMs <= o.now) throw new FileTargetError("expired", "file target refused: it has expired");
  }
  return { url, method, headers, credentials: t.credentials, ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) };
}

function checkForm(form: unknown): void {
  if (!isRecord(form) || !Array.isArray(form.fields) || typeof form.fileField !== "string") throw new FileTargetError("bad-form");
  const bad = (s: string) => s === "" || /[\u0000-\u001f\u007f"\\]/.test(s);
  if (bad(form.fileField)) throw new FileTargetError("bad-form");
  for (const f of form.fields) {
    if (!isRecord(f) || typeof f.name !== "string" || typeof f.value !== "string") throw new FileTargetError("bad-form");
    if (bad(f.name) || f.name === form.fileField || /[\r\n\0]/.test(f.value)) throw new FileTargetError("bad-form");
  }
}

// ── results ───────────────────────────────────────────────────────────────

/** The raw `downloads` entries of a result's `_meta` (unvalidated), or []. */
export function downloadsOf(result: unknown): unknown[] {
  const meta = (result as { _meta?: Record<string, unknown> } | null | undefined)?._meta;
  const d = (meta?.[FILES_EXT] as { downloads?: unknown } | undefined)?.downloads;
  return Array.isArray(d) ? d : [];
}

/**
 * Milliseconds until the earliest `expiresAt` among a result's download targets (0 once expired), or
 * undefined if the result carries none. A cached copy must not outlive this.
 */
export function downloadTtlMs(result: unknown, now: number = Date.now()): number | undefined {
  const downloads = downloadsOf(result);
  if (downloads.length === 0) return undefined;
  let min: number | undefined;
  for (const d of downloads) {
    const e = (d as { expiresAt?: unknown } | null)?.expiresAt;
    const ms = typeof e === "string" ? Date.parse(e) : NaN;
    // A target with no (or an unparseable) expiry is treated as already stale: no basis for keeping it.
    const left = Number.isNaN(ms) ? 0 : Math.max(0, ms - now);
    min = min === undefined ? left : Math.min(min, left);
  }
  return min;
}

/** The staleTime to cache `result` with: `base`, but no longer than its downloads' expiry. */
export function capStaleByDownloads(result: unknown, base: number | undefined, now: number = Date.now()): number | undefined {
  const ttl = downloadTtlMs(result, now);
  if (ttl === undefined) return base;
  return base === undefined ? ttl : Math.min(base, ttl);
}

/** Describe a files step for the audit trail (no URLs, no content). */
export function auditFilesFor(phase: "upload" | "download", t: { fileId?: string; name?: string; mimeType?: string; size?: number; digest?: FileDigest; method?: string }, host: string): AuditFiles {
  return {
    phase,
    ...(t.fileId !== undefined ? { fileId: t.fileId } : {}),
    ...(t.name !== undefined ? { name: t.name } : {}),
    ...(t.mimeType !== undefined ? { mimeType: t.mimeType } : {}),
    ...(t.size !== undefined ? { size: t.size } : {}),
    ...(t.digest ? { digest: `${t.digest.algorithm}:${t.digest.value}` } : {}),
    host,
    ...(t.method ? { method: t.method } : {}),
  };
}
