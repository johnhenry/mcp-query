// Pure data helpers for the cockpit tiles. Kept framework-free so they can be unit
// tested directly (no DOM, no client) and reused by both the live UI and the tests.

import type { ServerState } from "mcp-query";

/** A coarse health classification used for tile coloring + sorting. */
export type TileStatus = "healthy" | "warming" | "degraded" | "failed" | "offline";

/** The per-server health snapshot shape returned by `client.health()`. */
export interface HealthSnapshot {
  state: ServerState;
  pingMs?: number;
  ok: boolean;
}

/**
 * Map a (server lifecycle state, live ping result) pair to a coarse tile status.
 * A server can be `ready` but failing pings (silently dead) → that's "degraded".
 * A server still handshaking is "warming"; `failed`/`closed` are terminal.
 */
export function healthToTileStatus(snap: HealthSnapshot | undefined): TileStatus {
  if (!snap) return "offline";
  const { state, ok } = snap;
  if (state === "failed" || state === "closed") return "failed";
  if (state === "connecting" || state === "initializing") return "warming";
  if (state === "reconnecting") return "degraded";
  if (state === "degraded") return "degraded";
  if (state === "ready") return ok ? "healthy" : "degraded";
  // "idle" or anything unexpected
  return "offline";
}

/** CSS-friendly status → accent color token (hex; the stylesheet also keys off the class). */
export function statusColor(status: TileStatus): string {
  switch (status) {
    case "healthy":
      return "#3fb950";
    case "warming":
      return "#d29922";
    case "degraded":
      return "#db8b2a";
    case "failed":
      return "#f85149";
    case "offline":
      return "#6e7681";
  }
}

/** Human label for a tile status. */
export function statusLabel(status: TileStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "warming":
      return "Connecting";
    case "degraded":
      return "Degraded";
    case "failed":
      return "Failed";
    case "offline":
      return "Offline";
  }
}
