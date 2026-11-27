// EXPERIMENTAL files extension at the gate (owner decision: uploads bypass the gate, so the gate denies them
// unless every upload host is allowlisted; download URLs follow an allowlist; x-mcp-file arguments are limited).
// Runs on the lockfile's SDK 2.0.0: an `upload_required` result is re-injected where the SDK cannot decode it.
import { afterEach, describe, expect, it } from "vitest";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { MCPClient, type CallAuditEntry, type Operation } from "@johnhenry/mcp-query";
import { MockMCPServer, MockUploadSink } from "@johnhenry/mcp-query/testing";
import { createGateClient, filesGuard, hostAllowed, validateGateConfig, type GateFilesPolicy } from "../src/index.browser.js";
import { validateGateConfig as validate } from "../src/index.js";

const FILES = "io.modelcontextprotocol/files";
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => {});
});

const SCHEMA = {
  type: "object",
  properties: { file: { type: "object", "x-mcp-file": { maxSize: 1_000_000 }, properties: {}, required: ["id", "mimeType", "size"] } },
  required: ["file"],
};
const blob = (n: number, type = "text/plain") => new Blob(["x".repeat(n)], { type });

function patchSdk(client: MCPClient, fn: (...a: unknown[]) => Promise<unknown>): void {
  const sdk = (client as unknown as { conns: Map<string, { sdk: { callTool: unknown } }> }).conns.get("up")!.sdk;
  sdk.callTool = fn;
}

/** A plain client with the guard in front, uploading to a loopback sink (the gate client cannot be told to allow http). */
async function guarded(policy: GateFilesPolicy | undefined, opts: { tools?: unknown[] } = {}) {
  const sink = await MockUploadSink.start();
  const mock = new MockMCPServer({ tools: (opts.tools as never) ?? [{ name: "save", inputSchema: SCHEMA, handler: () => ({ content: [{ type: "text", text: "saved" }] }) }], files: { sink, maxInlineBytes: 16 } }, { era: "modern" });
  const audit: CallAuditEntry[] = [];
  const client = new MCPClient({
    servers: { up: { transport: mock.transport, versions: ["2026-07-28"], maxRetries: 0 } },
    experimental: { files: { upload: true, allowInsecureLocalhost: true, digest: true } },
    interceptors: [filesGuard(policy)],
    onCall: (e) => void audit.push(e),
  });
  closers.push(() => client.close(), () => mock.close(), () => sink.close());
  await client.connect();
  const sdk = (client as unknown as { conns: Map<string, { sdk: { callTool: (...a: unknown[]) => Promise<unknown> } }> }).conns.get("up")!.sdk;
  const real = sdk.callTool.bind(sdk);
  sdk.callTool = async (...a: unknown[]) => {
    try {
      return await real(...a);
    } catch (e) {
      if (e instanceof SdkError && e.code === SdkErrorCode.UnsupportedResultType) return mock.uploadRequests.at(-1);
      throw e;
    }
  };
  return { client, mock, sink, audit };
}

describe("gate: uploads are denied unless the host is allowlisted", () => {
  it("denies by default, before any bytes leave, and audits the denial", async () => {
    const { client, mock, sink, audit } = await guarded(undefined);
    const err = (await client.callTool("save", { file: blob(50) }).catch((e) => e)) as { message: string; code?: number };
    expect(err.message).toMatch(/upload to host "127.0.0.1" refused/);
    expect(err.code).toBe(-32003);
    expect(sink.requests).toHaveLength(0);
    expect(mock.fileRetries).toHaveLength(0);
    expect(audit.find((a) => a.files?.phase === "upload")).toMatchObject({ outcome: "denied", files: { host: "127.0.0.1", size: 50 } });
  });

  it("denies a host that is not on the list", async () => {
    const { client, sink } = await guarded({ allowUploadHosts: ["files.example.com", "*.cdn.example.com"] });
    await expect(client.callTool("save", { file: blob(50) })).rejects.toThrow(/refused/);
    expect(sink.requests).toHaveLength(0);
  });

  it("lets an allowlisted upload through and audits name, size, digest and host, never content", async () => {
    const { client, sink, audit, mock } = await guarded({ allowUploadHosts: ["127.0.0.1"] });
    const body = "secret-body-".repeat(5);
    const res = await client.callTool("save", { file: new File([body], "r.txt", { type: "text/plain" }) });
    expect(res).toMatchObject({ content: [{ text: "saved" }] });
    expect(sink.requests).toHaveLength(1);
    expect(mock.fileRetries).toHaveLength(1);
    const e = audit.find((a) => a.files?.phase === "upload")!;
    expect(e).toMatchObject({ outcome: "ok", kind: "extension", files: { name: "r.txt", size: body.length, mimeType: "text/plain", host: "127.0.0.1", method: "PUT", digest: expect.stringMatching(/^sha-256:[A-Za-z0-9_-]{43}$/) } });
    expect(JSON.stringify(audit)).not.toContain("secret-body");
    expect(JSON.stringify(audit)).not.toContain("/u/files-");
  });

  it("matches host globs case-insensitively and an empty list matches nothing", () => {
    expect(hostAllowed("Files.Example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("evil.com", [])).toBe(false);
    expect(hostAllowed("evil.com", undefined)).toBe(false);
  });
});

describe("gate: an upload_required round that reaches the gate unhandled", () => {
  async function leak(policy: GateFilesPolicy | undefined, uploads: unknown[]) {
    const mock = new MockMCPServer({ tools: [{ name: "save", inputSchema: SCHEMA }] }, { era: "modern" });
    const audit: CallAuditEntry[] = [];
    const g = await createGateClient({ upstreams: { up: { transport: mock.transport, versions: ["2026-07-28"] } }, audit: (e) => audit.push(e), ...(policy ? { experimental: { files: policy } } : {}) });
    closers.push(() => g.close(), () => mock.close());
    patchSdk(g.client, async () => ({ resultType: "upload_required", uploads, requestState: "s" }));
    return { g, audit };
  }
  const targets = [{ fileId: "a", url: "https://evil.example.net/u/abc?sig=SECRETSIG", credentials: "omit" }];

  it("is refused by default, names the host and never the URL or its signature", async () => {
    const { g, audit } = await leak(undefined, targets);
    const err = (await g.client.callTool("save", { file: { id: "a", mimeType: "text/plain", size: 0 } }).catch((e) => e)) as { message: string; code?: number };
    expect(err.code).toBe(-32003);
    expect(err.message).toMatch(/evil\.example\.net/);
    expect(err.message).not.toMatch(/SECRETSIG|\/u\/abc/);
    expect(audit.at(-1)).toMatchObject({ kind: "call", outcome: "denied", files: { phase: "upload", action: "refused", hosts: ["evil.example.net"] } });
    expect(JSON.stringify(audit)).not.toContain("SECRETSIG");
  });

  it("is refused when only some hosts are allowlisted", async () => {
    const { g } = await leak({ allowUploadHosts: ["files.example.com"] }, [...targets, { fileId: "b", url: "https://files.example.com/x", credentials: "omit" }]);
    await expect(g.client.callTool("save", { file: { id: "a", mimeType: "text/plain", size: 0 } })).rejects.toThrow(/evil\.example\.net/);
  });

  it("is still refused when allowlisted, because the gate does not relay upload rounds", async () => {
    const { g } = await leak({ allowUploadHosts: ["evil.example.net"] }, targets);
    await expect(g.client.callTool("save", { file: { id: "a", mimeType: "text/plain", size: 0 } })).rejects.toThrow(/does not relay/);
  });
});

describe("gate: download URLs in results", () => {
  const dl = (host: string) => ({ name: "a", mimeType: "text/csv", size: 1, url: `https://${host}/d?sig=Q`, credentials: "omit" });
  async function run(policy: GateFilesPolicy | undefined, hosts: string[], extra: Record<string, unknown> = {}) {
    const mock = new MockMCPServer({ tools: [{ name: "export", handler: () => ({ content: [{ type: "text", text: "ok" }], _meta: { [FILES]: { downloads: hosts.map(dl), ...extra }, other: 1 } }) }] }, { era: "modern" });
    const audit: CallAuditEntry[] = [];
    const g = await createGateClient({ upstreams: { up: { transport: mock.transport, versions: ["2026-07-28"] } }, audit: (e) => audit.push(e), ...(policy ? { experimental: { files: policy } } : {}) });
    closers.push(() => g.close(), () => mock.close());
    return { res: (await g.client.callTool("export", {}).catch((e) => e)) as { _meta?: Record<string, unknown>; message?: string; code?: number }, audit };
  }

  it("passes everything through when no experimental.files policy is set (unchanged behaviour)", async () => {
    const { res } = await run(undefined, ["evil.example.net"]);
    expect((res._meta?.[FILES] as { downloads: unknown[] }).downloads).toHaveLength(1);
  });

  it("strips non-allowlisted targets by default and audits the hosts", async () => {
    const { res, audit } = await run({ allowDownloadHosts: ["files.example.com"] }, ["files.example.com", "evil.example.net"]);
    expect((res._meta?.[FILES] as { downloads: Array<{ url: string }> }).downloads.map((d) => new URL(d.url).hostname)).toEqual(["files.example.com"]);
    expect(res._meta?.other).toBe(1);
    expect(audit.at(-1)).toMatchObject({ outcome: "ok", files: { phase: "download", action: "stripped", hosts: ["evil.example.net"] } });
  });

  it("removes the files metadata entirely when nothing is allowed", async () => {
    const { res } = await run({}, ["evil.example.net"]);
    expect(res._meta?.other).toBe(1);
    expect(res._meta?.[FILES]).toBeUndefined();
  });

  it('"refuse" fails the whole call', async () => {
    const { res, audit } = await run({ allowDownloadHosts: ["files.example.com"], downloads: "refuse" }, ["files.example.com", "evil.example.net"]);
    expect(res.code).toBe(-32003);
    expect(res.message).toMatch(/evil\.example\.net/);
    expect(res.message).not.toMatch(/sig=Q/);
    expect(audit.at(-1)).toMatchObject({ outcome: "denied", files: { action: "refused", hosts: ["evil.example.net"] } });
  });

  it("judges fetchDownload by host too", async () => {
    const { client, sink } = await guarded({ allowDownloadHosts: ["127.0.0.1"] });
    sink.objects.set("/d/x", { bytes: new TextEncoder().encode("a") });
    await expect(client.fetchDownload("up", { mimeType: "a/b", size: 1, url: sink.url("/d/x"), credentials: "omit" })).resolves.toMatchObject({ mimeType: "a/b" });
    const denied = await guarded({ allowDownloadHosts: ["files.example.com"] });
    denied.sink.objects.set("/d/x", { bytes: new TextEncoder().encode("a") });
    await expect(denied.client.fetchDownload("up", { mimeType: "a/b", size: 1, url: denied.sink.url("/d/x"), credentials: "omit" })).rejects.toThrow(/refused/);
    expect(denied.sink.requests).toHaveLength(0);
  });
});

describe("gate: x-mcp-file argument limits", () => {
  const wire = (size: number, mimeType: string) => ({ file: { id: "a", mimeType, size } });
  it("refuses a file over maxFileSize or outside the MIME allowlist, and passes one inside", async () => {
    const { client, mock } = await guarded({ maxFileSize: 10, accept: ["application/pdf", "image/*"] });
    await expect(client.callTool("save", wire(11, "application/pdf"))).rejects.toThrow(/maxFileSize/);
    await expect(client.callTool("save", wire(5, "text/plain"))).rejects.toThrow(/accept list/);
    expect(mock.callLog).toHaveLength(0);
    await expect(client.callTool("save", wire(0, "image/png"))).resolves.toBeDefined();
    expect(mock.callLog).toHaveLength(1);
  });

  it("ignores the limits when no experimental.files policy is set", async () => {
    const { client } = await guarded(undefined);
    await expect(client.callTool("save", wire(0, "text/plain"))).resolves.toBeDefined();
  });
});

describe("gate: capability declaration and guard shape", () => {
  it("declares nothing to upstreams by default, even with a policy; download only when asked", async () => {
    const cases: Array<[GateFilesPolicy | undefined, unknown]> = [[undefined, undefined], [{ allowUploadHosts: ["a.example.com"] }, undefined], [{ download: true }, { download: {} }]];
    for (const [policy, expected] of cases) {
      const mock = new MockMCPServer({ tools: [{ name: "save", inputSchema: SCHEMA, handler: () => ({ content: [] }) }], files: { sink: undefined, maxInlineBytes: 16 } }, { era: "modern" });
      const g = await createGateClient({ upstreams: { up: { transport: mock.transport, versions: ["2026-07-28"] } }, ...(policy ? { experimental: { files: policy } } : {}) });
      closers.push(() => g.close(), () => mock.close());
      await g.client.callTool("save", { file: { id: "a", mimeType: "text/plain", size: 0 } });
      expect(mock.clientCapabilities()?.extensions?.[FILES]).toEqual(expected);
    }
  });

  it("ignores operations it has no business with", async () => {
    const guard = filesGuard({});
    const op = { kind: "read", peer: "up", target: "x://y", state: {} } as Operation;
    expect(await guard(op, async () => "r")).toBe("r");
    const noObj = { kind: "call", peer: "up", target: "t", state: {} } as Operation;
    expect(await guard(noObj, async () => "plain")).toBe("plain");
  });
});

describe("gate: validateGateConfig for experimental.files", () => {
  const base = { upstreams: { a: { url: "https://x.test/mcp" } } };
  const bad = (files: unknown, re: RegExp) => expect(() => validateGateConfig({ ...base, experimental: { files } })).toThrow(re);
  it("accepts a complete policy", () => {
    expect(() => validate({ ...base, experimental: { files: { allowUploadHosts: ["*.cdn.example.com"], allowDownloadHosts: ["files.example.com"], downloads: "refuse", maxFileSize: 1000, accept: ["image/*"], upload: true, download: true } } })).not.toThrow();
    expect(() => validate({ ...base, experimental: {} })).not.toThrow();
  });
  it("rejects typos, wrong types, wildcards and an unattached upload switch", () => {
    expect(() => validate({ ...base, experimental: { file: {} } })).toThrow(/unknown key "file"/);
    bad({ allowUploadHost: [] }, /unknown key "allowUploadHost"/);
    bad({ allowUploadHosts: "a.com" }, /array of host glob strings/);
    bad({ allowUploadHosts: ["*"] }, /invalid host glob/);
    bad({ allowDownloadHosts: ["https://a.com/x"] }, /invalid host glob/);
    bad({ downloads: "drop" }, /"strip" \| "refuse"/);
    bad({ maxFileSize: -1 }, /positive number/);
    bad({ accept: [1] }, /MIME/);
    bad({ upload: true }, /allowUploadHosts/);
    expect(() => validate({ ...base, experimental: "x" })).toThrow(/must be an object/);
    expect(() => validate({ ...base, experimental: { files: 1 } })).toThrow(/must be an object/);
  });
});
