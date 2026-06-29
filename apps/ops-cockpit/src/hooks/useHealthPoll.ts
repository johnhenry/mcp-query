// Polls client.health() on an interval and accumulates a rolling latency history per
// server. One shared poller for the whole grid (cheaper than one timer per tile). The
// returned map is keyed by server name; tiles read their slice from it.

import { useEffect, useRef, useState } from "react";
import type { MCPClient } from "mcp-query";
import { pushSample, type LatencySample } from "../lib/sparkline.js";
import type { HealthSnapshot } from "../lib/tile-status.js";

export interface ServerHealth {
  snap?: HealthSnapshot;
  history: LatencySample[];
}

export function useHealthPoll(client: MCPClient, intervalMs: number): Record<string, ServerHealth> {
  const [health, setHealth] = useState<Record<string, ServerHealth>>({});
  const histRef = useRef<Record<string, LatencySample[]>>({});

  useEffect(() => {
    let live = true;

    async function tick() {
      let snaps: Record<string, HealthSnapshot> = {};
      try {
        snaps = await client.health();
      } catch {
        snaps = {};
      }
      if (!live) return;
      const now = Date.now();
      const next: Record<string, ServerHealth> = {};
      const names = new Set([...Object.keys(snaps), ...Object.keys(histRef.current)]);
      for (const name of names) {
        const snap = snaps[name];
        const prev = histRef.current[name] ?? [];
        const updated = snap ? pushSample(prev, { t: now, ms: snap.ok ? snap.pingMs : undefined }) : prev;
        histRef.current[name] = updated;
        next[name] = { snap, history: updated };
      }
      setHealth(next);
    }

    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client, intervalMs]);

  return health;
}
