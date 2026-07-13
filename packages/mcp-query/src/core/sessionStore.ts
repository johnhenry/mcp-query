// Session persistence (issue #8) — survive a page reload or transport drop with the
// same server-side session. Streamable HTTP servers key state on `Mcp-Session-Id`;
// without this, every reload/reconnect re-`initialize`s into a fresh session and the
// server silently forgets the client.
//
// A resumed connect skips `initialize` (the SDK detects `transport.sessionId`), so the
// record persists what the handshake would have negotiated alongside the id itself.

import type { ServerCapabilities } from "./types.js";

export interface PersistedSession {
  /** The transport session id (`Mcp-Session-Id` for Streamable HTTP). */
  sessionId: string;
  /** Capabilities from the original `initialize` — a resumed connect can't re-fetch them. */
  capabilities?: ServerCapabilities;
  /** Negotiated protocol version, so a resumed HTTP transport can send its version header. */
  protocolVersion?: string;
  /** serverInfo.version from the original handshake — restores `ServerConnection.protocolVersion`. */
  serverVersion?: string;
}

/**
 * Where a connection stashes its session record. Async-tolerant so backends can be
 * IndexedDB, Redis, etc. A store is per-server: give each server its own instance
 * (or its own key, for `webStorageSessionStore`).
 */
export interface SessionStore {
  get(): PersistedSession | undefined | Promise<PersistedSession | undefined>;
  set(session: PersistedSession): void | Promise<void>;
  clear(): void | Promise<void>;
}

/** In-process store — resumes across reconnects within one page/process lifetime. */
export function memorySessionStore(): SessionStore {
  let session: PersistedSession | undefined;
  return {
    get: () => session,
    set: (s) => void (session = s),
    clear: () => void (session = undefined),
  };
}

/** The subset of the Web Storage API the store needs (so tests can fake it). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Browser store on `window.sessionStorage` by default — same-tab lifetime, so a
 * refresh resumes the session and closing the tab drops it (mirroring the server's
 * own session semantics). Pass `localStorage` for cross-tab/restart persistence.
 */
export function webStorageSessionStore(key: string, storage?: StorageLike): SessionStore {
  const backing = storage ?? (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
  if (!backing) throw new Error("webStorageSessionStore: no sessionStorage available; pass a storage backend");
  return {
    get: () => {
      const raw = backing.getItem(key);
      if (raw == null) return undefined;
      try {
        const parsed = JSON.parse(raw) as PersistedSession;
        return typeof parsed?.sessionId === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    set: (s) => backing.setItem(key, JSON.stringify(s)),
    clear: () => backing.removeItem(key),
  };
}
