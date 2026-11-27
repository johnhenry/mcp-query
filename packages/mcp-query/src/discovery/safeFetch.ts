// Hardened JSON GET used for every discovery fetch. Discovery documents come from hosts the
// user does not control, so the fetch is deliberately narrow:
//   - HTTPS only (http allowed solely for loopback hosts, and only behind an explicit option)
//   - no credentials, no cookies, no request body
//   - redirects are followed by hand and only within the SAME origin (scheme+host+port)
//   - response size cap enforced while streaming (a lying Content-Length cannot bypass it)
//   - total timeout, content-type allow-list, strict JSON parse
//   - `fetch` is injectable (tests, proxies, custom agents)

export type DiscoveryErrorCode =
  | "invalid_url"
  | "insecure_url"
  | "redirect_blocked"
  | "too_many_redirects"
  | "http_error"
  | "bad_content_type"
  | "too_large"
  | "timeout"
  | "network"
  | "malformed_json"
  | "invalid_document"
  | "unsupported_version";

export class DiscoveryError extends Error {
  constructor(
    readonly code: DiscoveryErrorCode,
    message: string,
    readonly url?: string,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export interface SafeFetchOptions {
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
  /** Permit `http://` for loopback hosts (localhost, 127.0.0.0/8, ::1, *.localhost). Default false. */
  allowInsecureLocalhost?: boolean;
  /** Max response body in bytes. Default 262144 (256 KiB). */
  maxBytes?: number;
  /** Total time budget in ms across redirects. Default 10000. */
  timeoutMs?: number;
  /** Same-origin redirects to follow. Default 3. Cross-origin redirects are always refused. */
  maxRedirects?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
}

export const DEFAULT_MAX_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 3;

/** True for hosts that only this machine can reach. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Parse + vet a URL for discovery use. Throws DiscoveryError. */
export function assertFetchableUrl(raw: string, allowInsecureLocalhost = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DiscoveryError("invalid_url", `not a valid URL: ${truncate(raw)}`, raw);
  }
  if (u.username || u.password) throw new DiscoveryError("invalid_url", "URLs with embedded credentials are refused", u.origin);
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && allowInsecureLocalhost && isLoopbackHost(u.hostname)) return u;
  throw new DiscoveryError(
    "insecure_url",
    u.protocol === "http:"
      ? `refusing plain http for ${u.origin} (https only; loopback needs allowInsecureLocalhost)`
      : `unsupported URL scheme "${u.protocol}"`,
    u.origin,
  );
}

export interface SafeFetchResult {
  /** Final URL after same-origin redirects. */
  url: string;
  json: unknown;
  contentType: string;
  bytes: number;
  etag?: string;
}

/**
 * GET `url` and return parsed JSON. `acceptTypes` is both the `Accept` header (in order)
 * and the allow-list the response `Content-Type` must match (parameters ignored).
 */
export async function safeFetchJson(url: string, acceptTypes: string[], opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowed = acceptTypes.map((t) => t.toLowerCase());

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  let current = assertFetchableUrl(url, opts.allowInsecureLocalhost);
  const origin = current.origin;

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await doFetch(current.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: acceptTypes.join(", ") },
        signal,
      });
    } catch (err) {
      if (timeoutSignal.aborted) throw new DiscoveryError("timeout", `timed out after ${timeoutMs}ms`, current.origin);
      if (opts.signal?.aborted) throw err;
      throw new DiscoveryError("network", `request failed: ${err instanceof Error ? err.message : String(err)}`, current.origin);
    }

    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      void res.body?.cancel().catch(() => {});
      const loc = res.headers.get("location");
      if (!loc) throw new DiscoveryError("http_error", `HTTP ${res.status} without a Location header`, current.href);
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new DiscoveryError("redirect_blocked", "redirect to an unparseable Location", current.href);
      }
      if (next.origin !== origin) {
        throw new DiscoveryError("redirect_blocked", `refusing cross-origin redirect to ${next.origin}`, current.href);
      }
      if (hop >= maxRedirects) throw new DiscoveryError("too_many_redirects", `more than ${maxRedirects} redirects`, current.href);
      current = assertFetchableUrl(next.href, opts.allowInsecureLocalhost);
      continue;
    }

    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new DiscoveryError("http_error", `HTTP ${res.status}`, current.href);
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!allowed.includes(contentType)) {
      void res.body?.cancel().catch(() => {});
      throw new DiscoveryError("bad_content_type", `unexpected content-type "${truncate(contentType) || "(none)"}" (expected ${allowed.join(" or ")})`, current.href);
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new DiscoveryError("too_large", `response declares ${declared} bytes (cap ${maxBytes})`, current.href);
    }

    const text = await readCapped(res, maxBytes, current.href, signal, timeoutSignal, timeoutMs);
    let json: unknown;
    try {
      json = JSON.parse(text.text);
    } catch {
      throw new DiscoveryError("malformed_json", "response body is not valid JSON", current.href);
    }
    const etag = res.headers.get("etag") ?? undefined;
    return { url: current.href, json, contentType, bytes: text.bytes, ...(etag ? { etag } : {}) };
  }
}

async function readCapped(
  res: Response,
  maxBytes: number,
  url: string,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DiscoveryError("too_large", `response exceeded the ${maxBytes}-byte cap`, url);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof DiscoveryError) throw err;
    if (timeoutSignal.aborted) throw new DiscoveryError("timeout", `timed out after ${timeoutMs}ms`, url);
    throw new DiscoveryError("network", `read failed: ${err instanceof Error ? err.message : String(err)}`, url);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf), bytes: total };
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
