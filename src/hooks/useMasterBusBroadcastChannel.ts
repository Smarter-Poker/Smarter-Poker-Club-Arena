/**
 * Private Supabase Broadcast subscription owned by the MasterBus registry.
 *
 * Database Broadcast is independent of the Postgres Changes publication. It
 * is the scalable path for narrow server signals that do not need a row image.
 * The registry still owns cleanup and recovery, so a temporary channel error
 * cannot leave a mounted surface permanently stale.
 */

import { useEffect, useRef } from 'react';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

interface UseMasterBusBroadcastChannelOptions {
  channelName: string | null | undefined;
  event: string;
  onPayload: (payload: unknown) => void;
  enabled?: boolean;
  private?: boolean;
  onSubscriptionError?: (status: string, err?: Error) => void;
  onSubscriptionStatus?: (status: string) => void;
}

export function useMasterBusBroadcastChannel({
  channelName,
  event,
  onPayload,
  enabled = true,
  private: privateChannel = true,
  onSubscriptionError,
  onSubscriptionStatus,
}: UseMasterBusBroadcastChannelOptions): void {
  const callbackRef = useRef(onPayload);
  const errorCallbackRef = useRef(onSubscriptionError);
  const statusCallbackRef = useRef(onSubscriptionStatus);

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
    if (!enabled || !channelName) return;
    let alive = true;

    const subscribeChannel = () => {
      const channel = masterBus.getOrCreateChannel(channelName, { private: privateChannel });
      const state = (channel as any)?.state;
      if (state && state !== 'closed' && state !== 'errored') {
        reportError(
          new Error(`Realtime channel ${channelName} was already ${state}; binding skipped`),
          'useMasterBusBroadcastChannel.channel_already_joined'
        );
        return;
      }

      channel
        .on('broadcast', { event }, (payload: unknown) => {
          if (alive) callbackRef.current(payload);
        })
        .subscribe((status: string, err?: Error) => {
          if (!alive) return;
          try {
            statusCallbackRef.current?.(status);
          } catch (callbackError) {
            reportError(callbackError, 'useMasterBusBroadcastChannel.onSubscriptionStatus_threw');
          }
          if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') {
            return;
          }
          reportError(
            err ?? new Error(`Realtime ${status} on ${channelName}`),
            `useMasterBusBroadcastChannel.${status}.${event}`
          );
          try {
            errorCallbackRef.current?.(status, err);
          } catch (callbackError) {
            reportError(callbackError, 'useMasterBusBroadcastChannel.onSubscriptionError_threw');
          }
        });
    };

    masterBus.registerChannelFactory(channelName, subscribeChannel);
    subscribeChannel();

    return () => {
      alive = false;
      masterBus.removeChannelFactory(channelName);
      masterBus.removeRegisteredChannel(channelName);
    };
  }, [channelName, enabled, event, privateChannel]);
}

export default useMasterBusBroadcastChannel;
