/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useMasterBusSubscription Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A React hook that wraps masterBus.subscribe() and subscribeDebounced() with
 * automatic cleanup, type safety, and the isMounted pattern to prevent stale
 * handler invocations after unmount.
 *
 * Features:
 * - Single event or multiple events in array
 * - Automatic subscription cleanup on unmount
 * - Type-safe payload inference from BusPayloadMap
 * - Optional debouncing via { debounce?: number } option
 * - isMounted pattern prevents handler invocation after unmount
 * - useRef for callback to prevent re-subscription on re-renders
 */

import { useEffect, useRef } from 'react';
import { masterBus, type BusEventType, type BusPayloadMap, type BusEvent } from '../core/MasterBus';

/**
 * Options for subscription behavior
 */
interface SubscriptionOptions {
  /** Debounce delay in milliseconds. If provided, uses subscribeDebounced; otherwise uses subscribe */
  debounce?: number;
}

/**
 * Single event subscription hook
 *
 * @example
 * useMasterBusSubscription('BALANCE_UPDATED', (payload) => {
 *   // payload is typed as BusPayloadMap['BALANCE_UPDATED']
 *   refreshBalance();
 * });
 *
 * @example
 * useMasterBusSubscription('TABLE_SEATED', handleRefresh, { debounce: 500 });
 */
export function useMasterBusSubscription<K extends BusEventType>(
  eventType: K,
  handler: (payload: BusPayloadMap[K]) => void,
  options?: SubscriptionOptions
): void {
  const handlerRef = useRef(handler);
  const isMountedRef = useRef(true);

  // Update handler ref on each call, but don't re-subscribe
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    isMountedRef.current = true;

    // Wrap handler to check isMounted before invoking
    const wrappedHandler = (event: BusEvent<BusPayloadMap[K]>) => {
      if (isMountedRef.current) {
        handlerRef.current(event.payload);
      }
    };

    // Subscribe based on options
    const unsubscribe = options?.debounce
      ? masterBus.subscribeDebounced(
          eventType,
          wrappedHandler as Parameters<typeof masterBus.subscribeDebounced>[1],
          options.debounce
        )
      : masterBus.subscribe(eventType, wrappedHandler as Parameters<typeof masterBus.subscribe>[1]);

    // Cleanup on unmount or when eventType/options change
    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [eventType, options?.debounce]);
}

/**
 * Multiple events subscription hook
 *
 * Subscribes to multiple events with a single handler that receives all events.
 * All events share ONE debounce window if the debounce option is provided.
 *
 * @example
 * useMasterBusSubscriptions(
 *   ['BALANCE_UPDATED', 'CHIPS_ADDED', 'CHIPS_WITHDRAWN'],
 *   handleRefresh,
 *   { debounce: 500 }
 * );
 */
export function useMasterBusSubscriptions(
  eventTypes: BusEventType[],
  handler: (payload: unknown) => void,
  options?: SubscriptionOptions
): void {
  const handlerRef = useRef(handler);
  const isMountedRef = useRef(true);

  // Update handler ref on each call, but don't re-subscribe
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    isMountedRef.current = true;

    // Wrap handler to check isMounted before invoking
    const wrappedHandler = (event: BusEvent<unknown>) => {
      if (isMountedRef.current) {
        handlerRef.current(event.payload);
      }
    };

    // ONE shared debounce timer across the whole event group.
    //
    // This used to call masterBus.subscribeDebounced once PER EVENT TYPE, and
    // subscribeDebounced allocates a fresh subscriber id and timer key per
    // call — so a group of N events got N independent timers, not the single
    // coalescing window this hook's own docstring promises.
    //
    // The cost was real. CashierPage.notifyWalletChange emits WALLET_REFRESHED
    // and BALANCE_UPDATED, both of which bypass MasterBus's fingerprint dedup,
    // and DynamicWallet listens for both in one grouped subscription — so a
    // single chip send ran fetchData() twice, 8 Supabase round trips. A
    // distribute emits a third event and ran it three times, 12 round trips.
    //
    // Trailing edge, last payload wins: every consumer of the grouped form is
    // an "any of these happened, go refetch" handler, so coalescing is both
    // what they want and what they already believed they were getting.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPayload: unknown;

    const debouncedHandler = (event: BusEvent<unknown>) => {
      if (!isMountedRef.current) return;
      lastPayload = event.payload;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (isMountedRef.current) handlerRef.current(lastPayload);
      }, options?.debounce);
    };

    const unsubscribers = eventTypes.map((eventType) =>
      masterBus.subscribe(
        eventType,
        (options?.debounce ? debouncedHandler : wrappedHandler) as Parameters<
          typeof masterBus.subscribe
        >[1]
      )
    );

    // Cleanup on unmount or when eventTypes/options change
    return () => {
      isMountedRef.current = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [eventTypes.join(','), options?.debounce]); // Safely detect exact array changes
}
