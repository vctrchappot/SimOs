import { isInside, normalize } from "./path";
import type { MemoryFS } from "./memory-fs";

export interface StoredEntry {
  path: string;
  kind: "file" | "dir";
  data?: Uint8Array;
  mtime: number;
}

export type StoreOp = { op: "put"; entry: StoredEntry } | { op: "delete"; path: string };

/** Durable backing store for a project. */
export interface ProjectStore {
  loadAll(): Promise<StoredEntry[]>;
  apply(ops: StoreOp[]): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryProjectStore implements ProjectStore {
  entries = new Map<string, StoredEntry>();
  async loadAll() {
    return [...this.entries.values()].map((e) => ({ ...e, data: e.data?.slice() }));
  }
  async apply(ops: StoreOp[]) {
    for (const o of ops) {
      if (o.op === "put") this.entries.set(o.entry.path, { ...o.entry, data: o.entry.data?.slice() });
      else for (const k of [...this.entries.keys()]) if (isInside(o.path, k)) this.entries.delete(k);
    }
  }
  async clear() {
    this.entries.clear();
  }
}

const DB_VERSION = 1;
const STORE = "entries";

/** IndexedDB-backed store: one record per path, so edits are incremental. */
export class IdbProjectStore implements ProjectStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private name: string,
    private factory: IDBFactory = indexedDB,
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = this.factory.open(this.name, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "path" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  loadAll(): Promise<StoredEntry[]> {
    return this.run("readonly", (s) => s.getAll());
  }

  async apply(ops: StoreOp[]): Promise<void> {
    if (!ops.length) return;
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const o of ops) {
        if (o.op === "put") store.put(o.entry);
        else {
          const p = normalize(o.path);
          store.delete(p);
          store.delete(IDBKeyRange.bound(p + "/", p + "/￿"));
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async clear(): Promise<void> {
    await this.run("readwrite", (s) => s.clear());
  }
}

/**
 * Mirrors every change in a MemoryFS into a ProjectStore. Writes are batched; call flush()
 * to wait until everything observed so far is durable.
 */
export class PersistenceBinding {
  private pending: StoreOp[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  lastError: unknown = null;

  constructor(
    private fs: MemoryFS,
    private store: ProjectStore,
    private delayMs = 100,
  ) {
    this.unsubscribe = fs.subscribe((ev) => {
      switch (ev.type) {
        case "write":
        case "mkdir":
          this.put(ev.path);
          break;
        case "remove":
          this.pending.push({ op: "delete", path: ev.path });
          break;
        case "rename":
          this.pending.push({ op: "delete", path: ev.from });
          for (const e of fs.list()) if (isInside(ev.path, e.path)) this.put(e.path);
          break;
      }
      this.schedule();
    });
  }

  private put(path: string) {
    const stat = this.fs.stat(path);
    if (!stat) return;
    this.pending.push({
      op: "put",
      entry: { path, kind: stat.kind, mtime: stat.mtime, data: stat.kind === "file" ? this.fs.readFile(path) : undefined },
    });
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ops = this.pending;
    this.pending = [];
    this.inflight = this.inflight
      .then(() => this.store.apply(ops))
      .catch((e) => {
        this.lastError = e;
      });
    await this.inflight;
  }

  dispose() {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Loads the persisted project into fs. Returns false if nothing was stored yet. */
export async function restoreProject(fs: MemoryFS, store: ProjectStore): Promise<boolean> {
  const entries = await store.loadAll();
  if (!entries.length) return false;
  fs.load(entries);
  return true;
}

export function seedProject(fs: MemoryFS, template: Record<string, string>): void {
  for (const [path, content] of Object.entries(template)) fs.writeFile(path, content, "init");
}
