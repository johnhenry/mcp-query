// Peer-floor smoke for @johnhenry/mcp-query-ui (manual; needs the npm registry).
//
//   node packages/mcp-query-ui/scripts/peer-floor-smoke.mjs [0.5.0 0.6.0 ...]
//
// For each published @johnhenry/mcp-query version given (default: the floor in package.json's
// peerDependencies plus the version after it), installs it from npm into a scratch project together with a
// packed tarball of THIS package, then runs a real host smoke against the mock server: open an app session,
// connect a real ext-apps `App` view, call a tool through the host, read a resource, and use the opt-in
// resources/list path (which must fall back to the synchronous list when `client.discover` is absent).
// Exits non-zero if any version fails. Floors only go up: if the floor fails, raise `peerDependencies`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const floor = String(pkg.peerDependencies["@johnhenry/mcp-query"]).replace(/^[>=^~\s]+/, "");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : [floor, "0.6.0"];

const SMOKE = `
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createAppHost, mcpAppsExtensions } from "@johnhenry/mcp-query-ui";

const URI = "ui://demo/app";
const ran = [];
const mock = new MockMCPServer({
  tools: [{ name: "show_app", _meta: { ui: { resourceUri: URI } }, handler: (a) => (ran.push(a), { content: [{ type: "text", text: "ok" }] }) }],
  resources: [{ uri: URI, name: "app", mimeType: RESOURCE_MIME_TYPE, read: () => ({ text: "<!doctype html><p>hi</p>" }) }],
});
const client = new MCPClient({ servers: { demo: { transport: mock.transport } }, extensions: mcpAppsExtensions() });
await client.connect?.("demo");
const have = typeof client.discover;
const host = createAppHost({ client, server: "demo", appCapabilities: { resourcesList: true } });
const session = await host.open({ tool: "show_app" });
const [hostT, viewT] = InMemoryTransport.createLinkedPair();
const app = new App({ name: "view", version: "1.0.0" }, {}, { autoResize: false });
await session.connect(hostT);
await app.connect(viewT);
await session.whenReady(3000);
const call = await app.callServerTool({ name: "show_app", arguments: { x: 1 } });
const read = await app.readServerResource({ uri: URI });
const list = await app.listServerResources();
const calls = session.getState().calls.map((c) => c.kind + ":" + c.outcome).join(",");
await host.closeAll();
await client.close?.();
const ok = ran.length === 1 && ran[0].x === 1 && call.content?.[0]?.text === "ok" && read.contents?.[0]?.uri === URI && list.resources.some((r) => r.uri === URI) && calls === "tool:ok,resource:ok,resources-list:ok";
console.log(JSON.stringify({ discover: have, calls, ok }));
process.exit(ok ? 0 : 1);
`;

const work = mkdtempSync(join(tmpdir(), "mcp-query-ui-peer-"));
const packDir = join(work, "pack");
mkdirSync(packDir);
const packed = execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: pkgDir, encoding: "utf8" }).trim().split("\n").pop();
const tarball = join(packDir, packed);
let failed = 0;
for (const v of versions) {
  const dir = join(work, `mcp-query-${v}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "peer-smoke", private: true, type: "module" }));
  writeFileSync(join(dir, "smoke.mjs"), SMOKE);
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("npm", ["install", "--no-audit", "--no-fund", "--silent", `@johnhenry/mcp-query@${v}`, tarball, "@modelcontextprotocol/client@^2", "@modelcontextprotocol/server@^2"]);
    const out = run("node", ["smoke.mjs"]);
    console.log(`@johnhenry/mcp-query@${v}: PASS ${out.trim()}`);
  } catch (e) {
    failed++;
    console.log(`@johnhenry/mcp-query@${v}: FAIL\n${e.stdout ?? ""}${e.stderr ?? e.message}`);
  }
}
console.log(`scratch: ${work}`);
process.exit(failed ? 1 : 0);
