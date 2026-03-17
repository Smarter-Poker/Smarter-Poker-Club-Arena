/**
 * Offline Mutation Queue Utilities (localStorage-based)
 *
 * @deprecated Prefer OfflineQueueService (IndexedDB-based) for new code.
 * This module is kept for backward compatibility with App.tsx, BusDevToolsPage,
 * and OfflineQueueBadge. It will be removed in a future refactor.
 * See: src/services/OfflineQueueService.ts
 */

const QUEUE_KEY = 'offline_mutation_queue';
const MAX_QUEUE_SIZE = 50;

export interface QueuedMutation {
  id: string;
  timestamp: number;
  mutation: string;
  variables?: Record<string, any>;
}

/**
 * Add a mutation to the offline queue
 * Automatically enforces size cap by dropping oldest entries
 */
export function addToOfflineQueue(mutation: QueuedMutation): void {
  try {
    let queue: QueuedMutation[] = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');

    // Add new mutation
    queue.push(mutation);

    // Enforce size cap: keep only the newest MAX_QUEUE_SIZE items
    if (queue.length > MAX_QUEUE_SIZE) {
      const droppedCount = queue.length - MAX_QUEUE_SIZE;
      queue = queue.slice(-MAX_QUEUE_SIZE);
      console.warn(
        `[Offline Queue] Queue size exceeded ${MAX_QUEUE_SIZE}. Dropped ${droppedCount} oldest entries.`
      );
    }

    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    console.debug('[Offline Queue] Added mutation. Queue size:', queue.length);
  } catch (error) {
    console.error('[Offline Queue] Failed to add mutation:', error);
  }
}

/**
 * Get all queued mutations
 */
export function getOfflineQueue(): QueuedMutation[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Clear the offline queue
 */
export function clearOfflineQueue(): void {
  try {
    localStorage.removeItem(QUEUE_KEY);
    console.debug('[Offline Queue] Cleared');
  } catch (error) {
    console.error('[Offline Queue] Failed to clear:', error);
  }
}

/**
 * Get queue size
 */
export function getOfflineQueueSize(): number {
  return getOfflineQueue().length;
}

/**
 * Get max queue size constant
 */
export function getMaxQueueSize(): number {
  return MAX_QUEUE_SIZE;
}

/**
 * Replay all queued mutations against Supabase.
 * Uses exponential backoff on failure. Clears queue on success.
 */
export async function replayOfflineQueue(): Promise<void> {
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  console.debug('[Offline Queue] Replaying', queue.length, 'queued mutations');

  const failed: QueuedMutation[] = [];
  for (const item of queue) {
    let attempts = 0;
    let success = false;

    while (attempts < 3 && !success) {
      try {
        // Dynamic import to avoid circular deps
        const { retryAsync } = await import('../utils/retryAsync');
        const { supabase } = await import('../lib/supabase');

        let mutationError: any = null;

        if (item.mutation === 'INSERT' && item.variables?.table) {
          const { error } = await supabase
            .from(item.variables.table)
            .insert(item.variables.data || {});
          mutationError = error;
        } else if (item.mutation === 'UPDATE' && item.variables?.table && item.variables?.id) {
          // SECURITY: Scope updates to the user who queued them
          let query = supabase
            .from(item.variables.table)
            .update(item.variables.data || {})
            .eq('id', item.variables.id);
          if (item.variables.user_id) query = query.eq('user_id', item.variables.user_id);
          if (item.variables.club_id) query = query.eq('club_id', item.variables.club_id);
          const { error } = await query;
          mutationError = error;
        } else if (item.mutation === 'DELETE' && item.variables?.table && item.variables?.id) {
          let delQuery = supabase.from(item.variables.table).delete().eq('id', item.variables.id);
          if (item.variables.user_id) delQuery = delQuery.eq('user_id', item.variables.user_id);
          if (item.variables.club_id) delQuery = delQuery.eq('club_id', item.variables.club_id);
          const { error } = await delQuery;
          mutationError = error;
        } else if (item.mutation === 'RPC' && item.variables?.fn) {
          await retryAsync(() => supabase.rpc(item.variables!.fn, item.variables!.args || {}), 3);
        }

        if (mutationError) {
          throw mutationError;
        }
        success = true;
      } catch (e) {
        attempts++;
        if (attempts < 3) {
          // Exponential backoff: 500ms, 1500ms
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempts - 1)));
        }
      }
    }

    if (!success) {
      failed.push(item);
    }
  }

  // Clear queue, re-add failed items
  clearOfflineQueue();
  if (failed.length > 0) {
    console.warn('[Offline Queue] Failed to replay', failed.length, 'mutations');
    for (const f of failed) {
      addToOfflineQueue(f);
    }
  } else {
    console.debug('[Offline Queue] All mutations replayed successfully');
  }
}
