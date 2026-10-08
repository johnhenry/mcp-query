// Minimal external store with the useSyncExternalStore contract mcp-query's cache entries use:
// subscribe(cb) -> unsubscribe, getSnapshot() -> an immutable value that changes identity on change.
export interface Store<T> {
  getState(): T;
  subscribe(cb: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> & { update(patch: Partial<T> | ((s: T) => Partial<T>)): void } {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    update(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const cb of [...subs]) {
        try {
          cb();
        } catch (e) {
          console.error("[mcp-query-ui] subscriber threw:", e);
        }
      }
    },
  };
}
