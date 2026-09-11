/**
 * Refresh tournament-manager timer views after the database thaw commits.
 *
 * This work is useful but cannot be part of the admission barrier: the thaw
 * RPC has already atomically released the durable maintenance row, so holding
 * every local table behind one slow manager would create a split state where
 * database entry is open and the dealer is still frozen. Each manager's own
 * method re-reads the durable add-on deadline before acting. This helper only
 * bounds and lifecycle-owns those independent refreshes.
 */

export const POST_THAW_MANAGER_RESYNC_TIMEOUT_MS = 10_000;

export interface PostThawResyncManager {
  resyncAddOnPeriodAfterMaintenanceThaw(): Promise<void>;
}

export async function resyncManagersAfterMaintenanceThaw(
  managers: Iterable<PostThawResyncManager>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
  timeoutMs = POST_THAW_MANAGER_RESYNC_TIMEOUT_MS
): Promise<void> {
  await Promise.all(
    [...managers].map(async (manager) => {
      if (signal.aborted) return;

      const operation = Promise.resolve().then(() =>
        manager.resyncAddOnPeriodAfterMaintenanceThaw()
      );
      let timer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;
      const lifecycleFence = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('maintenance_post_thaw_manager_resync_timeout')),
          timeoutMs
        );
        onAbort = () => reject(signal.reason ?? new Error('maintenance_break_stopped'));
        signal.addEventListener('abort', onAbort, { once: true });
      });

      try {
        await Promise.race([operation, lifecycleFence]);
      } catch (error) {
        if (!signal.aborted) onError(error);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    })
  );
}
