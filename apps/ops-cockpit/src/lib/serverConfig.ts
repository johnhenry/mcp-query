// Server roster: the set of MCP servers the cockpit dials, persisted to localStorage
// so a reload keeps your monitored fleet. Each entry is a name + TargetSpec the proxy
// understands (stdio / http / sse).

import type { TargetSpec } from "@app-shared";

export type { TargetSpec };

export interface ServerEntry {
  name: string;
  spec: TargetSpec;
}

const STORAGE_KEY = "ops-cockpit.servers.v1";

/** Two stdio `server-everything` instances — a realistic NOC default to watch + kill. */
export const DEFAULT_SERVERS: ServerEntry[] = [
  {
    name: "everything-a",
    spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
  },
  {
    name: "everything-b",
    spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
  },
];

export function loadServers(): ServerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SERVERS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isServerEntry)) return parsed;
  } catch {
    /* ignore malformed storage */
  }
  return DEFAULT_SERVERS;
}

export function saveServers(servers: ServerEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
  } catch {
    /* storage may be unavailable (private mode) — non-fatal */
  }
}

/** Convert the roster into the `{ name -> TargetSpec }` map makeProxyClient expects. */
export function toSpecMap(servers: ServerEntry[]): Record<string, TargetSpec> {
  const out: Record<string, TargetSpec> = {};
  for (const s of servers) out[s.name] = s.spec;
  return out;
}

function isServerEntry(v: unknown): v is ServerEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e.name !== "string" || !e.spec || typeof e.spec !== "object") return false;
  const t = (e.spec as Record<string, unknown>).transport;
  return t === "stdio" || t === "http" || t === "sse";
}
