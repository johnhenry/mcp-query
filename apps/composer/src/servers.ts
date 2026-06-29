// Persisted MCP server list. Composer multiplexes any number of MCP servers through the
// shared WS proxy; the user can add/remove them and the set is saved to localStorage.
// Each entry is a TargetSpec the proxy knows how to dial (stdio command, or http url).

import type { TargetSpec } from "@app-shared";

export interface ServerEntry {
  name: string;
  spec: TargetSpec;
}

const STORAGE_KEY = "composer.servers";

/** The zero-config starting point: the reference "everything" server over stdio. */
export function defaultServers(): ServerEntry[] {
  return [
    {
      name: "everything",
      spec: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    },
  ];
}

export function loadServers(): ServerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultServers();
    const parsed = JSON.parse(raw) as ServerEntry[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultServers();
    return parsed;
  } catch {
    return defaultServers();
  }
}

export function saveServers(servers: ServerEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
  } catch {
    /* storage may be unavailable */
  }
}

/** Build a TargetSpec from add-server form input (stdio command line OR http url). */
export function specFromForm(input: {
  kind: "stdio" | "http";
  command?: string;
  url?: string;
}): TargetSpec | null {
  if (input.kind === "http") {
    const url = input.url?.trim();
    if (!url) return null;
    return { transport: "http", url };
  }
  const line = input.command?.trim();
  if (!line) return null;
  const parts = line.split(/\s+/);
  const command = parts[0]!;
  const args = parts.slice(1);
  return { transport: "stdio", command, args };
}

/** Convert a record of server entries into the `servers` map makeProxyClient wants. */
export function toServerMap(servers: ServerEntry[]): Record<string, TargetSpec> {
  const out: Record<string, TargetSpec> = {};
  for (const s of servers) out[s.name] = s.spec;
  return out;
}
