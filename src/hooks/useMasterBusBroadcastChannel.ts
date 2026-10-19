import { engineChannelClient } from '../services/EngineStateClient';
/**
 * Private Supabase Broadcast subscription owned by the MasterBus registry.
 *
 * Database Broadcast is independent of the Postgres Changes publication. It
 * is the scalable path for narrow server signals that do not need a row image.
 * The registry still owns cleanup and recovery, so a temporary channel error
 * cannot leave a mounted surface permanently stale.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { subscribeRealtime } from '../lib/subscribeRealtime';
import { reportError } from '../utils/errorReporter';

interface UseMasterBusBroadcastChannelOptions {
  channelName: string | null | undefined;
  event: string;
  onPayload: (payload: unknown) => void;
  enabled?: boolean;
  /** Explicit recovery re-authenticates and replaces only this subscription. */
  restartKey?: number;
  private?: boolean;
  onSubscriptionError?: (status: string, err?: Error) => void;
  onSubscriptionStatus?: (status: string) => void;
}

export function useMasterBusBroadcastChannel({
  channelName,
  event,
  onPayload,
  enabled = true,
  restartKey = 0,
  private: privateChannel = true,
  onSubscriptionError,
  onSubscriptionStatus,
}: UseMasterBusBroadcastChannelOptions): void {
  const [engineReady, setEngineReady] = useState(false);
  const engineWasReady = useRef(false);
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
    setEngineReady(false);
    engineWasReady.current = false;
    if (
      !enabled ||
      !channelName ||
      event !== 'record_changed' ||
      !privateChannel ||
      !/^(?:member-record:[0-9a-f-]{36}:[0-9a-f-]{36}|club-roster:[0-9a-f-]{36})$/.test(channelName)
    )
      return;
    let alive = true;
    const remove = engineChannelClient.onPrivateRecord(channelName, (message) => {
      if (!alive) return;
      if (message.type === 'PRIVATE_RECORD_STATUS') {
        setEngineReady(message.ready === true);
        if (message.ready === true) {
          engineWasReady.current = true;
          statusCallbackRef.current?.('SUBSCRIBED');
        } else if (engineWasReady.current) {
          // A paid fallback connection is not proof its producer is still on.
          errorCallbackRef.current?.('CHANNEL_ERROR');
        }
      } else callbackRef.current({ payload: {} });
    });
    return () => {
      alive = false;
      remove();
    };
  }, [channelName, event, enabled, privateChannel, restartKey]);

  useEffect(() => {
    if (!enabled || !channelName || engineReady) return;
    let alive = true;
    // MasterBus may replace a dead channel while its previous Supabase
    // subscription is still delivering a late CLOSED/error callback. Reserve
    // ownership when an attempt starts (before async auth), so an older attempt
    // that finishes auth last cannot supersede a newer channel or repaint stale
    // data after recovery.
    let subscriptionGeneration = 0;
    let admission: AbortController | null = null;
    let acquiredChannel: RealtimeChannel | null = null;
    /* Admission reserves a closed registered channel so the existing health
       owner can recover it. Auth/online events also retain the private join's
       event-driven retry, disarmed by SUBSCRIBED. No new timer is involved. */
    let disarmAuthRetry: (() => void) | null = null;

    const subscribeChannel = () => {
      if (!alive) return;
      const generation = ++subscriptionGeneration;
      admission?.abort();
      if (acquiredChannel) masterBus.removeRegisteredChannel(channelName, acquiredChannel);
      acquiredChannel = null;
      admission = new AbortController();
      const signal = admission.signal;
      if (!alive || generation !== subscriptionGeneration) return;
      const channel = masterBus.getOrCreateChannel(channelName, { private: privateChannel });
      acquiredChannel = channel;
      const state = (channel as any)?.state;
      if (state && state !== 'closed' && state !== 'errored') {
        masterBus.removeRegisteredChannel(channelName, channel);
        acquiredChannel = null;
        reportError(
          new Error(`Realtime channel ${channelName} was already ${state}; binding skipped`),
          'useMasterBusBroadcastChannel.channel_already_joined'
        );
        return;
      }

      channel.on('broadcast', { event }, (payload: unknown) => {
        if (alive && generation === subscriptionGeneration) callbackRef.current(payload);
      });
      void subscribeRealtime(
        channel,
        (status: string, err?: Error) => {
          if (!alive || generation !== subscriptionGeneration) return;
          if (status === 'SUBSCRIBED') disarmAuthRetry?.();
          if (status === 'CHANNEL_ERROR') armAuthRetry();
          try {
            if (status !== 'SUBSCRIBED' || !engineWasReady.current)
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
        },
        signal
      );
    };

    const startSubscription = () => {
      void subscribeChannel();
    };

    const armAuthRetry = () => {
      if (disarmAuthRetry) return;
      const retry = () => {
        disarmAuthRetry?.();
        if (alive) startSubscription();
      };
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((authEvent) => {
        if (authEvent === 'TOKEN_REFRESHED' || authEvent === 'SIGNED_IN') retry();
      });
      window.addEventListener('online', retry);
      disarmAuthRetry = () => {
        disarmAuthRetry = null;
        window.removeEventListener('online', retry);
        subscription.unsubscribe();
      };
    };

    masterBus.registerChannelFactory(channelName, startSubscription);
    startSubscription();

    return () => {
      alive = false;
      admission?.abort();
      disarmAuthRetry?.();
      masterBus.removeChannelFactory(channelName);
      if (acquiredChannel) masterBus.removeRegisteredChannel(channelName, acquiredChannel);
    };
  }, [channelName, enabled, event, privateChannel, restartKey, engineReady]);
}

export default useMasterBusBroadcastChannel;
