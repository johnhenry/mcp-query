// EXPERIMENTAL, MAY CHANGE. Gate policy for the MCP files extension (`io.modelcontextprotocol/files`,
// Experimental upstream, no SEP). See packages/mcp-query/docs/files-extension.md.
//
// Owner decision (binding): uploads bypass the gate by design (the client sends bytes straight to a URL the
// server names), so the gate DENIES them unless every upload URL's host is on `allowUploadHosts`. Download
// URLs in results follow the same allowlist. Allowed uploads are audited with file name, size, digest and
// host, never content and never the URL (the client puts those on the audit entry's `files`).
//
// Self-contained on purpose: it needs only the shape of the wire, not a newer @johnhenry/mcp-query.

import { AuthorizationError } from "@johnhenry/mcp-query/server";
import type { Operation, RequestInterceptor } from "@johnhenry/mcp-query";

const FILES_EXT = "io.modelcontextprotocol/files";
const FILE_KEYWORD = "x-mcp-file";

/** Gate policy for the experimental files extension. Set as `GateConfig.experimental.files`. */
export interface GateFilesPolicy {
  /**
   * Host globs (`files.example.com`, `*.storage.example.com`) an upload target URL must match. Empty or
   * absent: every upload round is refused (the default, with or without this policy).
   */
  allowUploadHosts?: string[];
  /** Host globs a download target URL in a result (or in `client.fetchDownload`) must match. Empty or absent: none match. */
  allowDownloadHosts?: string[];
  /**
   * What happens to a download target whose host is not allowed: `"strip"` (default) removes just that entry
   * from the result's `_meta`; `"refuse"` fails the whole call.
   */
  downloads?: "strip" | "refuse";
  /** Refuse a call whose `x-mcp-file` argument is larger than this many bytes (the tool's own `maxSize` still applies). */
  maxFileSize?: number;
  /** MIME allowlist for `x-mcp-file` arguments (`application/pdf`, `image/*`). Absent: any type. */
  accept?: string[];
  /** Let the gate's own client declare `upload` and perform allowlisted uploads itself (library mode). Default false. */
  upload?: boolean;
  /** Let the gate's own client declare `download` to upstreams. Default false. */
  download?: boolean;
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
export function hostAllowed(host: string, globs: readonly string[] | undefined): boolean {
  if (!globs?.length) return false;
  return globs.some((g) => new RegExp("^" + g.toLowerCase().split("*").map(escapeRe).join(".*") + "$").test(host.toLowerCase()));
}

function acceptAllows(accept: readonly string[], mime: string): boolean {
  const mt = mime.toLowerCase().split(";")[0]!.trim();
  return accept.some((a) => {
    const x = a.toLowerCase().trim();
    return x === "*/*" || (x.endsWith("/*") ? mt.startsWith(x.slice(0, -1)) : mt === x);
  });
}

const hostOf = (target: unknown): string => {
  const url = (target as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return "(no-url)";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "(unparseable)";
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Names of the top-level params of a tool's input schema that carry `x-mcp-file`. */
function fileParams(def: Operation["def"]): string[] {
  const props = (def?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Object.entries(props ?? {}).filter(([, v]) => isRecord(v) && v[FILE_KEYWORD] !== undefined && v[FILE_KEYWORD] !== false).map(([k]) => k);
}

/**
 * The interceptor. Always installed by the gate (so an upstream `upload_required` is refused by default); the
 * download and argument limits apply only when `experimental.files` is configured, so a gate without it
 * behaves exactly as before.
 */
export function filesGuard(policy: GateFilesPolicy | undefined): RequestInterceptor {
  return async (op, next) => {
    // The client's own upload / download step, as a separate operation: judge the host before any bytes move.
    if (op.kind === "extension" && (op.method === "files/upload" || op.method === "files/download")) {
      const upload = op.method === "files/upload";
      const host = String((op.args as { host?: unknown } | undefined)?.host ?? op.target);
      if (!hostAllowed(host, upload ? policy?.allowUploadHosts : policy?.allowDownloadHosts)) {
        throw new AuthorizationError(`file ${upload ? "upload" : "download"} to host "${host}" refused: not on the gate's ${upload ? "allowUploadHosts" : "allowDownloadHosts"}`);
      }
      return next(op);
    }
    if (op.kind !== "call" && op.kind !== "query") return next(op);

    // Argument limits (policy-configured gates only).
    if (policy && (policy.maxFileSize !== undefined || policy.accept)) {
      for (const param of fileParams(op.def)) {
        const v = op.args?.[param];
        if (!isRecord(v)) continue;
        if (policy.maxFileSize !== undefined && typeof v.size === "number" && v.size > policy.maxFileSize) {
          throw new AuthorizationError(`file argument "${param}" refused: ${v.size} bytes exceeds the gate's maxFileSize of ${policy.maxFileSize}`);
        }
        if (policy.accept && typeof v.mimeType === "string" && !acceptAllows(policy.accept, v.mimeType)) {
          throw new AuthorizationError(`file argument "${param}" refused: ${v.mimeType} is not on the gate's accept list`);
        }
      }
    }

    const result = await next(op);
    if (!isRecord(result)) return result;

    // An upload round that reached the gate unhandled: deny by default, name the hosts, never the URLs.
    if (result.resultType === "upload_required") {
      const uploads = Array.isArray(result.uploads) ? result.uploads : [];
      const hosts = [...new Set(uploads.map(hostOf))];
      const blocked = hosts.filter((h) => !hostAllowed(h, policy?.allowUploadHosts));
      op.state.files = { phase: "upload", hosts, action: "refused" };
      if (blocked.length > 0 || hosts.length === 0) {
        throw new AuthorizationError(
          `upload_required refused: ${blocked.length ? `upload host(s) ${blocked.join(", ")} not on the gate's allowUploadHosts` : "no upload hosts to check"}. Uploads bypass the gate, so it denies them unless every target host is allowlisted.`,
        );
      }
      throw new Error(`upload_required refused: its hosts (${hosts.join(", ")}) are allowlisted, but the gate does not relay upload rounds to consumers; set experimental.files.upload to let the gate's own client perform them`);
    }

    // Download targets in the result (policy-configured gates only).
    if (policy) {
      const meta = isRecord(result._meta) ? result._meta : undefined;
      const ext = meta && isRecord(meta[FILES_EXT]) ? (meta[FILES_EXT] as Record<string, unknown>) : undefined;
      const downloads = Array.isArray(ext?.downloads) ? (ext!.downloads as unknown[]) : undefined;
      if (meta && ext && downloads) {
        const kept = downloads.filter((d) => hostAllowed(hostOf(d), policy.allowDownloadHosts));
        if (kept.length < downloads.length) {
          const dropped = [...new Set(downloads.filter((d) => !kept.includes(d)).map(hostOf))];
          op.state.files = { phase: "download", hosts: dropped, action: policy.downloads === "refuse" ? "refused" : "stripped" };
          if (policy.downloads === "refuse") {
            throw new AuthorizationError(`result refused: download host(s) ${dropped.join(", ")} not on the gate's allowDownloadHosts`);
          }
          const nextExt: Record<string, unknown> = { ...ext };
          if (kept.length) nextExt.downloads = kept;
          else delete nextExt.downloads;
          const nextMeta: Record<string, unknown> = { ...meta };
          if (Object.keys(nextExt).length) nextMeta[FILES_EXT] = nextExt;
          else delete nextMeta[FILES_EXT];
          const out: Record<string, unknown> = { ...result, _meta: nextMeta };
          if (!Object.keys(nextMeta).length) delete out._meta;
          return out;
        }
      }
    }
    return result;
  };
}
