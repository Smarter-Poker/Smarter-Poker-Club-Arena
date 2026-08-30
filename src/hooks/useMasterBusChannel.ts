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
 * - Auto-recovery: registers a channel factory so the MasterBus health monitor
 *   re-subscribes the channel if it dies, instead of reaping it permanently.
 * - Subscribe-failure surfacing: CHANNEL_ERROR / TIMED_OUT are reported (not
 *   silently swallowed) and forwarded to an optional onSubscriptionError
 *   callback so the consumer can trigger a recovery fetch.
 */

import { useEffect, useRef } from 'react';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

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
  /**
   * Optional callback invoked when the realtime subscription fails
   * (CHANNEL_ERROR / TIMED_OUT). Lets the consumer surface a degraded-connection
   * state and/or trigger a recovery fetch so it isn't left blind while the
   * MasterBus health monitor works to re-subscribe. `status` is the raw
   * Supabase subscription status.
   */
  onSubscriptionError?: (status: string, err?: Error) => void;
  /** Receives every channel lifecycle status, including SUBSCRIBED after recovery. */
  onSubscriptionStatus?: (status: string) => void;
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
/**
 * Dev-only, once per channel name: a channel asked to subscribe with a null
 * filter did nothing. See the call site in the effect below.
 */
const warnedNullFilter = new Set<string>();
function warnNullFilterOnce(channelName: string): void {
  if (warnedNullFilter.has(channelName)) return;
  warnedNullFilter.add(channelName);
  console.warn(
    `[useMasterBusChannel] "${channelName}" was enabled but its filter is null, ` +
      'so NO subscription was created. If the filter is still loading this is ' +
      'expected and will resolve; if it is a literal null, this channel is dead ' +
      'code and the surface has no realtime coverage.'
  );
}

export function useMasterBusChannel({
  channelName,
  table,
  filter,
  event,
  onPayload,
  enabled = true,
  onSubscriptionError,
  onSubscriptionStatus,
}: UseMasterBusChannelOptions) {
  // Store callbacks in refs to avoid re-subscribing on every render
  const callbackRef = useRef(onPayload);
  const errorCallbackRef = useRef(onSubscriptionError);
  const statusCallbackRef = useRef(onSubscriptionStatus);

  // Update refs when callbacks change (but doesn't trigger re-subscription)
  useEffect(() => {
    callbackRef.current = onPayload;
  }, [onPayload]);
  useEffect(() => {
    errorCallbackRef.current = onSubscriptionError;
  }, [onSubscriptionError]);
  useEffect(() => {
    statusCallbackRef.current = onSubscriptionStatus;
  }, [onSubscriptionStatus]);

  useEffect(() => {
    // Null-safety: skip if no channel name or filter (common during data loading)
    if (!enabled || !channelName || !filter) {
      // 2026-08-24: this silent skip was a trap. Two pages
      // (LeaderboardPage, tournament/TournamentLobbyPage) passed a LITERAL
      // `filter: null` and therefore never subscribed at all, for their whole
      // lifetime - while the call site read as working realtime coverage. Both
      // quietly fell back to polling and nobody knew the channel was inert.
      //
      // A transient null during data loading is legitimate and must stay quiet,
      // so this warns in DEV ONLY and only once per channel name: enough to
      // catch a permanently-null filter in review, silent for the loading case
      // in production.
      if (import.meta.env?.DEV && enabled && channelName && !filter) {
        warnNullFilterOnce(channelName);
      }
      return;
    }

    // Factory that (re)creates and subscribes the channel. Registered with the
    // MasterBus health monitor so a channel that dies (auth expiry, RLS blip,
    // socket down) is RE-SUBSCRIBED on the next 30s tick instead of being
    // removed and left dead for the rest of the session (P2-4). This matters
    // for hole-card channels (`table-cards-secure-*`) where a permanently dead
    // channel silently blinds the hero.
    /* False the moment this effect is torn down. `supabase.removeChannel()` is
       asynchronous - it pushes an unsubscribe over the socket - so messages
       already in flight are still delivered to the binding afterwards, and on
       the club lobby that callback is a full refetch plus setState on a
       torn-down tree. The sibling hook (useMasterBusSubscription) already
       guards this; this one did not. */
    let alive = true;

    const subscribeChannel = () => {
      // getOrCreateChannel returns a fresh channel after the monitor removed
      // the dead one, or the existing one on the initial call.
      const channel = masterBus.getOrCreateChannel(channelName);

      /* A channel that is already joined will NOT send a new binding:
         RealtimeChannel.subscribe() builds its join payload only while the
         channel is 'closed'. Adding a second listener to a live shared channel
         therefore produces a subscription that receives nothing, silently,
         with no status callback to report it. Say so rather than pretend. */
      const state = (channel as any)?.state;
      if (state && state !== 'closed' && state !== 'errored') {
        reportError(
          new Error(`Realtime channel ${channelName} was already ${state}; binding skipped`),
          'useMasterBusChannel.channel_already_joined'
        );
        return;
      }

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
            if (alive) callbackRef.current(payload);
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (!alive) return;
          try {
            statusCallbackRef.current?.(status);
          } catch (cbErr) {
            reportError(cbErr, 'useMasterBusChannel.onSubscriptionStatus_threw');
          }
          /* CLOSED is what arrives when the socket drops or another owner
             removes a shared channel, and it was not handled at all - so the
             consumer went blind with nothing to tell it. */
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            // P2-3: do NOT silently swallow. Surface via the error reporter so
            // there is a metric/log, and forward to the consumer so it can flip
            // a degraded-connection state and/or force a recovery fetch. The
            // registered factory + health monitor will also attempt re-subscribe.
            reportError(
              err ?? new Error(`Realtime ${status} on ${channelName}`),
              `useMasterBusChannel.${status}.${table}`
            );
            try {
              errorCallbackRef.current?.(status, err);
            } catch (cbErr) {
              reportError(cbErr, 'useMasterBusChannel.onSubscriptionError_threw');
            }
          }
        });
    };

    // Register the factory FIRST so that if the very first subscribe attempt
    // dies, the health monitor can recover it.
    masterBus.registerChannelFactory(channelName, subscribeChannel);

    // Initial subscription
    subscribeChannel();

    // Cleanup: unregister the factory (so the monitor won't resurrect a channel
    // this component intentionally tore down) and remove the channel.
    return () => {
      alive = false;
      masterBus.removeChannelFactory(channelName);
      masterBus.removeRegisteredChannel(channelName);
    };
  }, [channelName, table, filter, event, enabled]);
}

export default useMasterBusChannel;
