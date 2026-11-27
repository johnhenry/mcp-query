// Minimal 2025-era newline-JSON stdio MCP server. FIXTURE_MODE: reply (unknown pre-init => -32601), silent (ignore unknown), exit (die on unknown pre-init)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = process.env.FIXTURE_MODE ?? "reply";
const mark = (s) => process.env.FIXTURE_MARK && appendFileSync(process.env.FIXTURE_MARK, `${s} ${process.pid}\n`);
mark("start");
let initialized = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") { initialized = true; return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy-fixture", version: "1" } } }); }
  if (m.id === undefined) return; // notification
  if (m.method === "tools/list" && initialized) return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "e", inputSchema: { type: "object" } }] } });
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (!initialized && mode === "silent") return;
  if (!initialized && mode === "exit") { mark("exit-on-unknown"); process.exit(1); }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
}).on("close", () => { mark("stdin-closed"); process.exit(0); });
