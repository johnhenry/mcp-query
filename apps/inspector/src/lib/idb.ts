// Minimal IndexedDB persistence for the message log (survives reloads). Raw IDB — no
// dependency. A Web Worker for off-main-thread indexing is a future refinement.

const DB = "mcp-inspector";
const STORE = "messages";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function persistEvent(ev: unknown): Promise<void> {
  const db = await open();
  db.transaction(STORE, "readwrite").objectStore(STORE).add(ev as object);
}

export async function loadEvents<T = unknown>(): Promise<T[]> {
  const db = await open();
  return new Promise((resolve) => {
    const out: T[] = [];
    const cur = db.transaction(STORE).objectStore(STORE).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { out.push(c.value as T); c.continue(); } else resolve(out);
    };
    cur.onerror = () => resolve(out);
  });
}

export async function clearEvents(): Promise<void> {
  const db = await open();
  db.transaction(STORE, "readwrite").objectStore(STORE).clear();
}
