// Serve a MockMCPServer over real HTTP on 127.0.0.1 (so the CLIs can be pointed at it with --url).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MockMCPServer } from "../../../mcp-query/src/testing/mockServer.js";

export async function serveMock(mock: MockMCPServer): Promise<{ url: string; close: () => Promise<void> }> {
  const dispatch = (mock as unknown as { dispatch(r: Request): Promise<Response> }).dispatch;
  const http: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await dispatch.call(mock, new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
    })().catch(() => res.end());
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      await mock.close();
    },
  };
}
