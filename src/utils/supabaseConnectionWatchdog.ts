/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SUPABASE CONNECTION WATCHDOG — Aggressive auto-reconnect (NEVER show Offline)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * DESIGN PRINCIPLE: Users should NEVER see a disconnected state. The watchdog
 * silently detects and recovers from connection drops. The ConnectionIndicator
 * only shows "Reconnecting..." after 60+ seconds of sustained failure.
 *
 * Recovery strategy:
 * 1. Periodic health checks (every 30s) with aggressive retry on failure
 * 2. When a failure is detected, immediately retry at 5s, 10s, 20s intervals
 * 3. Force-reconnect all Supabase realtime channels on recovery
 * 4. Replay offline mutation queue on recovery
 * 5. Configurable initial delay for auth session establishment
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { OfflineQueueService } from '../services/OfflineQueueService';
import { reportError } from './errorReporter';

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds (was 45s — more frequent now)
const PING_TIMEOUT = 8_000; // 8 seconds max for health check
const MAX_CONSECUTIVE_FAILURES = 5; // Require 5 failures before declaring disconnect (was 3)
const FAST_RETRY_INTERVALS = [5_000, 10_000, 20_000]; // Aggressive retry on failure

class SupabaseConnectionWatchdog {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineCheckTimer: ReturnType<typeof setTimeout> | null = null; // FIX: Track handleOnline timer
  private consecutiveFailures = 0;
  private isConnected = true;
  private started = false;

  /**
   * Start the watchdog. Call once from App.tsx useEffect.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Listen for browser online/offline events
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);

    // Start periodic health checks
    this.heartbeatTimer = setInterval(() => this.checkHealth(), HEARTBEAT_INTERVAL);

    // Initial check: wait for connection to stabilize
    const initialDelay = 8_000;
    setTimeout(() => this.checkHealth(), initialDelay);
  }

  /**
   * Stop the watchdog. Call on cleanup.
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // FIX: Clear the handleOnline timer to prevent fire-after-stop
    if (this.onlineCheckTimer) {
      clearTimeout(this.onlineCheckTimer);
      this.onlineCheckTimer = null;
    }
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    this.started = false;
  }

  /** Check Supabase connectivity through GoTrue's successful health route. */
  private async checkHealth(): Promise<void> {
    if (!navigator.onLine) {
      this.markFailure();
      // Don't give up — schedule aggressive retry
      this.scheduleRetry();
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT);

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`, {
        method: 'GET',
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      // GoTrue's authenticated health route returns a quiet 2xx response. The
      // former bare PostgREST-root probe returned 401 by design, which made
      // every healthy page emit a failed-resource console error after eight
      // seconds and falsely failed production certification.
      if (response.ok) {
        this.markConnected();
      } else {
        this.markFailure();
        this.scheduleRetry();
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn('[Watchdog] Health check timed out - retrying');
      }
      this.markFailure();
      this.scheduleRetry();
    }
  }

  /**
   * Schedule an aggressive retry after a failure.
   * Uses escalating intervals: 5s, 10s, 20s, then falls back to normal heartbeat.
   */
  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);

    const retryIndex = Math.min(this.consecutiveFailures - 1, FAST_RETRY_INTERVALS.length - 1);
    if (retryIndex < 0) return; // No failures yet

    const delay = FAST_RETRY_INTERVALS[retryIndex] || HEARTBEAT_INTERVAL;
    this.retryTimer = setTimeout(() => this.checkHealth(), delay);
  }

  private markConnected(): void {
    const wasDisconnected = !this.isConnected;
    this.isConnected = true;
    this.consecutiveFailures = 0;

    // Cancel any pending retries
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (wasDisconnected) {
      console.debug('[Watchdog] Supabase connection restored');
      masterBus.emit('WS_CONNECTED', { url: import.meta.env.VITE_SUPABASE_URL || '' });
      masterBus.emit('REALTIME_CONNECTED', { channelName: 'watchdog' });
      masterBus.emit('CONNECTION_RESTORED', { timestamp: Date.now() });

      // Force realtime channels to reconnect
      this.reconnectRealtimeChannels();

      // Replay offline queue
      OfflineQueueService.replayQueue().catch((err) => {
        console.warn('[Watchdog] Offline queue replay failed:', err);
      });
    }
  }

  private markDisconnected(): void {
    if (this.isConnected) {
      console.warn('[Watchdog] Supabase connection lost (after repeated failures)');
      this.isConnected = false;
      masterBus.emit('WS_DISCONNECTED', { url: import.meta.env.VITE_SUPABASE_URL || '' });
      masterBus.emit('REALTIME_DISCONNECTED', {
        channelName: 'watchdog',
        reason: 'Connection lost',
      });
    }
  }

  private markFailure(): void {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Only mark disconnected after 5 consecutive failures (~2.5 minutes)
      this.markDisconnected();
    }
    // Note: We do NOT emit WS_RECONNECTING for transient failures.
    // The user should never see any indication of connection issues
    // for normal blips. The aggressive retry handles recovery silently.
  }

  /**
   * Force Supabase realtime to reconnect all channels.
   */
  private reconnectRealtimeChannels(): void {
    try {
      const channels = supabase.getChannels();
      if (channels.length > 0) {
        console.debug(`[Watchdog] Reconnecting ${channels.length} realtime channels...`);
        channels.forEach((channel) => {
          const state = (channel as any).state;
          if (state === 'closed' || state === 'errored') {
            try {
              channel.subscribe((status: string, err?: Error) => {
                if (status === 'CHANNEL_ERROR') {
                  if (err)
                    reportError(
                      err?.message || err,
                      'supabaseConnectionWatchdog._Channel_resubscribe_error'
                    );
                }
                if (status === 'TIMED_OUT') {
                  console.warn('[Watchdog] Channel re-subscribe timed out');
                }
              });
            } catch (err: unknown) {
              console.warn('[Watchdog] Channel re-subscribe failed:', err);
            }
          }
        });
      }
    } catch (err) {
      reportError(err, 'supabaseConnectionWatchdog.Failed_to_reconnect_channels');
    }
  }

  private handleOnline = (): void => {
    console.debug('[Watchdog] Browser went online - checking health');
    // FIX: Store timer ID so stop() can clear it. Previously this timer
    // was fire-and-forget and could fire after stop() was called.
    if (this.onlineCheckTimer) clearTimeout(this.onlineCheckTimer);
    this.onlineCheckTimer = setTimeout(() => {
      this.onlineCheckTimer = null;
      this.checkHealth();
    }, 500);
  };

  private handleOffline = (): void => {
    console.debug('[Watchdog] Browser went offline');
    // Don't immediately show disconnected — just increment failure and retry
    this.markFailure();
    // Schedule aggressive retry — browser may come back online quickly
    this.scheduleRetry();
  };

  getStatus(): { connected: boolean; consecutiveFailures: number; started: boolean } {
    return {
      connected: this.isConnected,
      consecutiveFailures: this.consecutiveFailures,
      started: this.started,
    };
  }
}

export const supabaseConnectionWatchdog = new SupabaseConnectionWatchdog();
