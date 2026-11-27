// EXPERIMENTAL files extension (io.modelcontextprotocol/files) against MockMCPServer's files fixture and
// a local HTTP sink, on the lockfile's SDK 2.0.0. The SDK rejects `resultType: "upload_required"` on the
// 2026-07-28 wire (probe tests below), so the out-of-band round-trip tests re-inject the result the way a
// future SDK would hand it back: `decodeUploadRequired` replaces only that one SDK failure.

import { afterEach, describe, expect, it } from "vitest";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { MCPClient, type CallAuditEntry } from "../src/core/client.js";
import { MCPError } from "../src/core/types.js";
import { FILES_EXT, type DownloadTarget, type UploadTarget } from "../src/core/filesExt.js";
import { sha256Digest } from "../src/core/filesTransfer.js";
import type { Operation, RequestInterceptor } from "../src/core/interceptors.js";
import { MockMCPServer, MockUploadSink, type MockReceivedFile } from "../src/testing/mockServer.js";
import { authorize } from "../src/server/index.js";

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const FILE_SCHEMA = {
  type: "object",
  properties: {
    folder: { type: "string" },
    file: {
      type: "object",
      "x-mcp-file": { accept: ["application/pdf", "text/*"], maxSize: 1_000_000 },
      properties: { id: { type: "string" }, name: { type: "string" }, mimeType: { type: "string" }, size: { type: "integer" }, data: { type: "string" } },
      required: ["id", "mimeType", "size"],
    },
  },
  required: ["file"],
};

const text = (s: string) => new Blob([s], { type: "text/plain" });
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

interface Setup {
  server: MockMCPServer;
  sink: MockUploadSink;
  client: MCPClient;
  received: MockReceivedFile[];
  audit: CallAuditEntry[];
  ops: Operation[];
}

async function setup(
  o: {
    files?: boolean | Record<string, unknown>;
    maxInlineBytes?: number;
    spec?: Record<string, unknown>;
    interceptors?: RequestInterceptor[];
    era?: "modern" | "both";
    noFilesExt?: boolean;
  } = {},
): Promise<Setup> {
  const sink = await MockUploadSink.start();
  opened.push(sink);
  const received: MockReceivedFile[] = [];
  const server = new MockMCPServer(
    {
      tools: [
        {
          name: "save",
          inputSchema: FILE_SCHEMA,
          handler: (_a, ctx) => {
            for (const f of Object.values(ctx.files ?? {})) received.push(f);
            return { content: [{ type: "text", text: "saved" }] };
          },
        },
      ],
      ...(o.noFilesExt ? {} : { files: { sink, maxInlineBytes: o.maxInlineBytes ?? 16 } }),
      ...(o.spec ?? {}),
    },
    { era: o.era ?? "modern" },
  );
  const audit: CallAuditEntry[] = [];
  const ops: Operation[] = [];
  const record: RequestInterceptor = (op, next) => (ops.push({ ...op, args: op.args ? { ...op.args } : undefined }), next(op));
  const client = new MCPClient({
    servers: { s: { transport: server.transport, versions: ["2026-07-28"], maxRetries: 0 } },
    ...(o.files === undefined ? {} : { experimental: { files: o.files as never } }),
    interceptors: [record, ...(o.interceptors ?? [])],
    onCall: (e) => void audit.push(e),
  });
  opened.push(client, server);
  await client.connect();
  return { server, sink, client, received, audit, ops };
}

/** What a future SDK would do: hand the extension result back instead of throwing UnsupportedResultType. */
function decodeUploadRequired(client: MCPClient, server: MockMCPServer): void {
  const conn = (client as unknown as { conns: Map<string, { sdk: { callTool: (...a: unknown[]) => Promise<unknown> } }> }).conns.get("s")!;
  const sdk = conn.sdk;
  const real = sdk.callTool.bind(sdk);
  sdk.callTool = async (...a: unknown[]) => {
    try {
      return await real(...a);
    } catch (e) {
      if (e instanceof SdkError && e.code === SdkErrorCode.UnsupportedResultType && (e.data as { resultType?: string })?.resultType === "upload_required") {
        return server.uploadRequests.at(-1);
      }
      throw e;
    }
  };
}

const loopback = { upload: true, allowInsecureLocalhost: true };

describe("files extension: opt-in and capability", () => {
  it("declares nothing, and leaves args alone, without the opt-in", async () => {
    const { client, server } = await setup({});
    await client.callTool("save", { folder: "f", file: { id: "x", mimeType: "text/plain", size: 0 } });
    expect(server.clientCapabilities()?.extensions?.[FILES_EXT]).toBeUndefined();
    expect(server.callLog[0]!.args).toEqual({ folder: "f", file: { id: "x", mimeType: "text/plain", size: 0 } });
    await expect(client.fetchDownload("s", { mimeType: "a/b", size: 1, url: "https://x.example/a", credentials: "omit" })).rejects.toThrow(/experimental\.files/);
  });

  it("declares download by default, upload only on request", async () => {
    const a = await setup({ files: true });
    await a.client.callTool("save", { file: text("hi") });
    expect(a.server.clientCapabilities()?.extensions?.[FILES_EXT]).toEqual({ download: {} });
    const b = await setup({ files: { upload: true, download: false } });
    await b.client.callTool("save", { file: text("hi") });
    expect(b.server.clientCapabilities()?.extensions?.[FILES_EXT]).toEqual({ upload: {} });
  });

  it("refuses to send a file to a server that did not advertise the extension", async () => {
    const { client } = await setup({ files: true, noFilesExt: true });
    await expect(client.callTool("save", { file: text("hi") })).rejects.toThrow(/did not advertise/);
  });
});

describe("files extension: inline", () => {
  it("sends a small Blob inline; interceptors and audit see metadata only", async () => {
    const { client, received, ops } = await setup({ files: true });
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    await client.callTool("save", { folder: "f", file });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ name: "note.txt", mimeType: "text/plain", size: 5, via: "inline" });
    expect(dec(received[0]!.bytes)).toBe("hello");
    const call = ops.find((o) => o.kind === "call")!;
    expect(call.args).toEqual({ folder: "f", file: { id: "file-1", name: "note.txt", mimeType: "text/plain", size: 5 } });
    expect(JSON.stringify(ops)).not.toContain("aGVsbG8"); // base64 of "hello": never in the chain
  });

  it("accepts { name, mimeType, data } and sends a digest when the schema requires one", async () => {
    const schema = structuredClone(FILE_SCHEMA);
    (schema.properties.file.required as string[]).push("digest");
    const { client, received, server } = await setup({
      files: true,
      spec: { tools: [{ name: "save", inputSchema: schema, handler: (_a: unknown, ctx: { files?: Record<string, MockReceivedFile> }) => (received.push(...Object.values(ctx.files ?? {})), { content: [] }) }] },
    });
    await client.callTool("save", { file: { name: "a.txt", mimeType: "text/plain", data: new TextEncoder().encode("abc") } });
    const wire = (server.callLog[0]!.args as { file: { digest: { algorithm: string; value: string } } }).file;
    expect(wire.digest).toEqual(await sha256Digest(new TextEncoder().encode("abc")));
  });

  it("enforces accept and maxSize before anything is sent", async () => {
    const { client, server } = await setup({ files: true });
    await expect(client.callTool("save", { file: new Blob(["x"], { type: "image/png" }) })).rejects.toThrow(/not accepted/);
    await expect(client.callTool("save", { file: new Blob([new Uint8Array(1_000_001)], { type: "text/plain" }) })).rejects.toThrow(/maxSize/);
    expect(server.callLog).toHaveLength(0);
  });

  it("explains when a file is too big to inline and uploads are not enabled", async () => {
    const { client } = await setup({ files: true });
    await expect(client.callTool("save", { file: text("x".repeat(100)) })).rejects.toThrow(/out-of-band upload is not enabled/);
  });

  it("treats an empty file as inline with no data and no upload", async () => {
    const { client, received, server } = await setup({ files: loopback });
    await client.callTool("save", { file: text("") });
    expect(received[0]).toMatchObject({ size: 0, via: "inline" });
    expect(server.uploadRequests).toHaveLength(0);
  });
});

describe("files extension: the SDK on the 2026-07-28 wire (probe)", () => {
  it("SDK 2.0.0 rejects upload_required; mcp-query says so plainly instead of hanging or uploading", async () => {
    const { client, server, sink } = await setup({ files: loopback });
    const err = (await client.callTool("save", { file: text("x".repeat(100)) }).catch((e) => e)) as MCPError;
    expect(err).toBeInstanceOf(MCPError);
    expect(err.message).toMatch(/upload_required/);
    expect(err.message).toMatch(/cannot decode/);
    expect(server.uploadRequests).toHaveLength(1);
    expect(sink.requests).toHaveLength(0);
  });

  it("on a 2025-era connection the extension is not usable: the request carries no per-request declaration, so the server refuses", async () => {
    const sink = await MockUploadSink.start();
    opened.push(sink);
    const server = new MockMCPServer({ tools: [{ name: "save", inputSchema: FILE_SCHEMA, handler: () => ({ content: [] }) }], files: { sink, maxInlineBytes: 0 } }, { era: "legacy" });
    const client = new MCPClient({ servers: { s: { transport: server.transport } }, experimental: { files: loopback } });
    opened.push(client, server);
    await client.connect();
    const res = (await client.callTool("save", { file: text("x") })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(server.uploadRequests).toHaveLength(0);
    expect(sink.requests).toHaveLength(0);
  });
});

describe("files extension: out-of-band upload round", () => {
  it("uploads to the sink, then retries with the unchanged requestState", async () => {
    const { client, server, sink, received, audit, ops } = await setup({ files: loopback });
    decodeUploadRequired(client, server);
    const body = "x".repeat(100);
    const res = await client.callTool("save", { folder: "f", file: new File([body], "big.txt", { type: "text/plain" }) });
    expect(res).toMatchObject({ content: [{ text: "saved" }] });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ name: "big.txt", size: 100, via: "upload" });
    expect(dec(received[0]!.bytes)).toBe(body);
    // The sink saw exactly one PUT with Content-Type as the target listed it, no credentials-ish headers.
    expect(sink.requests).toHaveLength(1);
    expect(sink.requests[0]).toMatchObject({ method: "PUT", path: "/u/files-1/file-1" });
    expect(sink.requests[0]!.headers["content-type"]).toBe("text/plain");
    expect(sink.requests[0]!.headers.cookie).toBeUndefined();
    expect(sink.requests[0]!.headers.authorization).toBeUndefined();
    // requestState echoed exactly.
    expect(server.fileRetries).toEqual([server.uploadRequests[0]!.requestState]);
    // The upload is its own step in the chain and in the audit trail, with no content or URL.
    const up = ops.find((o) => o.method === "files/upload")!;
    expect(up.kind).toBe("extension");
    expect(up.args).toMatchObject({ fileId: "file-1", name: "big.txt", size: 100, mimeType: "text/plain", host: "127.0.0.1", method: "PUT" });
    const entry = audit.find((a) => a.files?.phase === "upload")!;
    expect(entry).toMatchObject({ kind: "extension", outcome: "ok", files: { name: "big.txt", size: 100, host: "127.0.0.1" } });
    expect(JSON.stringify(audit)).not.toContain("/u/files-1");
    expect(JSON.stringify(audit)).not.toContain(body);
  });

  it("does not cache the interim result or a call that carried files", async () => {
    const sink = await MockUploadSink.start();
    opened.push(sink);
    const server = new MockMCPServer({ tools: [{ name: "save", inputSchema: FILE_SCHEMA, annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "ok" }] }) }], files: { sink, maxInlineBytes: 16 } }, { era: "modern" });
    const client = new MCPClient({ servers: { s: { transport: server.transport, versions: ["2026-07-28"] } }, experimental: { files: loopback } });
    opened.push(client, server);
    await client.connect();
    decodeUploadRequired(client, server);
    await client.callTool("save", { file: text("x".repeat(50)) });
    await client.callTool("save", { file: text("x".repeat(50)) });
    expect(sink.requests).toHaveLength(2); // second call uploaded again: nothing was served from a cache
  });

  it("a denying interceptor stops the upload: no bytes leave and the call is not retried", async () => {
    const deny: RequestInterceptor = (op, next) => (op.method === "files/upload" ? Promise.reject(Object.assign(new Error("uploads are not allowed to 127.0.0.1"), { code: -32003 })) : next(op));
    const { client, server, sink, audit } = await setup({ files: loopback, interceptors: [deny] });
    decodeUploadRequired(client, server);
    const err = (await client.callTool("save", { file: text("x".repeat(50)) }).catch((e) => e)) as MCPError;
    expect(err.message).toMatch(/not allowed/);
    expect(err.code).toBe(-32003);
    expect(sink.requests).toHaveLength(0);
    expect(server.fileRetries).toHaveLength(0);
    expect(audit.find((a) => a.kind === "extension")).toMatchObject({ outcome: "denied", files: { host: "127.0.0.1" } });
  });

  it("a non-2xx response, a redirect or a network failure ends the call without a retry", async () => {
    for (const mode of ["500", "redirect", "network"]) {
      const { client, server, sink } = await setup({ files: mode === "network" ? { ...loopback, fetch: () => Promise.reject(new TypeError("boom")) } : loopback });
      decodeUploadRequired(client, server);
      if (mode === "500") sink.status = 500;
      if (mode === "redirect") sink.redirectTo = "http://127.0.0.1:1/elsewhere";
      await expect(client.callTool("save", { file: text("x".repeat(50)) })).rejects.toThrow(mode === "500" ? /HTTP 500/ : mode === "redirect" ? /redirect/ : /failed/);
      expect(server.fileRetries).toHaveLength(0);
      if (mode === "redirect") expect(sink.requests).toHaveLength(1); // the redirect was not followed
    }
  });

  it("uses an injected fetch, with credentials omitted and redirects manual", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = async (url: string | URL | Request, init?: RequestInit) => (seen.push({ url: String(url), init: init! }), new Response(null, { status: 204 }));
    const { client, server } = await setup({ files: { ...loopback, fetch: fetchSpy } });
    decodeUploadRequired(client, server);
    // The injected fetch returns 204 without storing anything, so the mock reports the bytes missing: the point here is the request.
    await client.callTool("save", { file: text("x".repeat(50)) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init).toMatchObject({ method: "PUT", redirect: "manual", credentials: "omit" });
  });

  it("aborts an in-flight upload with the call's signal", async () => {
    const ac = new AbortController();
    const hang = (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason));
        setTimeout(() => ac.abort(new Error("stop")), 10);
      });
    const { client, server } = await setup({ files: { ...loopback, fetch: hang } });
    decodeUploadRequired(client, server);
    await expect(client.callTool("save", { file: text("x".repeat(50)) }, { signal: ac.signal })).rejects.toThrow();
    expect(server.fileRetries).toHaveLength(0);
  });

  it("refuses a second upload_required in one logical call", async () => {
    const sink = await MockUploadSink.start();
    opened.push(sink);
    const { client, server } = await setup({ files: loopback, spec: { files: { sink, maxInlineBytes: 16, repeatUploadRequired: true } } });
    decodeUploadRequired(client, server);
    await expect(client.callTool("save", { file: text("x".repeat(50)) })).rejects.toThrow(/second upload_required/);
    expect(server.uploadRequests).toHaveLength(2);
  });

  it("sends a form target as multipart: fields in order, then the file, quoted filename", async () => {
    const sink = await MockUploadSink.start();
    opened.push(sink);
    const target = (id: string): UploadTarget => ({ fileId: id, url: sink.url("/form"), method: "POST", form: { fields: [{ name: "key", value: "k1" }, { name: "sig", value: "s1" }], fileField: "file" }, credentials: "omit" });
    const { client, server } = await setup({ files: loopback, spec: { files: { sink, maxInlineBytes: 16, target } } });
    decodeUploadRequired(client, server);
    // The mock expects /u/<token>/<id>; a form target lands elsewhere, so the confirm step reports it missing.
    await client.callTool("save", { file: new File(["x".repeat(50)], 'we"ird\r\n/../name.txt', { type: "text/plain" }) }).catch(() => {});
    const req = sink.requests.find((r) => r.path === "/form")!;
    const ct = req.headers["content-type"]!;
    expect(ct).toMatch(/^multipart\/form-data; boundary=----mcpquery[0-9a-f]{32}$/);
    const body = dec(req.body);
    expect(body.indexOf('name="key"')).toBeLessThan(body.indexOf('name="sig"'));
    expect(body.indexOf('name="sig"')).toBeLessThan(body.indexOf('name="file"; filename="name.txt"'));
    expect(body).toContain("Content-Type: text/plain");
  });

  it("refuses unsafe targets before any bytes are sent", async () => {
    const cases: Array<[string, Partial<UploadTarget> & Record<string, unknown>, Record<string, unknown>, RegExp]> = [
      ["http to a public host", { url: "http://files.example.com/u" }, loopback, /only https/],
      ["private address", { url: "https://10.0.0.5/u" }, { upload: true }, /private|loopback/],
      ["link-local", { url: "https://169.254.169.254/latest" }, { upload: true }, /private|loopback/],
      ["loopback without opt-in", { url: "http://127.0.0.1:9/u" }, { upload: true }, /only https|loopback/],
      ["userinfo", { url: "https://user:pw@files.example.com/u" }, { upload: true }, /userinfo/],
      ["credentials include on an unlisted host", { url: "https://files.example.com/u", credentials: "include" }, { upload: true }, /credentialHosts/],
      ["authorization header", { url: "https://files.example.com/u", headers: { Authorization: "Bearer x" } }, { upload: true }, /forbidden-header|refused/],
      ["path target", { path: "/uploads", url: undefined }, { upload: true }, /path targets/],
      ["unknown member", { url: "https://files.example.com/u", extra: 1 }, { upload: true }, /refused/],
      ["expired", { url: "https://files.example.com/u", expiresAt: "2000-01-01T00:00:00Z" }, { upload: true }, /expired/],
      ["host outside allowedHosts", { url: "https://evil.example.net/u" }, { upload: true, allowedHosts: ["*.example.com"] }, /refused/],
      ["multipart without POST", { url: "https://files.example.com/u", method: "PUT", form: { fields: [], fileField: "f" } }, { upload: true }, /refused/],
    ];
    for (const [label, partial, opts, re] of cases) {
      const sink = await MockUploadSink.start();
      opened.push(sink);
      const target = (id: string): UploadTarget => ({ fileId: id, method: "PUT", credentials: "omit", ...partial }) as UploadTarget;
      const { client, server } = await setup({ files: opts, spec: { files: { sink, maxInlineBytes: 16, target } } });
      decodeUploadRequired(client, server);
      const err = (await client.callTool("save", { file: text("x".repeat(50)) }).catch((e) => e)) as Error;
      expect(err, label).toBeInstanceOf(MCPError);
      expect(err.message, label).toMatch(re);
      expect(server.fileRetries, label).toHaveLength(0);
      expect(sink.requests, label).toHaveLength(0);
    }
  });

  it("honours credentials include on an allowlisted host, and the host allowlist", async () => {
    const seen: RequestInit[] = [];
    const fetchSpy = async (_u: unknown, init?: RequestInit) => (seen.push(init!), new Response(null, { status: 200 }));
    const target = (id: string): UploadTarget => ({ fileId: id, url: "https://files.example.com/u/1", credentials: "include" });
    const sink = await MockUploadSink.start();
    opened.push(sink);
    const { client, server } = await setup({ files: { upload: true, fetch: fetchSpy, credentialHosts: ["files.example.com"] }, spec: { files: { sink, maxInlineBytes: 16, target } } });
    decodeUploadRequired(client, server);
    await client.callTool("save", { file: text("x".repeat(50)) }).catch(() => {}); // mock cannot see the bytes: only the request matters
    expect(seen[0]).toMatchObject({ credentials: "include", method: "PUT" });
  });

  it("rejects an upload list that does not match the files sent, and a missing requestState", async () => {
    const sink = await MockUploadSink.start();
    opened.push(sink);
    const wrongId = (id: string): UploadTarget => ({ fileId: `${id}-other`, url: sink.url("/x"), credentials: "omit" });
    const { client, server } = await setup({ files: loopback, spec: { files: { sink, maxInlineBytes: 16, target: wrongId } } });
    decodeUploadRequired(client, server);
    await expect(client.callTool("save", { file: text("x".repeat(50)) })).rejects.toThrow(/exactly the files/);
    // Strip requestState from what the SDK hands back.
    const conn = (client as unknown as { conns: Map<string, { sdk: { callTool: (...a: unknown[]) => Promise<unknown> } }> }).conns.get("s")!;
    conn.sdk.callTool = async () => ({ resultType: "upload_required", uploads: [] });
    await expect(client.callTool("save", { file: text("x".repeat(50)) })).rejects.toThrow(/requestState/);
  });
});

describe("files extension: downloads", () => {
  const dl = (sink: MockUploadSink, path: string, over: Partial<DownloadTarget> = {}): DownloadTarget => ({ name: "r.csv", mimeType: "text/csv", size: 3, url: sink.url(path), credentials: "omit", ...over });

  it("fetches a target through the chain, checks size and digest, and audits name/size/host", async () => {
    const { client, sink, audit, ops } = await setup({ files: loopback });
    sink.objects.set("/d/r", { bytes: new TextEncoder().encode("a,b") });
    const digest = await sha256Digest(new TextEncoder().encode("a,b"));
    const got = await client.fetchDownload("s", dl(sink, "/d/r", { digest }));
    expect(dec(got.bytes)).toBe("a,b");
    expect(got).toMatchObject({ name: "r.csv", mimeType: "text/csv" });
    expect(ops.find((o) => o.method === "files/download")).toMatchObject({ kind: "extension", target: "127.0.0.1" });
    expect(audit.find((a) => a.files?.phase === "download")).toMatchObject({ outcome: "ok", files: { name: "r.csv", size: 3, host: "127.0.0.1" } });
  });

  it("discards a download that fails its digest, overruns its size, redirects or is unsafe", async () => {
    const { client, sink } = await setup({ files: loopback });
    sink.objects.set("/d/r", { bytes: new TextEncoder().encode("a,b") });
    const bad = { algorithm: "sha-256" as const, value: "AAAA" };
    await expect(client.fetchDownload("s", dl(sink, "/d/r", { digest: bad }))).rejects.toThrow(/digest/);
    await expect(client.fetchDownload("s", dl(sink, "/d/r", { size: 2 }))).rejects.toThrow(/exceeded/);
    await expect(client.fetchDownload("s", dl(sink, "/d/r", { size: 9 }))).rejects.toThrow(/received 3/);
    await expect(client.fetchDownload("s", dl(sink, "/d/missing"))).rejects.toThrow(/HTTP 404/);
    sink.redirectTo = "http://127.0.0.1:1/x";
    await expect(client.fetchDownload("s", dl(sink, "/d/r"))).rejects.toThrow(/redirect/);
    await expect(client.fetchDownload("s", { mimeType: "a/b", size: 1, url: "https://10.0.0.1/x", credentials: "omit" })).rejects.toThrow(/private|loopback/);
    await expect(client.fetchDownload("s", { mimeType: "a/b", size: 1, url: "https://files.example.com/x", credentials: "omit", expiresAt: "2001-01-01T00:00:00Z" })).rejects.toThrow(/expired/);
  });

  it("caps the staleTime of a cached result at its downloads' expiry and keeps it out of the shared store", async () => {
    const expiresAt = new Date(Date.now() + 120).toISOString();
    const sink = await MockUploadSink.start();
    opened.push(sink);
    const l2: Array<unknown> = [];
    const server = new MockMCPServer({
      tools: [{ name: "export", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "ok" }], _meta: { [FILES_EXT]: { downloads: [{ name: "a", mimeType: "text/csv", size: 3, url: sink.url("/d/r"), credentials: "omit", expiresAt }] } } }) }],
      files: { sink },
    }, { era: "modern" });
    const client = new MCPClient({
      servers: { s: { transport: server.transport, versions: ["2026-07-28"] } },
      experimental: { files: true },
      cacheStore: { get: async () => undefined, set: async (...a: unknown[]) => void l2.push(a), delete: async () => {}, deleteByTag: async () => {}, clear: async () => {} } as never,
    });
    opened.push(client, server);
    await client.connect();
    await client.queryTool("export", {});
    const key = { kind: "toolResult", server: "s", tool: "export", argsHash: (await import("../src/core/keys.js")).argsHash({}), partition: undefined } as never;
    expect(client.cache.isStale(key)).toBe(false);
    await new Promise((r) => setTimeout(r, 160));
    expect(client.cache.isStale(key)).toBe(true);
    expect(l2).toHaveLength(0);
  });
});

describe("files extension: the gate-facing interceptor surface", () => {
  it("authorize() sees the upload as an extension operation it can deny by target host", async () => {
    const policy = authorize((req) => (req.kind === "extension" && req.target === "127.0.0.1" ? "deny" : "allow"));
    const { client, server, sink } = await setup({ files: loopback, interceptors: [policy] });
    decodeUploadRequired(client, server);
    await expect(client.callTool("save", { file: text("x".repeat(50)) })).rejects.toThrow();
    expect(sink.requests).toHaveLength(0);
  });
});
