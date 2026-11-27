// EXPERIMENTAL files extension: the pure helpers (schema, hosts, addresses, targets, results, multipart).
import { describe, expect, it } from "vitest";
import {
  acceptsFile,
  capStaleByDownloads,
  checkTarget,
  clientFilesSettings,
  downloadTtlMs,
  downloadsOf,
  findFileParams,
  FILES_EXT,
  hostMatches,
  isLoopbackHost,
  isNonGlobalAddress,
  isUploadRequiredResult,
  resolveFilesOptions,
} from "../src/core/filesExt.js";
import { buildMultipart, prepareFileArgs, serverFilesCaps, sha256Digest, vetTarget, wireArgs } from "../src/core/filesTransfer.js";

const NOW = Date.parse("2026-11-27T00:00:00Z");
const opts = { now: NOW };

describe("files: schema and accept", () => {
  it("finds top-level x-mcp-file params with their limits and digest requirement", () => {
    const m = findFileParams({
      properties: {
        a: { type: "object", "x-mcp-file": { accept: ["application/pdf", 3], maxSize: 5 }, required: ["digest"] },
        b: { type: "object", "x-mcp-file": true },
        c: { type: "object", "x-mcp-file": false },
        d: { type: "string" },
      },
    });
    expect([...m.keys()]).toEqual(["a", "b"]);
    expect(m.get("a")).toEqual({ descriptor: { accept: ["application/pdf"], maxSize: 5 }, requiresDigest: true });
    expect(m.get("b")).toEqual({ descriptor: {}, requiresDigest: false });
    expect(findFileParams(undefined).size).toBe(0);
    expect(findFileParams({ properties: 3 }).size).toBe(0);
  });
  it("matches media types, wildcards and extensions", () => {
    expect(acceptsFile(undefined, "x/y")).toBe(true);
    expect(acceptsFile([], "x/y")).toBe(true);
    expect(acceptsFile(["image/*"], "image/png")).toBe(true);
    expect(acceptsFile(["image/*"], "text/plain")).toBe(false);
    expect(acceptsFile(["*/*"], "a/b")).toBe(true);
    expect(acceptsFile(["application/pdf"], "Application/PDF; charset=x")).toBe(true);
    expect(acceptsFile([".csv"], "application/octet-stream", "R.CSV")).toBe(true);
    expect(acceptsFile([".csv"], "text/csv", "r.txt")).toBe(false);
  });
  it("normalises options and the declared settings", () => {
    expect(resolveFilesOptions(undefined)).toBeUndefined();
    expect(resolveFilesOptions(false)).toBeUndefined();
    expect(resolveFilesOptions(true)).toEqual({});
    expect(clientFilesSettings({})).toEqual({ download: {} });
    expect(clientFilesSettings({ upload: true, download: false })).toEqual({ upload: {} });
    expect(serverFilesCaps(undefined).advertised).toBe(false);
    expect(serverFilesCaps({ upload: {}, maxInlineBytes: 9 })).toEqual({ advertised: true, upload: true, maxInlineBytes: 9 });
    expect(serverFilesCaps({})).toEqual({ advertised: true, upload: false, maxInlineBytes: 0 });
    expect(isUploadRequiredResult({ resultType: "upload_required" })).toBe(true);
    expect(isUploadRequiredResult({ resultType: "complete" })).toBe(false);
    expect(isUploadRequiredResult(null)).toBe(false);
  });
});

describe("files: hosts and addresses", () => {
  it("matches host globs", () => {
    expect(hostMatches("a.b.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatches("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("x", undefined)).toBe(false);
  });
  it("classifies loopback and non-global addresses", () => {
    for (const h of ["localhost", "a.localhost", "127.0.0.1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:a00:1", "192.0.2.5", "203.0.113.9", "198.51.100.1"]) {
      expect(isNonGlobalAddress(h), h).toBe(true);
    }
    for (const h of ["8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700::1", "files.example.com", "::ffff:8.8.8.8"]) expect(isNonGlobalAddress(h), h).toBe(false);
  });
});

describe("files: checkTarget", () => {
  const ok = { fileId: "a", url: "https://files.example.com/u/1?sig=x", credentials: "omit" };
  const bad = (t: unknown, reason: string, o: Record<string, unknown> = {}, dir: "upload" | "download" = "upload") => {
    try {
      checkTarget(t, dir, { ...opts, ...o });
    } catch (e) {
      expect((e as { reason?: string }).reason).toBe(reason);
      return;
    }
    throw new Error(`expected ${reason}`);
  };
  it("accepts a valid target and treats null members as absent", () => {
    const c = checkTarget({ ...ok, method: null, expiresAt: "2026-11-27T01:00:00+00:00", headers: { "Content-Type": "a/b" } }, "upload", opts);
    expect(c).toMatchObject({ method: "PUT", credentials: "omit", expiresAtMs: Date.parse("2026-11-27T01:00:00Z") });
    expect(c.headers).toEqual({ "Content-Type": "a/b" });
    expect(checkTarget({ mimeType: "a/b", size: 3, url: "https://files.example.com/d", credentials: "omit" }, "download", opts).method).toBe("GET");
  });
  it("rejects each unsafe shape with a stable reason", () => {
    bad(null, "not-an-object");
    bad({ ...ok, extra: 1 }, "unknown-member");
    bad({ fileId: "a", credentials: "omit" }, "needs-exactly-one-of-url-and-path");
    bad({ ...ok, path: "/x" }, "needs-exactly-one-of-url-and-path");
    bad({ fileId: "a", path: "/x", credentials: "omit" }, "path-target-unsupported");
    bad({ ...ok, url: 3 }, "url-not-a-string");
    bad({ ...ok, credentials: "yes" }, "bad-credentials");
    bad({ url: ok.url, credentials: "omit" }, "missing-fileId");
    bad({ ...ok, method: "DELETE" }, "bad-method");
    bad({ ...ok, url: "nope" }, "unparseable-url");
    bad({ ...ok, url: "https://u:p@files.example.com/" }, "userinfo-in-url");
    bad({ ...ok, url: "ftp://files.example.com/" }, "unsupported-scheme");
    bad({ ...ok, url: "http://files.example.com/" }, "insecure-scheme");
    bad({ ...ok, url: "http://127.0.0.1:1/" }, "insecure-scheme");
    bad({ ...ok, url: "https://127.0.0.1/" }, "private-address");
    bad({ ...ok, url: "https://[::1]/" }, "private-address");
    bad({ ...ok, url: "https://evil.net/" }, "host-not-allowed", { allowedHosts: ["*.example.com"] });
    bad({ ...ok, headers: "x" }, "bad-headers");
    bad({ ...ok, headers: { "bad name": "v" } }, "bad-header");
    bad({ ...ok, headers: { A: "v\r\nX: y" } }, "bad-header");
    bad({ ...ok, headers: { Authorization: "x" } }, "forbidden-header");
    bad({ ...ok, headers: { cookie: "x" } }, "forbidden-header");
    bad({ ...ok, headers: { "Sec-Fetch-Mode": "x" } }, "forbidden-header");
    bad({ ...ok, credentials: "include", headers: { "X-Forwarded-For": "1" } }, "proxy-steering-header", { credentialHosts: ["files.example.com"] });
    bad({ ...ok, credentials: "include" }, "credentials-host-not-allowed");
    bad({ ...ok, expiresAt: "2026-11-27T00:00:00" }, "bad-expiresAt");
    bad({ ...ok, expiresAt: "2026-11-26T00:00:00Z" }, "expired");
    bad({ ...ok, form: { fields: [], fileField: "f" } }, "form-needs-post");
    bad({ ...ok, method: "POST", form: { fields: [], fileField: "" } }, "bad-form");
    bad({ ...ok, method: "POST", form: { fields: [{ name: "f", value: "v" }], fileField: "f" } }, "bad-form");
    bad({ ...ok, method: "POST", form: { fields: [{ name: "a", value: "v\n" }], fileField: "f" } }, "bad-form");
    bad({ ...ok, method: "POST", form: { fields: [], fileField: "f" }, headers: { "content-type": "x" } }, "form-header");
    bad({ ...ok, method: "POST", form: "x" }, "bad-form");
    bad({ mimeType: "a/b", size: -1, url: ok.url, credentials: "omit" }, "bad-download-metadata", {}, "download");
  });
  it("allows loopback http only with the explicit option, and credentials include only on listed hosts", () => {
    const lo = { fileId: "a", url: "http://127.0.0.1:9/u", credentials: "omit" };
    expect(checkTarget(lo, "upload", { ...opts, allowInsecureLocalhost: true }).url.port).toBe("9");
    expect(checkTarget({ ...ok, url: "https://10.0.0.1/" }, "upload", { ...opts, allowPrivateAddresses: true }).url.hostname).toBe("10.0.0.1");
    expect(checkTarget({ ...ok, credentials: "include" }, "upload", { ...opts, credentialHosts: ["*.example.com"] }).credentials).toBe("include");
  });
  it("vetTarget refuses a name that resolves to a private address when resolveHost is given", async () => {
    await expect(vetTarget(ok, "upload", { now: () => NOW, resolveHost: async () => ["10.0.0.9"] })).rejects.toThrow(/resolves to/);
    await expect(vetTarget(ok, "upload", { now: () => NOW, resolveHost: async () => [] })).rejects.toThrow(/resolves to/);
    await expect(vetTarget(ok, "upload", { now: () => NOW, resolveHost: async () => ["8.8.8.8"] })).resolves.toBeDefined();
    await expect(vetTarget({ ...ok, url: "https://8.8.8.8/x" }, "upload", { now: () => NOW, resolveHost: async () => ["10.0.0.9"] })).resolves.toBeDefined();
  });
});

describe("files: results", () => {
  const withDl = (...exp: Array<string | undefined>) => ({ _meta: { [FILES_EXT]: { downloads: exp.map((expiresAt) => ({ expiresAt })) } } });
  it("reads downloads and the earliest expiry", () => {
    expect(downloadsOf({})).toEqual([]);
    expect(downloadsOf({ _meta: { [FILES_EXT]: { downloads: "x" } } })).toEqual([]);
    expect(downloadTtlMs({}, NOW)).toBeUndefined();
    expect(downloadTtlMs(withDl("2026-11-27T00:00:10Z", "2026-11-27T00:00:05Z"), NOW)).toBe(5000);
    expect(downloadTtlMs(withDl("2026-11-26T00:00:00Z"), NOW)).toBe(0);
    expect(downloadTtlMs(withDl(undefined), NOW)).toBe(0);
  });
  it("caps staleTime by the expiry, never raises it", () => {
    expect(capStaleByDownloads({}, 100, NOW)).toBe(100);
    expect(capStaleByDownloads({}, undefined, NOW)).toBeUndefined();
    expect(capStaleByDownloads(withDl("2026-11-27T00:00:05Z"), 100_000, NOW)).toBe(5000);
    expect(capStaleByDownloads(withDl("2026-11-27T00:00:05Z"), 1000, NOW)).toBe(1000);
    expect(capStaleByDownloads(withDl("2026-11-27T00:00:05Z"), undefined, NOW)).toBe(5000);
  });
});

describe("files: preparing arguments", () => {
  const schema = { properties: { f: { type: "object", "x-mcp-file": { maxSize: 100 } }, g: { type: "object", "x-mcp-file": {} }, s: { type: "string" } } };
  const caps = { advertised: true, upload: true, maxInlineBytes: 10 };
  it("returns undefined when no file param is in play", async () => {
    expect(await prepareFileArgs(schema, { s: "x" }, caps, {})).toBeUndefined();
  });
  it("splits files between inline and out-of-band by the running inline budget", async () => {
    const p = (await prepareFileArgs(schema, { f: { data: "123456", mimeType: "a/b" }, g: { name: "n", data: new Uint8Array(6) } }, caps, { upload: true }))!;
    expect(p.files.map((x) => [x.param, x.inlineData !== undefined])).toEqual([["f", true], ["g", false]]);
    expect(p.needsUpload).toBe(true);
    expect((p.args.g as { mimeType: string }).mimeType).toBe("application/octet-stream");
    const wire = wireArgs(p.args, p) as { f: { data: string }; g: { data?: string } };
    expect(wire.f.data).toBe(btoa("123456"));
    expect(wire.g.data).toBeUndefined();
  });
  it("accepts a ready-made FileInput, with or without data, and an ArrayBuffer / Blob source", async () => {
    const ready = { id: "mine", mimeType: "a/b", size: 3, data: btoa("abc") };
    const p = (await prepareFileArgs(schema, { f: ready, g: { id: "o", mimeType: "a/b", size: 50 } }, caps, { upload: true }))!;
    expect(p.files[0]!.inlineData).toBe(btoa("abc"));
    expect((wireArgs(p.args, p).f as { data: string }).data).toBe(btoa("abc"));
    expect(p.files[1]!.inlineData).toBeUndefined();
    const q = (await prepareFileArgs(schema, { f: { data: new ArrayBuffer(2) }, g: { data: new Blob(["z"], { type: "text/plain" }) } }, { ...caps, maxInlineBytes: 0 }, { upload: true }))!;
    expect(q.files.every((x) => x.inlineData === undefined)).toBe(true);
    expect(q.files[1]!.input.mimeType).toBe("text/plain");
  });
  it("errors clearly on a non-file value, an unadvertised extension, and a server that cannot take uploads", async () => {
    await expect(prepareFileArgs(schema, { f: 3 }, caps, {})).rejects.toThrow(/Blob, a File/);
    await expect(prepareFileArgs(schema, { f: new Blob(["x"]) }, { ...caps, advertised: false }, {})).rejects.toThrow(/did not advertise/);
    await expect(prepareFileArgs(schema, { f: new Blob(["x".repeat(20)]) }, { ...caps, upload: false }, { upload: true })).rejects.toThrow(/did not advertise out-of-band/);
    await expect(prepareFileArgs(schema, { f: new Blob(["x"]) }, { ...caps, maxInlineBytes: 0 }, { maxInlineBytes: 0 })).rejects.toThrow(/not enabled/);
  });
});

describe("files: multipart and digest", () => {
  it("builds fields in order, then the file, with a 128-bit boundary and safe names", () => {
    const { body, contentType } = buildMultipart({ fields: [{ name: 'a"b', value: "1" }, { name: "c", value: "2" }], fileField: "file" }, { name: "..", mimeType: "not a type", bytes: new Uint8Array([65, 66]) });
    const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
    expect(boundary.replace("----mcpquery", "")).toMatch(/^[0-9a-f]{32}$/);
    const text = new TextDecoder().decode(body);
    expect(text).toContain('name="a%22b"');
    expect(text.indexOf('name="a%22b"')).toBeLessThan(text.indexOf('name="c"'));
    expect(text).toContain('name="file"; filename="file"');
    expect(text).toContain("Content-Type: application/octet-stream");
    expect(text.endsWith(`AB\r\n--${boundary}--\r\n`)).toBe(true);
    expect(buildMultipart({ fields: [], fileField: "f" }, { mimeType: "a/b", bytes: new Uint8Array() }).contentType).not.toBe(contentType);
  });
  it("hashes to the base64url form the draft names", async () => {
    expect(await sha256Digest(new TextEncoder().encode("abc"))).toEqual({ algorithm: "sha-256", value: "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0" });
  });
});
