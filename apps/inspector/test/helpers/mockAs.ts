// (Copied from packages/mcp-contract/test/helpers/mockAs.ts, plus CORS for browser-style callers.)
// Local mock MCP resource server + authorization server for OAuth tests. No third-party network.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createPublicKey, verify as cryptoVerify, type webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;

export interface MockAsOptions {
  /** Advertise client_id_metadata_document_supported. */
  cimd?: boolean;
  /** Offer a registration_endpoint. Default true. */
  dcr?: boolean;
  /** `iss` returned on the authorization redirect (default: the real issuer). `null` omits it. */
  issOnRedirect?: string | null;
  /** Advertise authorization_response_iss_parameter_supported. Default true. */
  issSupported?: boolean;
  /** Issuer string in the metadata document. Default: the server's own origin. */
  issuer?: string;
}

export interface Recorded {
  registrations: Record<string, unknown>[];
  authorizeQueries: URLSearchParams[];
  tokenRequests: { body: URLSearchParams; headers: IncomingMessage["headers"]; dpop?: { valid: boolean; htm?: string; htu?: string; jkt?: string } }[];
}

const b64u = (s: string) => Buffer.from(s, "base64url");

/** Verify a DPoP proof's signature against its embedded JWK (ES256). */
export function checkDpopProof(proof: string | undefined): { valid: boolean; htm?: string; htu?: string; jkt?: string } {
  if (!proof) return { valid: false };
  const [h, p, sig] = proof.split(".");
  if (!h || !p || !sig) return { valid: false };
  try {
    const header = JSON.parse(b64u(h).toString()) as { typ?: string; alg?: string; jwk?: JsonWebKey };
    const payload = JSON.parse(b64u(p).toString()) as { htm?: string; htu?: string; jti?: string };
    if (header.typ !== "dpop+jwt" || !header.jwk || !payload.jti) return { valid: false };
    const key = createPublicKey({ key: header.jwk, format: "jwk" });
    const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, b64u(sig));
    return { valid: ok, htm: payload.htm, htu: payload.htu, jkt: JSON.stringify({ crv: header.jwk.crv, kty: header.jwk.kty, x: header.jwk.x, y: header.jwk.y }) };
  } catch {
    return { valid: false };
  }
}

export interface MockAs {
  /** The protected MCP resource (always answers 401 + resource metadata pointing at the AS). */
  mcpUrl: string;
  issuer: string;
  rec: Recorded;
  close(): Promise<void>;
}

function listen(handler: (req: IncomingMessage, res: ServerResponse, origin: string) => void | Promise<void>): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      void Promise.resolve(handler(req, res, origin)).catch((e) => {
        res.writeHead(500).end(String(e));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-expose-headers": "www-authenticate" };
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...CORS, ...headers });
  res.end(JSON.stringify(body));
};

export async function startMockAs(opts: MockAsOptions = {}): Promise<MockAs> {
  const rec: Recorded = { registrations: [], authorizeQueries: [], tokenRequests: [] };
  const as = await listen(async (req, res, origin) => {
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();
    const issuer = opts.issuer ?? origin;
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(opts.dcr === false ? {} : { registration_endpoint: `${origin}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
        dpop_signing_alg_values_supported: ["ES256"],
        ...(opts.cimd ? { client_id_metadata_document_supported: true } : {}),
        ...(opts.issSupported === false ? {} : { authorization_response_iss_parameter_supported: true }),
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      rec.registrations.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      return json(res, 201, { client_id: "dcr-client-1", redirect_uris: (rec.registrations.at(-1) as { redirect_uris: string[] }).redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/authorize") {
      rec.authorizeQueries.push(url.searchParams);
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "auth-code-1");
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      const iss = opts.issOnRedirect === undefined ? issuer : opts.issOnRedirect;
      if (iss !== null) redirect.searchParams.set("iss", iss);
      res.writeHead(302, { location: redirect.toString() });
      return void res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const dpopHeader = req.headers.dpop as string | undefined;
      const dpop = dpopHeader ? checkDpopProof(dpopHeader) : undefined;
      rec.tokenRequests.push({ body, headers: req.headers, ...(dpop ? { dpop } : {}) });
      return json(res, 200, { access_token: `at-${rec.tokenRequests.length}`, token_type: dpop ? "DPoP" : "Bearer", expires_in: 3600, refresh_token: "rt-1" });
    }
    res.writeHead(404).end();
  });
  const mcp = await listen((req, res, origin) => {
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [as.origin] });
    }
    res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`, "content-type": "application/json", ...CORS });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  return {
    mcpUrl: `${mcp.origin}/mcp`,
    issuer: opts.issuer ?? as.origin,
    rec,
    close: async () => {
      await Promise.all([as.server, mcp.server].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
