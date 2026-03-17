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
 * All events are debounced together if debounce option is provided.
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

    // Subscribe to all event types
    const unsubscribers = eventTypes.map((eventType) =>
      options?.debounce
        ? masterBus.subscribeDebounced(
            eventType,
            wrappedHandler as Parameters<typeof masterBus.subscribeDebounced>[1],
            options.debounce
          )
        : masterBus.subscribe(
            eventType,
            wrappedHandler as Parameters<typeof masterBus.subscribe>[1]
          )
    );

    // Cleanup on unmount or when eventTypes/options change
    return () => {
      isMountedRef.current = false;
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [eventTypes.length, options?.debounce]); // eventTypes.length as key to detect changes
}
