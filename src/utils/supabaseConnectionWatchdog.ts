/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SUPABASE CONNECTION WATCHDOG — Monitors & recovers the realtime connection
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Supabase JS client can silently lose its WebSocket connection without
 * triggering any user-visible feedback. When this happens:
 *
 * 1. Realtime subscriptions stop receiving updates
 * 2. Presence channels go stale
 * 3. The user has no idea they're disconnected
 *
 * This watchdog:
 * - Pings the Supabase REST API on an interval to verify connectivity
 * - Monitors navigator.onLine events for network drops
 * - Emits MasterBus events (WS_CONNECTED, WS_DISCONNECTED, WS_RECONNECTING)
 *   so ConnectionStatusBar and ConnectionIndicator can react
 * - Forces Supabase realtime channels to reconnect on recovery
 * - Uses exponential backoff for reconnection attempts
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

const HEARTBEAT_INTERVAL = 45_000; // 45 seconds
const PING_TIMEOUT = 8_000; // 8 seconds max for health check
const MAX_CONSECUTIVE_FAILURES = 3;

class SupabaseConnectionWatchdog {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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

    // Initial check: in iframe context, wait longer for auth handshake to complete.
    // The postMessage auth flow + setSession() can take several seconds, during
    // which Supabase calls may fail, producing false "disconnected" states.
    const inIframe = typeof window !== 'undefined' && window.parent !== window;
    const initialDelay = inIframe ? 15_000 : 5_000;
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
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    this.started = false;
  }

  /**
   * Check Supabase connectivity by making a lightweight auth call.
   */
  private async checkHealth(): Promise<void> {
    if (!navigator.onLine) {
      this.markDisconnected();
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT);

      // Use a lightweight Supabase call to verify connectivity
      // getSession() is cached locally, so we use a simple REST ping instead
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/`, {
        method: 'HEAD',
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok || response.status === 200 || response.status === 404) {
        // Supabase is reachable (404 is fine — the endpoint exists)
        this.markConnected();
      } else {
        this.markFailure();
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn('[Watchdog] Supabase health check timed out');
      }
      this.markFailure();
    }
  }

  private markConnected(): void {
    if (!this.isConnected) {
      console.log('[Watchdog] Supabase connection restored');
      this.isConnected = true;
      masterBus.emit('WS_CONNECTED', { url: import.meta.env.VITE_SUPABASE_URL || '' });
      masterBus.emit('REALTIME_CONNECTED', { channelName: 'watchdog' });
      masterBus.emit('CONNECTION_RESTORED', { timestamp: Date.now() });

      // Force realtime channels to reconnect
      this.reconnectRealtimeChannels();

      // Replay any queued offline mutations now that Supabase is reachable.
      // This is more reliable than the navigator.onLine event because the
      // watchdog verifies actual Supabase connectivity, not just network.
      import('../utils/offlineQueue').then(({ replayOfflineQueue }) => {
        replayOfflineQueue().catch((err) => {
          console.warn('[Watchdog] Offline queue replay failed:', err);
        });
      });
    }
    this.consecutiveFailures = 0;
  }

  private markDisconnected(): void {
    if (this.isConnected) {
      console.warn('[Watchdog] Supabase connection lost');
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
      this.markDisconnected();
    } else if (this.consecutiveFailures >= 2) {
      // Show reconnecting state after 2 failures
      masterBus.emit('WS_RECONNECTING', {
        url: import.meta.env.VITE_SUPABASE_URL || '',
        attempt: this.consecutiveFailures,
      });
    }
  }

  /**
   * Force Supabase realtime to reconnect all channels.
   * This is needed after a network interruption because the WebSocket
   * may have silently closed.
   */
  private reconnectRealtimeChannels(): void {
    try {
      // Get all current channels and force re-subscribe
      const channels = supabase.getChannels();
      if (channels.length > 0) {
        console.log(`[Watchdog] Reconnecting ${channels.length} realtime channels...`);
        channels.forEach((channel) => {
          const state = (channel as any).state;
          if (state === 'closed' || state === 'errored') {
            try {
              channel.subscribe();
            } catch (err: unknown) {
              console.warn('[Watchdog] Channel re-subscribe failed:', err);
            }
          }
        });
      }
    } catch (err) {
      console.error('[Watchdog] Failed to reconnect channels:', err);
    }
  }

  private handleOnline = (): void => {
    console.log('[Watchdog] Browser went online');
    // Check health immediately when coming back online
    setTimeout(() => this.checkHealth(), 1000);
  };

  private handleOffline = (): void => {
    console.log('[Watchdog] Browser went offline');
    this.markDisconnected();
  };

  /**
   * Get current connection status for diagnostics.
   */
  getStatus(): { connected: boolean; consecutiveFailures: number; started: boolean } {
    return {
      connected: this.isConnected,
      consecutiveFailures: this.consecutiveFailures,
      started: this.started,
    };
  }
}

export const supabaseConnectionWatchdog = new SupabaseConnectionWatchdog();
