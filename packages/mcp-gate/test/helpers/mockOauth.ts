// Local mock IdP / authorization server / protected MCP resource. No third-party network.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler, Server as McpSdkServer } from "@modelcontextprotocol/server";

export interface Hit {
  path: string;
  headers: IncomingMessage["headers"];
  body: URLSearchParams;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function listen(h: (req: IncomingMessage, res: ServerResponse, origin: string) => Promise<void> | void): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      void Promise.resolve(h(req, res, origin)).catch((e) => res.writeHead(500).end(String(e)));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

export interface MockOauth {
  mcpUrl: string;
  issuer: string;
  idpTokenEndpoint: string;
  asTokenEndpoint: string;
  /** Token requests received by the authorization server / IdP. */
  asHits: Hit[];
  idpHits: Hit[];
  /** Authorization headers the protected MCP resource saw. */
  mcpAuth: (string | undefined)[];
  /** Issue tokens with this lifetime (seconds). */
  setExpiresIn(s: number | undefined): void;
  close(): Promise<void>;
}

export const CC = { clientId: "gate-svc", clientSecret: "s3cr3t-value-DO-NOT-LOG" };
export const ENT = { idToken: "id-token-value-DO-NOT-LOG", idpClientId: "idp-client", idpSecret: "idp-secret-DO-NOT-LOG", asClientId: "as-client", asSecret: "as-secret-DO-NOT-LOG" };

/** `asIssuer`: what the AS metadata claims as its issuer (default: its own origin). */
export async function startMockOauth(opts: { asIssuer?: string } = {}): Promise<MockOauth> {
  let expiresIn: number | undefined = 3600;
  const asHits: Hit[] = [];
  const idpHits: Hit[] = [];
  const mcpAuth: (string | undefined)[] = [];
  let issued = 0;

  const as = await listen(async (req, res, origin) => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: opts.asIssuer ?? origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["client_credentials", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      asHits.push({ path: url.pathname, headers: req.headers, body });
      const basic = req.headers.authorization ?? "";
      const [id, secret] = Buffer.from(basic.replace(/^Basic /, ""), "base64").toString().split(":");
      const grant = body.get("grant_type");
      if (grant === "client_credentials" && id === CC.clientId && secret === CC.clientSecret) {
        return json(res, 200, { access_token: `cc-${++issued}`, token_type: "Bearer", ...(expiresIn ? { expires_in: expiresIn } : {}) });
      }
      if (grant === "urn:ietf:params:oauth:grant-type:jwt-bearer" && id === ENT.asClientId && secret === ENT.asSecret && body.get("assertion") === "ID-JAG-1") {
        return json(res, 200, { access_token: `ent-${++issued}`, token_type: "Bearer", ...(expiresIn ? { expires_in: expiresIn } : {}) });
      }
      return json(res, 401, { error: "invalid_client", error_description: "bad credentials" });
    }
    res.writeHead(404).end();
  });

  const idp = await listen(async (req, res, origin) => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      idpHits.push({ path: url.pathname, headers: req.headers, body });
      const ok =
        body.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange" &&
        body.get("requested_token_type") === "urn:ietf:params:oauth:token-type:id-jag" &&
        body.get("subject_token") === ENT.idToken &&
        body.get("client_id") === ENT.idpClientId &&
        body.get("client_secret") === ENT.idpSecret;
      if (!ok) return json(res, 400, { error: "invalid_request" });
      return json(res, 200, { issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", access_token: "ID-JAG-1", token_type: "N_A", expires_in: 300 });
    }
    res.writeHead(404).end();
  });

  // The protected MCP resource: PRM + a real MCP handler that demands the bearer it issued.
  const mcpServer = new McpSdkServer({ name: "protected", version: "1" }, { capabilities: { tools: {} } });
  mcpServer.setRequestHandler("tools/list", () => ({ tools: [{ name: "whoami", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }));
  mcpServer.setRequestHandler("tools/call", () => ({ content: [{ type: "text", text: "hello" }] }));
  const handler = createMcpHandler(() => mcpServer, {});
  const mcp = await listen(async (req, res, origin) => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [as.origin] });
    }
    const auth = req.headers.authorization;
    mcpAuth.push(auth);
    if (!auth || !/^Bearer (cc|ent)-\d+$/.test(auth) || auth === "Bearer cc-revoked") {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "host") headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const resp = await handler.fetch(new Request(`${origin}${req.url}`, { method: req.method, headers, body: raw }));
    res.writeHead(resp.status, Object.fromEntries(resp.headers));
    if (resp.body) Readable.fromWeb(resp.body as never).pipe(res);
    else res.end();
  });

  return {
    mcpUrl: `${mcp.origin}/mcp`,
    issuer: opts.asIssuer ?? as.origin,
    idpTokenEndpoint: `${idp.origin}/token`,
    asTokenEndpoint: `${as.origin}/token`,
    asHits,
    idpHits,
    mcpAuth,
    setExpiresIn: (s) => (expiresIn = s),
    close: async () => {
      await handler.close();
      await Promise.all([as.server, idp.server, mcp.server].map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    },
  };
}
