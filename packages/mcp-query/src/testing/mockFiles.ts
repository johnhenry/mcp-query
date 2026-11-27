// EXPERIMENTAL, MAY CHANGE. Test fixtures for the files extension (`io.modelcontextprotocol/files`):
// a local HTTP sink/source standing in for object storage, and the spec the MockMCPServer uses to
// issue `upload_required`. The sink itself is Node-only (it loads node:http when started); importing this module is browser-safe.

import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FileInput, UploadTarget } from "../core/filesExt.js";

/** One request the sink received. */
export interface SinkRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * A loopback HTTP server that records uploads (any method) and serves stored downloads. Start it with
 * `await MockUploadSink.start()`, point a mock's `files.sink` at it, and `close()` it in teardown.
 */
export class MockUploadSink {
  /** Every request, in arrival order. */
  readonly requests: SinkRequest[] = [];
  /** Objects `GET` serves, keyed by path. */
  readonly objects = new Map<string, { bytes: Uint8Array; status?: number; headers?: Record<string, string> }>();
  /** Status the sink answers uploads with. Default 200. */
  status = 200;
  /** If set, answers with a redirect to this location (to test that redirects are refused). */
  redirectTo?: string;
  private server!: Server;
  port = 0;

  static async start(): Promise<MockUploadSink> {
    const sink = new MockUploadSink();
    // Loaded lazily through a variable specifier: `@johnhenry/mcp-query/testing` is also bundled for
    // browsers (MockMCPServer runs there), and a static `node:http` import would break those bundles.
    const nodeHttp = "node:http";
    const { createServer } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeHttp)) as typeof import("node:http");
    sink.server = createServer((req, res) => void sink.handle(req, res));
    await new Promise<void>((r) => sink.server.listen(0, "127.0.0.1", r));
    sink.port = (sink.server.address() as AddressInfo).port;
    return sink;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The URL an object at `path` is served from (and uploads to `path` land at). */
  url(path: string): string {
    return `${this.origin}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** The bytes of the last upload to `path`, if any. */
  uploaded(path: string): Uint8Array | undefined {
    return [...this.requests].reverse().find((r) => r.path === path && r.method !== "GET")?.body;
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = (req.url ?? "/").split("?")[0]!;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : (v ?? "");
    this.requests.push({ method: req.method ?? "GET", path, headers, body: new Uint8Array(Buffer.concat(chunks)) });
    if (this.redirectTo) {
      res.writeHead(302, { location: this.redirectTo }).end();
      return;
    }
    if (req.method === "GET") {
      const obj = this.objects.get(path);
      if (!obj) return void res.writeHead(404).end();
      res.writeHead(obj.status ?? 200, { "content-length": String(obj.bytes.byteLength), ...(obj.headers ?? {}) }).end(Buffer.from(obj.bytes));
      return;
    }
    res.writeHead(this.status).end();
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
    this.server.closeAllConnections?.();
  }
}

/** One file a mock tool handler received (inline, or confirmed in the sink). */
export interface MockReceivedFile {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  via: "inline" | "upload";
}

/** `MockSpec.files`: turns the mock into a files-extension server. */
export interface MockFilesSpec {
  /** Advertise `upload` and issue `upload_required` for files sent without data. Default true. */
  upload?: boolean;
  /** Advertised `maxInlineBytes`. Default 0 (inline refused). */
  maxInlineBytes?: number;
  /** Where out-of-band uploads go. Required to issue `upload_required` unless `target` is given. */
  sink?: MockUploadSink;
  /** Build each upload target (default: a `PUT` to `<sink>/u/<fileId>` with `credentials: "omit"`). */
  target?: (fileId: string, file: FileInput) => UploadTarget;
  /** `expiresAt` for the default targets, as ms from now. Default 60000. */
  expiresInMs?: number;
  /** Issue a second `upload_required` on the retry (to test the client refuses it). */
  repeatUploadRequired?: boolean;
}
