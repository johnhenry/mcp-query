// EXPERIMENTAL, MAY CHANGE. The I/O half of the files extension: turning caller values into
// `FileInput` arguments, performing an upload, fetching a download. See filesExt.ts for the shapes
// and sources, and docs/files-extension.md for what is unverified.
//
// Browser-safe (fetch, Blob, crypto.subtle, TextEncoder only). `fetch` is injectable.

import {
  acceptsFile,
  checkTarget,
  FileTargetError,
  findFileParams,
  isLoopbackHost,
  isNonGlobalAddress,
  type CheckedTarget,
  type DownloadTarget,
  type ExperimentalFilesOptions,
  type FileDigest,
  type FileInput,
  type FileValue,
  type UploadTarget,
} from "./filesExt.js";

const enc = new TextEncoder();

/** A file the caller supplied, normalised: its bytes and the `FileInput` metadata that goes on the wire. */
export interface PreparedFile {
  param: string;
  input: FileInput;
  bytes: Uint8Array;
  /** Base64 of the bytes, present when the file travels inline. */
  inlineData?: string;
}

export interface PreparedFiles {
  /** The arguments to send: file params replaced by `FileInput`s WITHOUT `data` (inline data is attached at send time). */
  args: Record<string, unknown>;
  files: PreparedFile[];
  /** True if at least one non-empty file must be uploaded out of band. */
  needsUpload: boolean;
}

/** Server-side limits the client reads from the advertised extension settings. */
export interface ServerFilesCaps {
  advertised: boolean;
  upload: boolean;
  maxInlineBytes: number;
}

export function serverFilesCaps(setting: unknown): ServerFilesCaps {
  if (setting === undefined || setting === null || typeof setting !== "object") return { advertised: false, upload: false, maxInlineBytes: 0 };
  const s = setting as { upload?: unknown; maxInlineBytes?: unknown };
  const max = typeof s.maxInlineBytes === "number" && s.maxInlineBytes > 0 ? s.maxInlineBytes : 0;
  return { advertised: true, upload: s.upload !== undefined && s.upload !== null && s.upload !== false, maxInlineBytes: max };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of `bytes` as the extension's `digest` object. */
export async function sha256Digest(bytes: Uint8Array): Promise<FileDigest> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as never));
  return { algorithm: "sha-256", value: toBase64Url(d) };
}

async function bytesOf(data: Blob | Uint8Array | ArrayBuffer | string): Promise<Uint8Array> {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

/** Does this look like a hand-built wire `FileInput` (so it is passed through, not re-read)? */
function isWireFileInput(v: unknown): v is FileInput {
  return typeof v === "object" && v !== null && typeof (v as FileInput).id === "string" && typeof (v as FileInput).mimeType === "string" && typeof (v as FileInput).size === "number";
}

export class FilesUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesUsageError";
  }
}

/**
 * Replace each file parameter (`x-mcp-file`) in `args` that carries a `Blob`/`File`/`{ name, mimeType, data }`
 * with its `FileInput` metadata. Checks `accept` and `maxSize` first. Files go inline while the running
 * total stays within the effective `maxInlineBytes`; the rest need an out-of-band upload.
 */
export async function prepareFileArgs(
  inputSchema: unknown,
  args: Record<string, unknown>,
  caps: ServerFilesCaps,
  o: ExperimentalFilesOptions,
): Promise<PreparedFiles | undefined> {
  const params = findFileParams(inputSchema);
  const touched = [...params.keys()].filter((k) => args[k] !== undefined && args[k] !== null);
  if (touched.length === 0) return undefined;
  if (!caps.advertised) {
    throw new FilesUsageError("the server did not advertise the experimental files extension (io.modelcontextprotocol/files); not sending a file");
  }
  const budget = Math.min(caps.maxInlineBytes, o.maxInlineBytes ?? Infinity);
  let inlineUsed = 0;
  const out: Record<string, unknown> = { ...args };
  const files: PreparedFile[] = [];
  let needsUpload = false;
  let seq = 0;
  for (const param of touched) {
    const { descriptor, requiresDigest } = params.get(param)!;
    const v = args[param];
    let name: string | undefined;
    let mimeType: string;
    let bytes: Uint8Array;
    let wire: FileInput | undefined;
    if (isWireFileInput(v)) {
      // Caller-built FileInput: trusted as given; if it already carries `data` it counts as inline.
      wire = v;
      mimeType = v.mimeType;
      name = v.name;
      bytes = v.data !== undefined ? Uint8Array.from(atob(v.data), (c) => c.charCodeAt(0)) : new Uint8Array(0);
    } else if (typeof Blob !== "undefined" && v instanceof Blob) {
      name = (v as File).name;
      mimeType = v.type || "application/octet-stream";
      bytes = await bytesOf(v);
    } else if (typeof v === "object" && v !== null && "data" in v) {
      const fv = v as Exclude<FileValue, Blob>;
      name = fv.name;
      mimeType = fv.mimeType ?? (typeof fv.data === "object" && "type" in fv.data && (fv.data as Blob).type ? (fv.data as Blob).type : "application/octet-stream");
      bytes = await bytesOf(fv.data);
    } else {
      throw new FilesUsageError(`parameter "${param}" is marked x-mcp-file: pass a Blob, a File or { name, mimeType, data }`);
    }
    const size = wire ? wire.size : bytes.byteLength;
    if (descriptor.maxSize !== undefined && size > descriptor.maxSize) {
      throw new FilesUsageError(`parameter "${param}": ${size} bytes exceeds the tool's maxSize of ${descriptor.maxSize}`);
    }
    if (!acceptsFile(descriptor.accept, mimeType, name)) {
      throw new FilesUsageError(`parameter "${param}": ${mimeType} is not accepted by the tool (accept: ${descriptor.accept!.join(", ")})`);
    }
    if (wire) {
      const { data: _inline, ...meta } = wire;
      out[param] = meta;
      const pf: PreparedFile = { param, input: meta, bytes };
      if (wire.data !== undefined) {
        inlineUsed += size;
        pf.inlineData = wire.data;
      } else if (size > 0) needsUpload = true;
      files.push(pf);
      continue;
    }
    const input: FileInput = {
      id: `file-${++seq}`,
      ...(name ? { name } : {}),
      mimeType,
      size,
      ...(requiresDigest || o.digest ? { digest: await sha256Digest(bytes) } : {}),
    };
    const pf: PreparedFile = { param, input, bytes };
    if (size > 0) {
      if (inlineUsed + size <= budget) {
        inlineUsed += size;
        pf.inlineData = toBase64(bytes);
      } else {
        if (!caps.upload) {
          throw new FilesUsageError(
            `parameter "${param}": ${size} bytes does not fit the inline limit (${budget} bytes) and the server did not advertise out-of-band upload`,
          );
        }
        if (!o.upload) {
          throw new FilesUsageError(
            `parameter "${param}": ${size} bytes does not fit the inline limit (${budget} bytes); out-of-band upload is not enabled (experimental.files.upload)`,
          );
        }
        needsUpload = true;
      }
    }
    out[param] = input;
    files.push(pf);
  }
  return { args: out, files, needsUpload };
}

/** The arguments as they go on the wire: the prepared metadata plus each inline file's `data`. */
export function wireArgs(args: Record<string, unknown>, prepared: PreparedFiles): Record<string, unknown> {
  const out = { ...args };
  for (const f of prepared.files) {
    if (f.inlineData === undefined) continue;
    const cur = out[f.param];
    out[f.param] = { ...(typeof cur === "object" && cur !== null ? (cur as object) : f.input), data: f.inlineData };
  }
  return out;
}

// ── upload ────────────────────────────────────────────────────────────────

const randomHex = (n: number): string => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

function quoteDisposition(s: string): string {
  return s.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(\s*;.*)?$/;

function baseName(name: string | undefined): string {
  if (!name) return "file";
  const b = name.split(/[\\/]/).pop() ?? "";
  return b === "" || b === "." || b === ".." ? "file" : b;
}

/** Build the `multipart/form-data` body of a `form` upload target (draft: fields in order, then the file, 128-bit boundary). */
export function buildMultipart(form: NonNullable<UploadTarget["form"]>, file: { name?: string; mimeType: string; bytes: Uint8Array }): { body: Uint8Array; contentType: string } {
  const boundary = `----mcpquery${randomHex(16)}`;
  const parts: Uint8Array[] = [];
  for (const f of form.fields) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quoteDisposition(f.name)}"\r\n\r\n${f.value}\r\n`));
  }
  const ct = MEDIA_TYPE.test(file.mimeType) ? file.mimeType : "application/octet-stream";
  parts.push(
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quoteDisposition(form.fileField)}"; filename="${quoteDisposition(baseName(file.name))}"\r\nContent-Type: ${ct}\r\n\r\n`),
    file.bytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  );
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) (body.set(p, off), (off += p.byteLength));
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A transfer that did not succeed. The message names the host and status, never the URL or its query. */
export class FileTransferError extends Error {
  constructor(message: string, readonly host?: string, readonly status?: number) {
    super(message);
    this.name = "FileTransferError";
  }
}

async function guardAddress(host: string, o: ExperimentalFilesOptions): Promise<void> {
  if (!o.resolveHost || o.allowPrivateAddresses) return;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return; // IP literal: checked by checkTarget
  if (o.allowInsecureLocalhost && isLoopbackHost(host)) return;
  const addrs = await o.resolveHost(host);
  if (addrs.length === 0 || addrs.some((a) => isNonGlobalAddress(a))) {
    throw new FileTargetError("private-address", "file target refused: the host resolves to a loopback, private or link-local address");
  }
}

/** Validate a target, resolve its host if `resolveHost` is set, and return the vetted request description. */
export async function vetTarget(raw: unknown, direction: "upload" | "download", o: ExperimentalFilesOptions): Promise<CheckedTarget> {
  const checked = checkTarget(raw, direction, {
    allowInsecureLocalhost: o.allowInsecureLocalhost,
    allowPrivateAddresses: o.allowPrivateAddresses,
    credentialHosts: o.credentialHosts,
    allowedHosts: o.allowedHosts,
    now: (o.now ?? Date.now)(),
  });
  await guardAddress(checked.url.hostname, o);
  return checked;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/**
 * Send one file to a vetted upload target. HTTPS PUT (or the target's method; multipart for `form`),
 * no redirects, `credentials: "omit"` unless the target is `include` on an allowlisted host. Resolves
 * on a 2xx response; rejects otherwise (a 3xx, 401 and 403 included). Never sends more than the declared size.
 */
export async function uploadFile(
  raw: UploadTarget,
  checked: CheckedTarget,
  file: { name?: string; mimeType: string; size: number; bytes: Uint8Array },
  o: ExperimentalFilesOptions,
  signal?: AbortSignal,
): Promise<{ status: number }> {
  const host = checked.url.hostname;
  if (file.bytes.byteLength !== file.size) throw new FileTransferError(`refusing to upload to ${host}: ${file.bytes.byteLength} bytes held but ${file.size} declared`, host);
  const doFetch = o.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { ...checked.headers };
  let body: Uint8Array = file.bytes;
  if (raw.form) {
    const built = buildMultipart(raw.form, file);
    body = built.body;
    headers["Content-Type"] = built.contentType;
  }
  let res: Response;
  try {
    res = await doFetch(checked.url.href, {
      method: checked.method,
      headers,
      body: body as never,
      redirect: "manual",
      credentials: checked.credentials,
      signal: withTimeout(signal, o.timeoutMs ?? 60_000),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new FileTransferError(`upload to ${host} failed: ${err instanceof Error ? err.name : "error"}`, host);
  }
  void res.body?.cancel().catch(() => {});
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new FileTransferError(`upload to ${host} was redirected (${res.status}); redirects are refused`, host, res.status);
  if (res.status < 200 || res.status >= 300) throw new FileTransferError(`upload to ${host} failed with HTTP ${res.status}`, host, res.status);
  return { status: res.status };
}

// ── download ──────────────────────────────────────────────────────────────

/**
 * GET one vetted download target into memory. Aborts as soon as more than `size` bytes arrive,
 * checks the final length and, if present, the SHA-256 `digest`, and discards a file that fails.
 * `name`, `mimeType`, `size` and the bytes are untrusted: this never writes to disk.
 */
export async function downloadFile(
  target: DownloadTarget,
  checked: CheckedTarget,
  o: ExperimentalFilesOptions,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; name?: string; mimeType: string }> {
  const host = checked.url.hostname;
  const doFetch = o.fetch ?? globalThis.fetch;
  const sig = withTimeout(signal, o.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await doFetch(checked.url.href, { method: "GET", headers: checked.headers, redirect: "manual", credentials: checked.credentials, signal: sig });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new FileTransferError(`download from ${host} failed: ${err instanceof Error ? err.name : "error"}`, host);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    void res.body?.cancel().catch(() => {});
    throw new FileTransferError(`download from ${host} was redirected (${res.status}); redirects are refused`, host, res.status);
  }
  if (res.status !== 200 && res.status !== 206) {
    void res.body?.cancel().catch(() => {});
    throw new FileTransferError(`download from ${host} failed with HTTP ${res.status}`, host, res.status);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > target.size) {
        await reader.cancel().catch(() => {});
        throw new FileTransferError(`download from ${host} exceeded its declared size of ${target.size} bytes`, host);
      }
      chunks.push(value);
    }
  }
  if (total !== target.size) throw new FileTransferError(`download from ${host}: received ${total} bytes, declared ${target.size}`, host);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) (bytes.set(c, off), (off += c.byteLength));
  if (target.digest) {
    const got = await sha256Digest(bytes);
    if (target.digest.algorithm !== "sha-256" || got.value !== target.digest.value) throw new FileTransferError(`download from ${host} failed its digest check`, host);
  }
  return { bytes, ...(target.name !== undefined ? { name: target.name } : {}), mimeType: target.mimeType };
}
