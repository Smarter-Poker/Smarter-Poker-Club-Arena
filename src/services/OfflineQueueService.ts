/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OFFLINE QUEUE SERVICE — IndexedDB-backed mutation queue
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Queues financial mutations when offline and auto-replays on reconnection.
 * - IndexedDB persistence (survives page refresh)
 * - Deduplication by operation ID
 * - Max 50 queued mutations
 * - Auto-replay on navigator.onLine event
 */

import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface QueuedMutation {
  id: string;
  operationId: string; // Dedup key
  action: 'ADD_CHIPS' | 'WITHDRAW_CHIPS' | 'CREDIT_COMMISSION' | 'CREDIT_RAKEBACK';
  payload: Record<string, unknown>;
  createdAt: number;
  retries: number;
}

const DB_NAME = 'club_arena_offline';
const STORE_NAME = 'mutations';
const MAX_QUEUE_SIZE = 50;

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const OfflineQueueService = {
  db: null as IDBDatabase | null,
  _onlineHandler: null as (() => void) | null,
  _isReplaying: false,

  /**
   * Initialize IndexedDB and set up online listener
   */
  async init(): Promise<void> {
    try {
      this.db = await this.openDB();
    } catch (err: unknown) {
      reportError(err, 'OfflineQueueService.IndexedDB_not_available');
    }

    // Remove previous listener if re-initializing (prevent stacking)
    if (this._onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this._onlineHandler);
    }

    // Auto-replay when coming back online
    if (typeof window !== 'undefined') {
      this._onlineHandler = () => {
        console.debug('[OfflineQueue] Back online - replaying queue');
        this.replayQueue();
      };
      window.addEventListener('online', this._onlineHandler);
    }
  },

  /**
   * Dispose — close DB and remove listeners
   */
  dispose(): void {
    if (this._onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  },

  /**
   * Queue a mutation for later execution
   */
  async enqueue(mutation: Omit<QueuedMutation, 'id' | 'createdAt' | 'retries'>): Promise<boolean> {
    if (!this.db) return false;

    // Check for duplicate operation
    const existing = await this.findByOperationId(mutation.operationId);
    if (existing) {
      reportError(
        new Error(`[OfflineQueue] Duplicate operation ${mutation.operationId} - skipping`),
        'OfflineQueueService.Duplicate_operation_mutationoperationId_'
      );
      return false;
    }

    // Enforce max queue size (drop oldest)
    const count = await this.getCount();
    if (count >= MAX_QUEUE_SIZE) {
      await this.dropOldest();
    }

    const entry: QueuedMutation = {
      ...mutation,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      retries: 0,
    };

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.add(entry);
      req.onsuccess = () => {
        console.debug(`[OfflineQueue] Queued: ${entry.action} (${entry.operationId})`);
        resolve(true);
      };
      req.onerror = () => {
        reportError(req.error, 'OfflineQueueService.Failed_to_queue_mutation');
        resolve(false);
      };
    });
  },

  /**
   * Replay all queued mutations
   * Guarded against concurrent execution to prevent double financial mutations.
   */
  async replayQueue(): Promise<{ replayed: number; failed: number }> {
    if (!this.db) return { replayed: 0, failed: 0 };

    // Concurrency guard — prevent double-execution from rapid 'online' events
    if (this._isReplaying) {
      console.debug('[OfflineQueue] Replay already in progress - skipping (not an error)');
      return { replayed: 0, failed: 0 };
    }
    this._isReplaying = true;

    try {
      const replayStart = Date.now();
      const mutations = await this.getAll();
      if (mutations.length === 0) {
        this._isReplaying = false;
        return { replayed: 0, failed: 0 };
      }

      console.debug(`[OfflineQueue] Replaying ${mutations.length} queued mutations`);

      let replayed = 0;
      let failed = 0;

      for (const mutation of mutations) {
        try {
          const success = await this.executeMutation(mutation);
          if (success) {
            await this.remove(mutation.id);
            replayed++;
          } else {
            mutation.retries++;
            if (mutation.retries >= 3) {
              reportError(
                new Error(`[OfflineQueue] Mutation ${mutation.id} failed 3 times - dropping`),
                'OfflineQueueService.Mutation_mutationid_failed_3_times__drop'
              );
              await this.remove(mutation.id);
              failed++;
            } else {
              await this.update(mutation);
              failed++;
            }
          }
        } catch (err: unknown) {
          reportError(err, 'OfflineQueueService.Error_replaying_mutationid');
          failed++;
        }
      }

      if (replayed > 0) {
        masterBus.emit('OFFLINE_QUEUE_REPLAYED', { replayed, failed });
        masterBus.emit('BALANCE_UPDATED', { source: 'offline_queue_replay' });
      }

      // Emit replay metrics
      try {
        masterBus.emit('OFFLINE_QUEUE_METRICS', {
          replayDurationMs: Date.now() - replayStart,
          mutationsReplayed: replayed,
          mutationsFailed: failed,
        });
      } catch (err) {
        reportError(err, 'OfflineQueueService.Error');
        /* non-fatal */
      }

      return { replayed, failed };
    } finally {
      this._isReplaying = false;
    }
  },

  /**
   * Execute a single mutation against Supabase.
   *
   * AUDIT M17: this used to replay four money mutations — ADD_CHIPS,
   * WITHDRAW_CHIPS, CREDIT_COMMISSION and CREDIT_RAKEBACK — by calling a
   * generic credit or deduct RPC with an amount read out of IndexedDB.
   *
   * Nothing in the codebase ever enqueued any of them, so none had run. That is
   * the only reason this was not the worst instance of the M17 pattern: a
   * caller-supplied amount, taken from browser-local storage, replayed after an
   * unknown delay, by a caller with no way to know whether the original
   * operation had already succeeded. Every property that makes a money path
   * safe was missing at once.
   *
   * The cases are removed rather than repaired. An offline queue must not move
   * money: a chip credit needs server-side authorization, an amount derived from
   * authoritative state, and idempotency against the operation it is replaying —
   * none of which a client-side replay buffer can supply. If offline money
   * operations are ever wanted, the queue should hold an INTENT that the server
   * validates and prices, not a pre-computed credit.
   *
   * The action type is deliberately left intact so that entries already sitting
   * in a user's IndexedDB from an older build are drained and rejected loudly
   * instead of being replayed by a future change.
   */
  async executeMutation(mutation: QueuedMutation): Promise<boolean> {
    reportError(
      new Error(`[OfflineQueue] Refusing to replay money mutation: ${mutation.action}`),
      'OfflineQueueService.MONEY_REPLAY_REFUSED',
      { action: mutation.action }
    );
    return false;
  },

  // ─── IndexedDB Helpers ────────────────────────────────────────────────

  openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2); // v2: added status index
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        // v1: Create initial store with operationId and createdAt indexes
        if (oldVersion < 1) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('operationId', 'operationId', { unique: true });
          store.createIndex('createdAt', 'createdAt');
        }

        // v2: Add status index for filtering pending/replayed/failed
        if (oldVersion < 2) {
          if (db.objectStoreNames.contains(STORE_NAME)) {
            const tx = (event.target as IDBOpenDBRequest).transaction!;
            const store = tx.objectStore(STORE_NAME);
            if (!store.indexNames.contains('status')) {
              store.createIndex('status', 'status');
            }
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  getAll(): Promise<QueuedMutation[]> {
    return new Promise((resolve) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.index('createdAt').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  },

  getCount(): Promise<number> {
    return new Promise((resolve) => {
      if (!this.db) return resolve(0);
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  },

  findByOperationId(operationId: string): Promise<QueuedMutation | undefined> {
    return new Promise((resolve) => {
      if (!this.db) return resolve(undefined);
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index('operationId');
      const req = index.get(operationId);
      req.onsuccess = () => resolve(req.result || undefined);
      req.onerror = () => resolve(undefined);
    });
  },

  remove(id: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  update(mutation: QueuedMutation): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(mutation);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  async dropOldest(): Promise<void> {
    const all = await this.getAll();
    if (all.length > 0) {
      await this.remove(all[0].id);
    }
  },

  /**
   * Clear all queued mutations (used by DevTools clear button)
   */
  clearAll(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },
};

export default OfflineQueueService;
