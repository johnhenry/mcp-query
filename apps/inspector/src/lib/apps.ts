// MCP Apps glue for the inspector: which tools carry an app, one AppHost per server, and where
// the sandbox proxy page lives. Framework-free (the Apps panel is a Web Component).
import { createAppHost, type AppHost } from "@johnhenry/mcp-query-ui";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { MCPClient } from "@johnhenry/mcp-query";

export interface AppTool {
  name: string;
  uri: string;
  description?: string;
  inputSchema?: unknown;
  /** true when the tool is visible to the app but hidden from the model. */
  appOnly: boolean;
}

/** Tools of `server` that declare `_meta.ui.resourceUri` (the ones that open an app). */
export function listAppTools(client: Pick<MCPClient, "listTools">, server: string): AppTool[] {
  const out: AppTool[] = [];
  for (const t of client.listTools(server) as Array<{ name: string; description?: string; inputSchema?: unknown; _meta?: Record<string, unknown> }>) {
    const uri = getToolUiResourceUri(t as never);
    if (!uri) continue;
    const vis = (t._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
    out.push({
      name: t.name,
      uri,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
      appOnly: Array.isArray(vis) && vis.includes("app") && !vis.includes("model"),
    });
  }
  return out;
}

const hosts = new WeakMap<MCPClient, Map<string, AppHost>>();
/**
 * One AppHost per (client, inspected server): the host resolves tools/resources against that server only.
 * Keyed by client too, because governed mode opens the same server through a second, gated client.
 */
export function hostFor(client: MCPClient, server: string): AppHost {
  let byServer = hosts.get(client);
  if (!byServer) hosts.set(client, (byServer = new Map()));
  let h = byServer.get(server);
  if (!h) byServer.set(server, (h = createAppHost({ client, server, hostInfo: { name: "mcp-inspector", version: "0.0.1" } })));
  return h;
}

/**
 * The sandbox proxy must be a DIFFERENT origin from the inspector (SEP-1865). Default: the same
 * machine under the other loopback name (`localhost` <-> `127.0.0.1`) on SANDBOX port 5174, so it
 * differs by host and port. `?host=` pins the proxy's postMessage target to this page's origin.
 */
export function sandboxProxyUrl(loc: Pick<Location, "hostname" | "origin" | "search">): string {
  const other = loc.hostname === "localhost" ? "127.0.0.1" : "localhost";
  const port = new URLSearchParams(loc.search).get("sandboxPort") ?? "5174";
  return `http://${other}:${port}/proxy.html?host=${encodeURIComponent(loc.origin)}`;
}
