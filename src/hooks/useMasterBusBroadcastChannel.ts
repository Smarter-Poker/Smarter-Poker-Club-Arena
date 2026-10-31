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
import {
  isRealtimeTopicRefusal,
  isRealtimeTransportLoss,
  noteRealtimeTransportLoss,
  noteRealtimeTransportRecovered,
} from '../lib/realtimeTransportLoss';
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
  // Network callbacks may share a React batch. Retire fallback authority at
  // READY itself, before the effect cleanup gets its turn.
  const engineReadyRef = useRef(false);
  const engineWasReady = useRef(false);
  const engineRecord =
    event === 'record_changed' &&
    privateChannel &&
    !!channelName &&
    /^(?:member-record:[0-9a-f-]{36}:[0-9a-f-]{36}|club-roster:[0-9a-f-]{36})$/.test(channelName);
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
    engineReadyRef.current = false;
    setEngineReady(false);
    engineWasReady.current = false;
    if (!enabled || !channelName || !engineRecord) return;
    let alive = true;
    let generation = 0;
    let degraded = false;
    let remove = () => {};
    let identityAllowsBind = true;
    let engineChannelClient:
      | (typeof import('../services/PrivateRecordTransport'))['privateRecordTransport']
      | null = null;
    const bind = () => {
      const client = engineChannelClient;
      if (!client || !identityAllowsBind) return;
      remove();
      const scope = ++generation;
      degraded = false;
      statusCallbackRef.current?.('CONNECTING');
      const markUnavailable = () => {
        if (!alive || scope !== generation || degraded) return;
        degraded = true;
        errorCallbackRef.current?.('CHANNEL_ERROR');
      };
      remove = client.onPrivateRecord(channelName, (message) => {
        if (!alive || scope !== generation) return;
        if (message.type === 'PRIVATE_RECORD_STATUS') {
          engineReadyRef.current = message.ready === true;
          setEngineReady(message.ready === true);
          if (message.ready === true) {
            degraded = false;
            engineWasReady.current = true;
            statusCallbackRef.current?.('SUBSCRIBED');
          } else {
            const status = client.getStatus();
            // Initial socket/listener startup and identity idle are normal.
            // Explicit listener failure or actual transport loss is unavailable.
            if (
              engineWasReady.current ||
              message.phase === 'unavailable' ||
              ['reconnecting', 'failed', 'auth_failed', 'access_refused'].includes(status)
            )
              markUnavailable();
          }
        } else callbackRef.current({ payload: {} });
      });
      // Joining an already failed/reconnecting singleton need not change status.
      // An existing standby may have acknowledged READY synchronously above.
      // Its topic readiness takes authority over the primary's coarse status.
      if (
        !engineReadyRef.current &&
        ['reconnecting', 'failed', 'auth_failed', 'access_refused'].includes(client.getStatus())
      )
        markUnavailable();
    };
    const stopIdentity = masterBus.subscribe('AUTH_STATE_CHANGED', (change) => {
      identityAllowsBind = change.payload.isAuthenticated;
      const scope = ++generation;
      remove();
      engineReadyRef.current = false;
      setEngineReady(false);
      engineWasReady.current = false;
      statusCallbackRef.current?.('CONNECTING');
      // The canonical identity boundary synchronously retires the old socket's
      // intent. Rebind after that boundary, even A/B/A before React renders.
      if (change.payload.isAuthenticated)
        queueMicrotask(() => {
          if (alive && scope === generation) bind();
        });
    });
    void import('../services/PrivateRecordTransport')
      .then((module) => {
        if (!alive) return;
        engineChannelClient = module.privateRecordTransport;
        bind();
      })
      .catch((error) => {
        if (!alive) return;
        reportError(error, 'useMasterBusBroadcastChannel.private_record_load');
        errorCallbackRef.current?.('CHANNEL_ERROR');
      });
    return () => {
      alive = false;
      generation++;
      stopIdentity();
      remove();
    };
  }, [channelName, event, enabled, privateChannel, restartKey, engineRecord]);

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
    let refusalReported = false;
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
      const channel = masterBus.getOrCreateChannel(channelName, {
        private: privateChannel,
      });
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
        if (
          alive &&
          generation === subscriptionGeneration &&
          !(engineRecord && engineReadyRef.current)
        )
          callbackRef.current(payload);
      });
      void subscribeRealtime(
        channel,
        (status: string, err?: Error) => {
          if (
            !alive ||
            generation !== subscriptionGeneration ||
            (engineRecord && engineReadyRef.current)
          )
            return;
          if (status === 'SUBSCRIBED') {
            disarmAuthRetry?.();
            noteRealtimeTransportRecovered();
            refusalReported = false;
          }
          if (status === 'CHANNEL_ERROR') armAuthRetry();
          try {
            if (status !== 'SUBSCRIBED' || !engineRecord) statusCallbackRef.current?.(status);
          } catch (callbackError) {
            reportError(callbackError, 'useMasterBusBroadcastChannel.onSubscriptionStatus_threw');
          }
          if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') {
            return;
          }
          /* The shared socket dropped, so every channel failed at once with no
             reason: one report per outage, not one per channel. A refused
             private topic repeats on every recovery attempt until the token
             changes: one report per mount, until it joins. Everything else is
             this channel's own failure and is reported as before. The
             consumer's callback below runs in every case. */
          if (isRealtimeTransportLoss(status, err)) {
            noteRealtimeTransportLoss(channelName, `useMasterBusBroadcastChannel.${event}`, err);
          } else if (!(isRealtimeTopicRefusal(err) && refusalReported)) {
            refusalReported = isRealtimeTopicRefusal(err);
            reportError(
              err ?? new Error(`Realtime ${status} on ${channelName}`),
              `useMasterBusBroadcastChannel.${status}.${event}`
            );
          }
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
  }, [channelName, enabled, event, privateChannel, restartKey, engineReady, engineRecord]);
}

export default useMasterBusBroadcastChannel;
