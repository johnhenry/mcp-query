// SessionManager — pool one MCPClient per principal (own connections + credentials),
// with idle-TTL eviction. The *real* per-user-auth answer (vs the shared-client
// partition/meta path): each principal gets a dedicated, isolated client. Import from
// `mcp-query/session`.

import type { MCPClient } from "../core/client.js";

export interface SessionOptions {
  /** Build (and connect) a client for a principal. One per principal, isolated. */
  create: (principal: string) => MCPClient | Promise<MCPClient>;
  /** Idle ms before a principal's client is drained + evicted (sweep()). Default 5 min. */
  ttl?: number;
  now?: () => number;
}

interface Session {
  ready: Promise<MCPClient>;
  lastUsed: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private now: () => number;
  private ttl: number;

  constructor(private opts: SessionOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.ttl = opts.ttl ?? 5 * 60_000;
  }

  /** Get (creating once) the client for a principal. Concurrent calls share one create. */
  get(principal: string): Promise<MCPClient> {
    let s = this.sessions.get(principal);
    if (!s) {
      s = { ready: Promise.resolve(this.opts.create(principal)), lastUsed: this.now() };
      this.sessions.set(principal, s);
    }
    s.lastUsed = this.now();
    return s.ready;
  }

  /** Drain + remove a principal's client (e.g. on logout). */
  async evict(principal: string): Promise<void> {
    const s = this.sessions.get(principal);
    if (!s) return;
    this.sessions.delete(principal);
    await (await s.ready).drain().catch(() => {});
  }

  /** Evict every client idle longer than the TTL. Call on an interval. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - this.ttl;
    await Promise.allSettled(
      [...this.sessions].filter(([, s]) => s.lastUsed < cutoff).map(([p]) => this.evict(p)),
    );
  }

  /** Drain + remove all (graceful shutdown). */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((p) => this.evict(p)));
  }

  size(): number {
    return this.sessions.size;
  }
}
