import { applyOverlay } from "./overlay";
import { SyncEngine, type SyncOptions } from "./runtime/sync";
import type { OSRuntime } from "./runtime/types";
import { PersistenceBinding, restoreProject, seedProject, type ProjectStore } from "./vfs/persistence";
import { MemoryFS } from "./vfs/memory-fs";

export interface StudioOptions {
  runtime: OSRuntime;
  store: ProjectStore;
  template: Record<string, string>;
  sync?: SyncOptions;
}

/**
 * Ties the pieces together: one project filesystem, durably persisted, mirrored into
 * whichever OS runtime is currently powered on.
 */
export class Studio {
  readonly fs = new MemoryFS();
  readonly runtime: OSRuntime;
  private persistence: PersistenceBinding | null = null;
  private sync: SyncEngine | null = null;
  private changeCbs = new Set<() => void>();
  syncErrors: unknown[] = [];

  constructor(private opts: StudioOptions) {
    this.runtime = opts.runtime;
  }

  /** Loads the persisted project, or creates one from the template on first launch. */
  async init(): Promise<void> {
    const restored = await restoreProject(this.fs, this.opts.store);
    this.persistence = new PersistenceBinding(this.fs, this.opts.store);
    if (!restored) {
      seedProject(this.fs, this.opts.template);
      await this.persistence.flush();
    }
    this.fs.subscribe(() => this.emitChange());
    this.emitChange();
  }

  onChange(cb: () => void): () => void {
    this.changeCbs.add(cb);
    return () => void this.changeCbs.delete(cb);
  }

  private emitChange() {
    for (const cb of [...this.changeCbs]) cb();
  }

  /** Resolves when everything edited so far is durable and delivered to the running OS. */
  async settle(): Promise<void> {
    await this.sync?.idle();
    await this.persistence?.flush();
  }

  async start(): Promise<void> {
    if (this.runtime.status === "booting" || this.runtime.status === "running") return;
    await this.runtime.boot(async (guest, root) => {
      await applyOverlay(this.fs, root);
      this.sync = new SyncEngine(this.fs, guest, {
        ...this.opts.sync,
        onError: (e) => {
          this.syncErrors.push(e);
          this.opts.sync?.onError?.(e);
        },
      });
      await this.sync.start();
    });
  }

  /** Powers the OS off. Edits made inside it are pulled into the project first. */
  async stop(): Promise<void> {
    if (this.sync && this.runtime.status === "running") await this.sync.poll();
    this.sync?.stop();
    this.sync = null;
    await this.persistence?.flush();
    await this.runtime.shutdown();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Throws away the project and restores the template. */
  async reset(): Promise<void> {
    await this.stop();
    await this.persistence?.flush();
    await this.opts.store.clear();
    this.fs.clear();
    seedProject(this.fs, this.opts.template);
    await this.persistence?.flush();
    this.emitChange();
  }
}
