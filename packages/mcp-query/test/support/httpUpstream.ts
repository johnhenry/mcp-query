// An in-process MCP server on the SDK's own HTTP handler (createMcpHandler), reached through a real
// StreamableHTTPClientTransport whose `fetch` is wired straight to the handler: real wire framing and
// headers, no socket. Every POST is recorded (headers lowercased, JSON-RPC body) so a test can assert
// exactly what a client or the gateway put on the wire. Used by the SEP-2243 routing-header tests.

import * as z from "zod";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, ProtocolError, Server } from "@modelcontextprotocol/server";

export interface Wire {
  method: string;
  headers: Record<string, string>;
  params: Record<string, any>;
  status?: number;
}

export interface UpstreamSpec {
  tools?: Array<{ name: string; inputSchema?: Record<string, unknown>; _meta?: Record<string, unknown> }>;
  resources?: Array<{ uri: string; name?: string }>;
  templates?: Array<{ uriTemplate: string; name?: string }>;
  prompts?: Array<{ name: string }>;
  events?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
  /** `ttlMs` / `cacheScope` stamped on the list results and `resources/read`. */
  hint?: { ttlMs?: number; cacheScope?: "public" | "private" };
  /** Answer `events/poll` with HeaderMismatch while the request lacks this header (set -> checked per request). */
  requireParamHeader?: string;
  /** Serve the 2025-era stateless wire too (default: modern only). */
  legacy?: boolean;
}

export function httpUpstream(spec: UpstreamSpec = {}) {
  const wire: Wire[] = [];
  const hint = spec.hint ?? {};
  const make = () => {
    const caps: Record<string, unknown> = { tools: {}, resources: {}, prompts: {} };
    if (spec.events) caps.extensions = { "io.modelcontextprotocol/events": {} };
    const s = new Server({ name: "up", version: "1" }, { capabilities: caps as never });
    s.setRequestHandler("tools/list", () => ({ tools: (spec.tools ?? []).map((t) => ({ inputSchema: { type: "object" as const }, ...t })), ...hint }) as never);
    s.setRequestHandler("tools/call", (req) => ({ content: [{ type: "text", text: `called ${req.params.name}` }] }));
    s.setRequestHandler("resources/list", () => ({ resources: (spec.resources ?? []).map((r) => ({ name: r.uri, ...r })), ...hint }) as never);
    s.setRequestHandler("resources/templates/list", () => ({ resourceTemplates: (spec.templates ?? []).map((t) => ({ name: t.uriTemplate, ...t })), ...hint }) as never);
    s.setRequestHandler("resources/read", (req) => ({ contents: [{ uri: req.params.uri, text: "body" }], ...hint }) as never);
    s.setRequestHandler("prompts/list", () => ({ prompts: spec.prompts ?? [], ...hint }) as never);
    s.setRequestHandler("prompts/get", () => ({ messages: [] }));
    if (spec.events) {
      s.setRequestHandler("events/list" as never, { params: z.looseObject({}) } as never, (() => ({ events: spec.events!.map((e) => ({ delivery: ["poll"], ...e })) })) as never);
      s.setRequestHandler("events/poll" as never, { params: z.looseObject({}) } as never, ((_p: unknown, ctx: { http?: { req?: Request } }) => {
        const need = spec.requireParamHeader;
        if (need && ctx.http?.req?.headers.get(need) === null) throw new ProtocolError(-32020, `Header mismatch: ${need} is missing`);
        return { events: [], cursor: "c1", nextPollMs: 5 };
      }) as never);
    }
    return s;
  };
  const handler = createMcpHandler(make, { legacy: spec.legacy ? "stateless" : "reject" });
  const dispatch = async (req: Request): Promise<Response> => {
    const entry: Wire = { method: "?", headers: {}, params: {} };
    req.headers.forEach((v, k) => (entry.headers[k] = v));
    if (req.method === "POST") {
      try {
        const b = JSON.parse(await req.clone().text());
        entry.method = b.method;
        entry.params = b.params ?? {};
      } catch {
        /* not JSON */
      }
      wire.push(entry);
    }
    const res = await handler.fetch(req);
    entry.status = res.status;
    return res;
  };
  return {
    wire,
    /** Requests of one JSON-RPC method, in order. */
    calls: (method: string) => wire.filter((w) => w.method === method),
    /** A fresh client transport for `ConnectionConfig.transport`. */
    transport: () => new StreamableHTTPClientTransport(new URL("http://up.local/mcp"), { fetch: (url, init) => dispatch(new Request(url, init)) }),
    dispatch,
    close: () => handler.close(),
  };
}
