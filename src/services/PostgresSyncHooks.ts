import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { reportError } from '../utils/errorReporter';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * POSTGRES SYNC HOOKS (Phase 7: Absolute Sync Perfection + Phase 11 Optimizations)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Ensures that external agents (Cron Jobs, Stripe Webhooks, Supabase Admin Dashboard,
 * Edge Functions) that mutate the database outside the user's React session still trigger
 * instant UI updates via the MasterBus.
 *
 * Phase 11 enhancements:
 *  - Internal debouncing: batches rapid-fire events (e.g., admin bulk-updating 50 members)
 *  - Health monitoring: logs connection status changes for observability
 *
 * RLS automatically ensures the client only receives data they are authorized to see.
 */
class PostgresSyncHooksService {
  private channel: RealtimeChannel | null = null;
  private initialized: boolean = false;
  private _userId: string | null = null; // FIX: Track current user for re-init detection

  // Phase 11: Internal debounce timers to batch rapid-fire events
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DEBOUNCE_MS = 300;

  // Phase 16: Auto-reconnect on CHANNEL_ERROR / TIMED_OUT
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private static readonly MAX_RETRIES = 5;
  private static readonly BACKOFF_DELAYS = [2000, 4000, 8000, 16000, 30000];

  /**
   * Debounced emit — batches rapid-fire events into a single emission per key.
   * Prevents UI thrashing when external agents modify many rows at once.
   */
  private debouncedEmit<K extends Parameters<typeof masterBus.emit>[0]>(
    key: string,
    eventType: K,
    payload: Parameters<typeof masterBus.emit>[1]
  ): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        masterBus.emit(eventType, payload as any);
        this.debounceTimers.delete(key);
      }, PostgresSyncHooksService.DEBOUNCE_MS)
    );
  }

  init(userId: string) {
    // Guard: If already initialized with a live channel FOR THE SAME USER, skip.
    // FIX: Also track userId to detect user switches (e.g., logout → login as different user)
    if (this.initialized && this.channel && this._userId === userId) return;

    // Clean up any prior stale channel before creating a new one (idempotent)
    this.destroy();

    // FIX: Set initialized BEFORE any async work to prevent re-entrancy
    this.initialized = true;
    this._userId = userId;

    // Use a deterministic global channel name scoped to the user to avoid leaks/re-subs
    this.channel = supabase.channel(`global_db_sync:${userId}`);

    this.channel
      // 1. Wallets (Financial integrity) — NOT debounced (money must be instant)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
        (payload) => {
          console.debug('[PostgresSync] External Wallet mutation detected:', payload);
          masterBus.emit('BALANCE_UPDATED', { source: 'postgres_sync' });
          const w = payload.new as any;
          masterBus.emit('WALLET_REFRESHED', {
            walletType: w.wallet_type || 'PLAYER',
            available: (w.balance || 0) - (w.locked_balance || 0),
            total: w.balance || 0,
          });
        }
      )
      // 2. Profiles (Display names, avatars, diamonds) — NOT debounced (personal data)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => {
          console.debug('[PostgresSync] External Profile mutation detected:', payload);
          masterBus.emit('PROFILE_UPDATED', { userId: payload.new.id, updates: payload.new });

          const newDiamonds = (payload.new as any).diamonds;
          const oldDiamonds = (payload.old as any)?.diamonds;
          if (newDiamonds != null && oldDiamonds != null && newDiamonds !== oldDiamonds) {
            masterBus.emit('DIAMOND_BALANCE_CHANGED', {
              newBalance: newDiamonds,
              delta: newDiamonds - oldDiamonds,
              source: 'postgres_sync',
            });
          }
        }
      )

      // NOTE: Global unfiltered listeners REMOVED to prevent billing waste:
      //   - `tables` + `tournaments` REMOVED 2026-04-18: fired on every mutation globally,
      //     caused ~80% of the 86M realtime messages ($217/mo last cycle).
      //   - `clubs` + `unions` REMOVED 2026-04-19: same global fan-out pattern.
      //     CLUB_UPDATED already emitted by filtered club_members listener below.
      //     Club/union detail pages subscribe directly (page-scoped channel).
      // 7. User Settings — debounced (settings toggle spam protection)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_table_settings',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          console.debug('[PostgresSync] External Settings mutation detected:', payload);
          this.debouncedEmit('settings', 'SETTINGS_UPDATED', { settings: payload.new });
        }
      )
      // 8. Club Memberships — DEBOUNCED (bulk operations protection)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'club_members', filter: `user_id=eq.${userId}` },
        (payload) => {
          console.debug('[PostgresSync] External Membership mutation detected:', payload);
          if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
            const clubId = (payload.new as any)?.club_id;
            if (clubId) {
              this.debouncedEmit(`membership_${clubId}`, 'CLUB_UPDATED', { clubId });
            }
          } else if (payload.eventType === 'DELETE') {
            // With default replica identity, payload.old only has the PK (id),
            // not club_id. Emit immediately — this is a critical access change.
            const clubId = (payload.old as any)?.club_id || 'unknown';
            masterBus.emit('CLUB_LEFT', { clubId });
          }
        }
      )
      // 9. Chip Ledger — REALTIME transaction notifications
      // When a chip_ledger entry is created involving this user (as sender or receiver),
      // emit a TRANSACTION_LOGGED event so wallet/cashier pages can show live updates
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chip_ledger',
          filter: `performed_by=eq.${userId}`,
        },
        (payload) => {
          console.debug('[PostgresSync] New ledger entry (outgoing):', payload);
          masterBus.emit('BALANCE_UPDATED', { source: 'chip_ledger_realtime' });
          (masterBus as any).emit('TRANSACTION_LOGGED', { entry: payload.new, direction: 'out' });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chip_ledger',
          filter: `to_entity_id=eq.${userId}`,
        },
        (payload) => {
          console.debug('[PostgresSync] New ledger entry (incoming):', payload);
          masterBus.emit('BALANCE_UPDATED', { source: 'chip_ledger_realtime' });
          (masterBus as any).emit('TRANSACTION_LOGGED', { entry: payload.new, direction: 'in' });
        }
      )
      // Phase 11: Health monitoring with reconnect logging
      // Phase 15: Emit bus events so ConnectionHUD and other UI elements can react
      // Phase 16: Auto-reconnect on CHANNEL_ERROR / TIMED_OUT
      .subscribe((status, err) => {
        const channelName = `global_db_sync:${userId}`;
        switch (status) {
          case 'SUBSCRIBED':
            console.info(`[PostgresSync] ✅ Realtime Hook Active for user ${userId}.`);
            masterBus.emit('REALTIME_CONNECTED', { channelName });
            this.retryCount = 0; // Reset on success
            break;
          case 'CHANNEL_ERROR':
            console.debug(`[PostgresSync] ❌ Channel error:`, err?.message || err || 'unknown');
            masterBus.emit('REALTIME_DISCONNECTED', {
              channelName,
              reason: `Channel error: ${err?.message || 'unknown'}`,
            });
            this.scheduleReconnect(userId);
            break;
          case 'TIMED_OUT':
            console.warn(`[PostgresSync] ⏱️ Channel timed out — scheduling reconnect.`);
            masterBus.emit('REALTIME_DISCONNECTED', {
              channelName,
              reason: 'Connection timed out',
            });
            this.scheduleReconnect(userId);
            break;
          case 'CLOSED':
            console.info(`[PostgresSync] Channel closed for user ${userId}.`);
            masterBus.emit('REALTIME_DISCONNECTED', { channelName, reason: 'Channel closed' });
            break;
        }
      });
  }

  /**
   * Phase 16: Exponential backoff reconnect.
   * Tears down the dead channel and re-inits after a delay.
   */
  private scheduleReconnect(userId: string): void {
    if (this.retryCount >= PostgresSyncHooksService.MAX_RETRIES) {
      console.warn(
        `[PostgresSync] Max retries (${PostgresSyncHooksService.MAX_RETRIES}) reached — ` +
          `will rely on MasterBus health monitor or IdentityDNA token refresh for recovery.`
      );
      return;
    }

    const delay =
      PostgresSyncHooksService.BACKOFF_DELAYS[
        Math.min(this.retryCount, PostgresSyncHooksService.BACKOFF_DELAYS.length - 1)
      ];
    this.retryCount++;

    console.info(
      `[PostgresSync] Reconnect attempt ${this.retryCount}/${PostgresSyncHooksService.MAX_RETRIES} in ${delay}ms`
    );

    // Clear any pending reconnect timer
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Tear down the dead channel, reset initialized flag, and re-init
      if (this.channel) {
        this.channel.unsubscribe();
        supabase.removeChannel(this.channel);
        this.channel = null;
      }
      this.initialized = false;
      // Preserve _userId and retryCount across reconnect
      this.init(userId);
    }, delay);
  }

  destroy() {
    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.channel) {
      this.channel.unsubscribe();
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
    // Clear any pending debounce timers to prevent orphaned emissions
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();
    this.initialized = false;
    this._userId = null;
    this.retryCount = 0;
  }
}

export const postgresSyncHooks = new PostgresSyncHooksService();
