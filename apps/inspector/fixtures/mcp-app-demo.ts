// Demo MCP server with one MCP App (SEP-1865, io.modelcontextprotocol/ui) so the inspector's
// Apps tab can be exercised offline. Stdio server; connect it from the inspector as
//   transport stdio, command `npx`, args `tsx fixtures/mcp-app-demo.ts`
// (the proxy runs from apps/inspector under `npm run dev`, so the path is relative to it).
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";

export const COUNTER_URI = "ui://demo/counter.html";

// A trivial View. It speaks the app side of the protocol by hand (JSON-RPC over postMessage to
// its parent, the sandbox proxy) so it needs no script, no network, and the default CSP is enough.
export const COUNTER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Counter</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 16px; color: #223; background: #eef1f6; }
  button { font: inherit; padding: 6px 14px; }
  output { font-weight: 700; font-size: 1.6em; display: block; margin: 8px 0; }
</style></head>
<body>
  <h2>Demo counter app</h2>
  <p>Counter lives on the MCP server. The button calls the app-only <code>next_count</code> tool back through the host.</p>
  <output id="count" aria-live="polite">-</output>
  <button id="inc" disabled>next_count</button>
  <p id="note" role="status"></p>
<script>
  let seq = 0;
  const pending = new Map();
  const send = (m) => parent.postMessage({ jsonrpc: "2.0", ...m }, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (m && m.id != null && !m.method && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m && m.method === "ui/notifications/tool-result") {
      show(m.params);
    } else if (m && m.method === "ui/resource-teardown" && m.id != null) {
      send({ id: m.id, result: {} });
    }
  });
  const show = (r) => {
    const t = r && r.content && r.content.find((c) => c.type === "text");
    if (t) document.getElementById("count").textContent = t.text;
  };
  const sizeChanged = () => send({ method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
  (async () => {
    await request("ui/initialize", { appInfo: { name: "demo-counter", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
    send({ method: "ui/notifications/initialized", params: {} });
    const btn = document.getElementById("inc");
    btn.disabled = false;
    btn.onclick = async () => {
      try { show(await request("tools/call", { name: "next_count", arguments: {} })); }
      catch (err) { document.getElementById("note").textContent = "error: " + err.message; }
    };
    sizeChanged();
  })();
</script></body></html>`;

let count = 0;
const server = new McpServer({ name: "mcp-app-demo", version: "1.0.0" });

registerAppTool(
  server,
  "show_counter",
  {
    title: "Show counter",
    description: "Open the demo counter app.",
    _meta: { ui: { resourceUri: COUNTER_URI } },
  },
  async () => ({ content: [{ type: "text", text: String(count) }] }),
);

registerAppTool(
  server,
  "next_count",
  {
    description: "Increment the demo counter and return it. App-only: hidden from the model.",
    _meta: { ui: { resourceUri: COUNTER_URI, visibility: ["app"] } },
  },
  async () => ({ content: [{ type: "text", text: String(++count) }] }),
);

registerAppResource(server, "Demo counter", COUNTER_URI, { description: "Trivial MCP App for the inspector" }, async () => ({
  contents: [{ uri: COUNTER_URI, mimeType: RESOURCE_MIME_TYPE, text: COUNTER_HTML }],
}));

await server.connect(new StdioServerTransport());
