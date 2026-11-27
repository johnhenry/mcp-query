# File uploads and downloads (`io.modelcontextprotocol/files`): experimental, may change

> **Experimental, may change.** The extension is a working-group draft. It is not part of the MCP
> specification, has no SEP, and has no SDK support. Everything described here is opt-in, prefixed
> `experimental` in the API, and can break in any release. Do not build on it without pinning versions.

Tracked in [#84](https://github.com/johnhenry/mcp-query/issues/84).

## Sources this was built from

- Draft: <https://github.com/modelcontextprotocol/experimental-ext-file-uploads>
  `specification/draft/file-uploads.md`, commit `8a859b8f268926fe4beb84d78565e7cc6f9fa617` (2026-11-09).
  This is the source of every wire shape below.
- Announcement: <https://blog.modelcontextprotocol.io/posts/exploring-file-uploads-and-downloads-in-mcp/>.
  Where the post and the draft differ (the post shows `digest` as a bare hash, the draft makes it
  `{ algorithm: "sha-256", value }`), the draft wins.

## Turning it on

```ts
const client = new MCPClient({
  servers: { files: { transport, versions: ["2026-07-28"] } },
  experimental: { files: true }, // or { upload, download, maxInlineBytes, fetch, ... }: see ExperimentalFilesOptions
});

await client.callTool("save_to_folder", {
  folderId: "fld_1",
  file: new File([bytes], "Q3 report.pdf", { type: "application/pdf" }), // Blob | File | { name, mimeType, data }
});
```

Without `experimental.files` nothing changes: no capability is declared, arguments are sent as given,
`fetchDownload` throws.

| Option | Default | Meaning |
| --- | --- | --- |
| `download` | `true` | declare `download` (the client accepts download targets) |
| `upload` | `false` | declare `upload` (the out-of-band flow). Off by default because of the SDK limit below |
| `maxInlineBytes` | server's | client-side cap on total inline bytes per request (the smaller of this and the server's) |
| `fetch` | global | injectable fetch for uploads and downloads |
| `allowInsecureLocalhost` | `false` | permit `http://` and loopback targets (tests) |
| `allowPrivateAddresses` | `false` | permit private, link-local, loopback and other non-global addresses |
| `credentialHosts` | none | host globs a `credentials: "include"` target may name; any other `include` target is refused |
| `allowedHosts` | any public host | client-side allowlist of target hosts |
| `resolveHost` | none | resolve a name to addresses so one pointing at a private address is refused (the core cannot resolve names; without it DNS rebinding is not covered) |
| `digest` | `false` | always send a SHA-256 `digest` (otherwise only when the tool's schema requires it) |

## What is implemented (all verified against the draft above)

- **Capability.** Declared as `capabilities.extensions["io.modelcontextprotocol/files"]` = `{ upload?: {}, download?: {} }`; the SDK
  puts it in the per-request `io.modelcontextprotocol/clientCapabilities` envelope. The server's advertised `upload` and
  `maxInlineBytes` are read from its capabilities; a client never sends a file to a server that did not advertise the extension.
- **File arguments.** Top-level tool properties marked `x-mcp-file` (`{ accept?: string[]; maxSize?: number }`). A `Blob`, `File` or
  `{ name, mimeType, data }` becomes a `FileInput` (`id`, `name`, `mimeType`, `size`, optional `digest`, optional base64 `data`).
  `accept` and `maxSize` are checked before anything is sent. Files go inline while the running total fits `maxInlineBytes`, the
  rest go out of band. A zero-byte file is sent with no `data` and no upload. Interceptors, audit and devtools see the metadata only,
  never `data`.
- **Upload round.** `resultType: "upload_required"` with `uploads: UploadTarget[]` and `requestState`. The client checks that the
  list is exactly the files sent without `data`, vets every target before sending any bytes, performs each upload as its own
  operation through the interceptor chain (`kind: "extension"`, `method: "files/upload"`, `target` = host, `args` = file id, name, size,
  mime type, digest, host, method, never bytes or the URL), then retries the same `tools/call` with `requestState` echoed unchanged.
  A failed or refused upload means no retry. A second `upload_required` in one call fails the call.
- **Targets.** HTTPS only (`http` only for loopback behind `allowInsecureLocalhost`); no userinfo; no redirects (a 3xx fails the
  transfer); `credentials: "omit"` unless the target is `include` on a `credentialHosts` host; `Authorization`, `Cookie`, fetch-forbidden,
  `Proxy-*`/`Sec-*` headers refused; proxy-steering headers refused on `include`; `form` rules (POST only, no content headers, field
  name rules); `expiresAt` must be RFC 3339 with a zone and in the future, re-checked just before each transfer; non-global addresses
  refused (IPv4 and IPv6 literals, `localhost` names, optional `resolveHost`); unknown members refused; `null` members ignored.
  `form` targets are sent as `multipart/form-data` built by hand: fields in order, then the file, a 128-bit random boundary,
  WHATWG quoting, base name only for `filename`. Without `form`, `Content-Type` is sent exactly as the target lists it.
- **Downloads.** `result._meta["io.modelcontextprotocol/files"].downloads`. `client.fetchDownload(server, target)` vets the target,
  runs it through the chain (`method: "files/download"`), GETs with no redirects, aborts once more than `size` bytes arrive, checks the
  final length and the SHA-256 `digest`, and returns the bytes in memory. It never writes to disk.
- **Caching.** An interim `upload_required` result is never cached. A call that carried files is never cached. A cached tool result that
  carries download URLs is cached no longer than its earliest `expiresAt` and is kept out of the shared L2 store. Bytes are never cached.
- **Audit.** `CallAuditEntry.files` on the upload/download step: `phase`, `fileId`, `name`, `mimeType`, `size`, `digest`, `host`, `method`.
  Never content, never the URL (it carries a secret signature).

## The SDK limit (probed on `@modelcontextprotocol/client` 2.0.0, the CI floor)

- **2026-07-28 wire:** the SDK's result codec knows only `resultType` `complete` and `input_required`. Any other value, including
  `upload_required`, fails with `SdkError(UnsupportedResultType)` before mcp-query sees the result, and the payload (uploads,
  requestState) is not retained on the error. **The out-of-band flow cannot complete on SDK 2.0.0.** With `experimental.files.upload`
  set, mcp-query reports this as an `MCPError` ("the installed SDK cannot decode that result type") instead of the bare SDK message.
  Inline transfer and downloads work (they are `complete` results). The out-of-band code is written and tested against a result handed
  back the way a future SDK would (`test/files.test.ts` re-injects it); it is unexercised against any real SDK.
- **2025 wire:** the draft applies to 2026-07-28 and later. The legacy codec drops `resultType` and passes the rest through, and a
  legacy request has no per-request capability declaration, so a server cannot know the client supports the extension. Not supported there.
- This is why `upload` is off by default: declaring it on 2.0.0 invites a round the client cannot finish.

## Gate decision (mcp-gate)

Uploads bypass the gate by design: the client sends bytes straight to a URL the server names. The owner's decision is that the gate
**denies by default**.

- An `upload_required` round that reaches a gate is refused (`-32003`, audited `denied`, the error names the hosts, never the URL)
  unless every upload URL's host matches `experimental.files.allowUploadHosts` (host globs). With the gate's own client performing the
  upload (library mode, `experimental.files.upload: true`, which requires a non-empty `allowUploadHosts`), the host is judged on the
  separate `files/upload` operation before any bytes move, and an allowed upload is audited with file name, size, digest and host.
  A gateway does not relay an allowed upload round to a consumer (not implemented); it refuses that too, with a message saying so.
- Download URLs in results follow `allowDownloadHosts`: by default non-allowlisted entries are **stripped** from `_meta` (the rest of the
  result is untouched, the audit entry records the stripped hosts); `downloads: "refuse"` fails the whole call instead. Strip was chosen
  because a half-useful result is better than a failed call, and the model never sees these URLs anyway; refuse is there for strict setups.
- `x-mcp-file` arguments are limited by `maxFileSize` and `accept` (MIME allowlist).
- The upload refusal is always on (it cannot change behaviour: such a result already fails on SDK 2.0.0). The download stripping and
  argument limits apply only when `experimental.files` is configured, so an unconfigured gate behaves as before.
- The gate declares nothing to upstreams by default, even with a policy; `upload` / `download` are separate opt-ins.

## Other pieces

- `mcp-lint` rule `x-mcp-file` (warn): every `x-mcp-file` declares `accept` and `maxSize`.
- `apps/shared` schema form (DOM builder and React `SchemaForm`): an `x-mcp-file` param is a file input honouring `accept` and `maxSize`.
- `mcp-record` never stores file bytes: an inline `data` is replaced by its SHA-256 digest and `dataOmitted: true`, in the cassette and
  in the replay match key.
- Test fixtures: `MockMCPServer` with `files: { sink, maxInlineBytes }` issues `upload_required` and `MockUploadSink` is a loopback HTTP
  sink/source (`@johnhenry/mcp-query/testing`).

## Not verified / not implemented

- `path` targets (resolved against the MCP address) are refused: the client does not track the MCP address, so the rule is unverified here.
- The draft's rule that `credentials: "include"` must attach the MCP `Authorization` credential is **not implemented**: `include` only sets
  fetch's `credentials` (cookies) for an allowlisted host; the bearer token lives in the SDK's transport and is not available to this layer.
- stdio's "only `url` targets with `omit`" rule is not enforced separately.
- `x-mcp-file` inside array items or `anyOf`/`oneOf` branches is not handled by the client (top-level properties only); the lint rule and
  the gate scan more widely or not at all as noted in code.
- Uploads are read fully into memory (no streaming); there is no automatic repeat of a failed `PUT`; range requests for downloads are not used.
- The draft's open questions (finalize handles, resource support, `omit` origin binding, a failure signal, the download shape, mandatory
  digests) are open upstream and may change the wire shapes. The download shape in particular has not been reviewed by the working group.
- Behaviour against any real server: none was available. Only the mock fixture was exercised.
