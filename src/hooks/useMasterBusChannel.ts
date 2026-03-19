/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useMasterBusChannel Hook — Master Bus Realtime Channel Wrapper
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps masterBus.getOrCreateChannel() with automatic useEffect cleanup via
 * removeRegisteredChannel(). Handles the full lifecycle of postgres_changes
 * subscriptions with built-in null-safety and multiple event support.
 *
 * Features:
 * - Automatic cleanup on unmount
 * - Null-safe: skips subscription if channelName or filter is empty
 * - Stable callback via useRef (prevents re-subscription on render)
 * - Support for multiple event types ('INSERT', 'UPDATE', 'DELETE', '*')
 * - Configurable enabled/disabled pattern
 */

import { useEffect, useRef } from 'react';
import { masterBus } from '../core/MasterBus';

export type PostgresChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface UseMasterBusChannelOptions {
  /** Channel identifier (required for subscription) */
  channelName: string | undefined | null;
  /** Database table name */
  table: string;
  /** Realtime filter (e.g., "club_id=eq.abc123") — required for subscription */
  filter: string | undefined | null;
  /** Event type(s) to listen for */
  event: PostgresChangeEvent;
  /** Callback function invoked when change arrives */
  onPayload: (payload: any) => void;
  /** Enable/disable the hook (default: true) */
  enabled?: boolean;
}

/**
 * Subscribes to Supabase realtime postgres_changes on a master bus channel.
 *
 * Null-safe: if channelName or filter is empty, subscription is skipped.
 * Automatically unsubscribes and cleans up on unmount or when deps change.
 *
 * @example
 * ```typescript
 * useMasterBusChannel({
 *   channelName: `club-${clubId}-tables`,
 *   table: 'tables',
 *   filter: `club_id=eq.${clubId}`,
 *   event: '*',
 *   onPayload: (payload) => handleTableChange(payload),
 *   enabled: !!clubId,
 * });
 * ```
 */
export function useMasterBusChannel({
  channelName,
  table,
  filter,
  event,
  onPayload,
  enabled = true,
}: UseMasterBusChannelOptions) {
  // Store callback in ref to avoid re-subscribing on every render
  const callbackRef = useRef(onPayload);

  // Update ref when callback changes (but doesn't trigger re-subscription)
  useEffect(() => {
    callbackRef.current = onPayload;
  }, [onPayload]);

  useEffect(() => {
    // Null-safety: skip if no channel name or filter (common during data loading)
    if (!enabled || !channelName || !filter) {
      return;
    }

    // Get or create the channel from the master bus
    const channel = masterBus.getOrCreateChannel(channelName);

    // Subscribe to postgres_changes for the specified table

    (channel as any)
      .on(
        'postgres_changes',
        {
          event,
          schema: 'public',
          table,
          filter,
        },
        (payload: any) => {
          // Call the stable callback ref
          callbackRef.current(payload);
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error(
            `[useMasterBusChannel] ❌ Channel error on ${channelName}:`,
            err?.message || err
          );
        }
        if (status === 'TIMED_OUT') {
          console.warn(
            `[useMasterBusChannel] ⏱️ Channel ${channelName} timed out — auto-reconnecting`
          );
        }
      });

    // Cleanup: remove the registered channel on unmount or when deps change
    return () => {
      masterBus.removeRegisteredChannel(channelName);
    };
  }, [channelName, table, filter, event, enabled]);
}

export default useMasterBusChannel;
