/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DELTA SYNC SERVICE — Incremental table state synchronization
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Maintains local state with version tracking. Accepts delta updates
 * containing only changed fields, reducing WebSocket payload by ~60-80%.
 * Falls back to full snapshot if version gap is detected.
 */

import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DeltaMessage {
  type: 'DELTA' | 'SNAPSHOT';
  version: number;
  data: Record<string, unknown>;
}

export interface SyncState<T extends Record<string, unknown>> {
  data: T;
  version: number;
  lastSyncAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class DeltaSyncService<T extends Record<string, unknown>> {
  private state: SyncState<T>;
  private changeListeners: ((state: T, changedKeys: string[]) => void)[] = [];
  private snapshotRequestCallback: (() => void) | null = null;

  constructor(initialState: T) {
    this.state = {
      data: { ...initialState },
      version: 0,
      lastSyncAt: Date.now(),
    };
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Process an incoming delta or snapshot message
   */
  processMessage(message: DeltaMessage): { applied: boolean; changedKeys: string[] } {
    if (message.type === 'SNAPSHOT') {
      // Full state replacement
      this.state = {
        data: message.data as T,
        version: message.version,
        lastSyncAt: Date.now(),
      };
      const allKeys = Object.keys(message.data);
      this.notifyListeners(allKeys);
      return { applied: true, changedKeys: allKeys };
    }

    if (message.type === 'DELTA') {
      // Version gap check — request full snapshot if we missed updates
      if (message.version > this.state.version + 1) {
        console.warn(
          `[DeltaSync] Version gap: local=${this.state.version}, received=${message.version}. Requesting snapshot.`
        );
        this.requestSnapshot();
        return { applied: false, changedKeys: [] };
      }

      // Skip stale or duplicate deltas
      if (message.version <= this.state.version) {
        return { applied: false, changedKeys: [] };
      }

      // Apply delta — immutable merge
      const changedKeys = Object.keys(message.data);
      const newData: T = { ...this.state.data };

      for (const key of changedKeys) {
        const value = message.data[key];
        if (value === null) {
          // Convention: null means "delete this key"
          delete (newData as Record<string, unknown>)[key];
        } else if (value !== undefined) {
          // Deep merge for nested objects, shallow for primitives/arrays
          if (
            typeof value === 'object' &&
            !Array.isArray(value) &&
            typeof (newData as Record<string, unknown>)[key] === 'object' &&
            (newData as Record<string, unknown>)[key] !== null
          ) {
            (newData as Record<string, unknown>)[key] = {
              ...((newData as Record<string, unknown>)[key] as Record<string, unknown>),
              ...(value as Record<string, unknown>),
            };
          } else {
            (newData as Record<string, unknown>)[key] = value;
          }
        }
      }

      this.state = {
        data: newData,
        version: message.version,
        lastSyncAt: Date.now(),
      };

      this.notifyListeners(changedKeys);
      return { applied: true, changedKeys };
    }

    return { applied: false, changedKeys: [] };
  }

  /**
   * Get current state
   */
  getState(): T {
    return this.state.data;
  }

  /**
   * Get current version
   */
  getVersion(): number {
    return this.state.version;
  }

  /**
   * Get time since last sync
   */
  getTimeSinceSync(): number {
    return Date.now() - this.state.lastSyncAt;
  }

  /**
   * Register a change listener
   */
  onChange(listener: (state: T, changedKeys: string[]) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Set callback for when a full snapshot is needed
   */
  onSnapshotRequest(callback: () => void): void {
    this.snapshotRequestCallback = callback;
  }

  /**
   * Create a delta from two states (for server-side use)
   */
  static createDelta<S extends Record<string, unknown>>(
    oldState: S,
    newState: S,
    version: number
  ): DeltaMessage | null {
    const changedKeys: Record<string, unknown> = {};
    let hasChanges = false;

    for (const key of Object.keys(newState)) {
      if (JSON.stringify(oldState[key]) !== JSON.stringify(newState[key])) {
        changedKeys[key] = newState[key];
        hasChanges = true;
      }
    }

    // Detect removed keys (in oldState but not in newState)
    for (const key of Object.keys(oldState)) {
      if (!(key in newState)) {
        changedKeys[key] = null; // null sentinel = delete
        hasChanges = true;
      }
    }

    if (!hasChanges) return null;

    return {
      type: 'DELTA',
      version,
      data: changedKeys,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private notifyListeners(changedKeys: string[]): void {
    for (const listener of this.changeListeners) {
      try {
        listener(this.state.data, changedKeys);
      } catch (err: unknown) {
        reportError(err, 'DeltaSyncService.listener');
      }
    }
  }

  private requestSnapshot(): void {
    if (this.snapshotRequestCallback) {
      this.snapshotRequestCallback();
    }
  }
}

export default DeltaSyncService;
