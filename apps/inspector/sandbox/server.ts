// Serves the sandbox proxy page from its own origin (default http://127.0.0.1:5174), so the host
// (http://localhost:5173) and the proxy differ by host AND port, as SEP-1865 requires. Static,
// no dependencies, GET-only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SANDBOX_PORT ?? 5174);
const FILES: Record<string, string> = {
  "/proxy.html": "text/html; charset=utf-8",
  "/proxy.js": "text/javascript; charset=utf-8",
  "/proxy-lib.js": "text/javascript; charset=utf-8",
};

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const type = FILES[path === "/" ? "/proxy.html" : path];
  if (req.method !== "GET" || !type) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    // The proxy only ever belongs inside a local inspector tab. Deliberately NOT a script-src policy:
    // the View's srcdoc iframe inherits the proxy's CSP, and the View's own (metadata-derived) CSP
    // is injected by proxy-lib instead.
    "content-security-policy": "frame-ancestors http://localhost:* http://127.0.0.1:*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(await readFile(join(here, path === "/" ? "/proxy.html" : path)));
}).listen(PORT, "127.0.0.1", () => console.log(`\n  ⬡ MCP App sandbox proxy  http://127.0.0.1:${PORT}/proxy.html\n`));
