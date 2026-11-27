// Minimal newline-delimited JSON-RPC "MCP server" for the bridge tests: replies to every request.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notification
  if (m.method === "exit") process.exit(3);
  const result =
    m.method === "pid" ? { pid: process.pid }
    : m.method === "env" ? { foo: process.env.FOO ?? null, secret: process.env.BRIDGE_TEST_SECRET ?? null }
    : { echo: m.method, params: m.params ?? null };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
});
rl.on("close", () => process.exit(0));
