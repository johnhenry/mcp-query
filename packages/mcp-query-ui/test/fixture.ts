// Fixture: one MCP server exposing one MCP App (ui:// resource) + the tools around it, fronted by a
// real mcp-gate so app-initiated calls run the same policy/approval/audit stack as any other client.
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { createGate, type GateConfig } from "@johnhenry/mcp-gate";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { vi } from "vitest";
import { createAppHost, type AppHostOptions, type AppSession } from "../src/index.js";

export const APP_URI = "ui://demo/app";

export async function makeFixture(
  gateExtra: Omit<GateConfig, "upstreams" | "audit"> = {},
  hostOpts: Partial<AppHostOptions> = {},
) {
  const ran: Array<{ tool: string; args: unknown }> = [];
  const textTool = (name: string, meta?: Record<string, unknown>) => ({
    name,
    _meta: meta,
    handler: (args: unknown) => (ran.push({ tool: name, args }), { content: [{ type: "text", text: `${name}:ok` }] }),
  });
  const mock = new MockMCPServer({
    tools: [
      textTool("show_app", { ui: { resourceUri: APP_URI } }),
      textTool("save", { ui: { resourceUri: APP_URI, visibility: ["model", "app"] } }),
      textTool("refresh", { ui: { resourceUri: APP_URI, visibility: ["app"] } }),
      textTool("model_only", { ui: { resourceUri: APP_URI, visibility: ["model"] } }),
    ],
    resources: [
      {
        uri: APP_URI,
        name: "demo app",
        mimeType: RESOURCE_MIME_TYPE,
        _meta: { ui: { csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] }, permissions: { camera: {} } } },
        read: () => ({ text: "<!doctype html><html><body>demo app</body></html>" }),
      },
      { uri: "ui://demo/not-html", mimeType: "text/plain", read: () => ({ text: "x" }) },
      { uri: "file:///data.txt", mimeType: "text/plain", read: () => ({ text: "data" }) },
    ],
  });
  const audit = vi.fn();
  const gate = await createGate({ upstreams: { demo: { transport: mock.transport } }, audit, ...gateExtra });
  const host = createAppHost({ client: gate.client, server: "demo", ...hostOpts });

  /** Open the app and connect a real ext-apps `App` (the View) over an in-memory transport. */
  async function openAndConnect(openOpts: Parameters<typeof host.open>[0] = { uri: APP_URI }) {
    const session = await host.open(openOpts);
    const [hostT, viewT] = InMemoryTransport.createLinkedPair();
    const app = new App({ name: "demo-view", version: "1.0.0" }, {}, { autoResize: false });
    await session.connect(hostT);
    await app.connect(viewT);
    await session.whenReady(2000);
    return { session, app };
  }
  const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
  return { mock, gate, host, ran, audit, openAndConnect, tick, close: async () => { await host.closeAll(); await gate.close(); } };
}

export type { AppSession };
