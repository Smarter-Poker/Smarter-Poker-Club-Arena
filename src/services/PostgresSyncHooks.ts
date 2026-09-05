import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import type { RealtimeChannel } from '@supabase/supabase-js';

const USER_TABLE_SETTING_COLUMNS = [
  'highlight_active_players',
  'show_avatars',
  'show_badges',
  'cards_pre_sort',
  'gestures_enabled',
  'card_slide',
  'card_squeeze',
  'show_stack_in_bb',
  'auto_time_bank',
  'enhanced_view',
  'voice_message',
  'text_message',
  'emoji_enabled',
  'blue_buttons_enabled',
  'skip_animations',
  'use_alias',
  'table_alias',
  'multi_auto_switch',
  'multi_action_queue',
  'multi_desktop_alerts',
  'multi_shared_socket',
  'rabbit_hunt_button',
  'show_ticker',
  /* The Table Settings panel's own keys, moved onto this row 2026-08-28 (Dan:
     "THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL PAGES").
     Listing them here is what makes a change on one device arrive on another:
     the subscription below only relays columns named in this array, and
     useTableSettings translates the column back to its camelCase key. */
  'sound_enabled',
  'sound_volume',
  'haptic_enabled',
  'animation_speed',
  'color_theme',
  'four_color_deck',
  'show_pot_odds',
  'show_bet_size_presets',
  'auto_muck',
  'auto_muck_explicit',
  'auto_muck_winners',
  'auto_post_blinds',
  'confirm_all_in',
  'card_back',
] as const;

const THEME_SETTING_COLUMNS = [
  'theme_id',
  'table_id',
  'button_id',
  'background_id',
  'cards_id',
] as const;

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
      // 1. WALLETS — restored here 2026-08-24, GLOBAL and USER-FILTERED.
      //
      // It was moved out to useRealtimeFinancials on 2026-04-19, and that hook
      // is mounted on exactly two pages (PlayerWalletPage, CashierPage). So for
      // the whole rest of the app - Home, the lobby, and every table - a balance
      // changed SERVER-SIDE (agent transfer, admin credit, settlement payout,
      // rakeback) produced no client update at all. The header simply showed a
      // stale number until something unrelated happened to trigger a refetch.
      // useGlobalBalanceSync's comment even asserted this listener lived here;
      // it did not, so the balance was quietly less live than the code claimed.
      //
      // This is NOT a return to the listeners removed for billing in April.
      // Those were UNFILTERED, table-wide subscriptions (`tables`, `tournaments`,
      // `clubs`) that fanned every row change on the platform out to every
      // client - ~80% of 86M realtime messages. This one carries
      // `user_id=eq.<userId>`, so it delivers only this player's own wallet
      // rows, exactly like the `profiles` and `club_members` listeners already
      // in this channel.
      //
      // It emits BALANCE_UPDATED rather than pushing a number: useGlobalBalanceSync
      // (mounted in App.tsx) already subscribes to that event debounced and
      // refetches the authoritative balance, so bursts collapse into one read.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') return;
          this.debouncedEmit('wallet_balance', 'BALANCE_UPDATED', {
            source: 'postgres_sync_wallets',
            userId,
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

          // SettingsPage persists Club Arena light/dark mode in profiles.settings.
          // Re-broadcast its effective value so a second device changes mode
          // without a reload; MasterBus handles same-browser tabs immediately.
          const profileSettings = (payload.new as Record<string, unknown>)?.settings;
          const savedTheme =
            profileSettings && typeof profileSettings === 'object'
              ? (profileSettings as Record<string, unknown>).theme
              : undefined;
          if (savedTheme === 'light' || savedTheme === 'dark') {
            masterBus.emit('UI_THEME_CHANGED', { key: 'theme', value: savedTheme, userId });
          }

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
      // 7. User table settings — INSERT and UPDATE, applied field-by-field.
      // The prior SETTINGS_UPDATED payload had no consumer for these snake-
      // case keys, so another device's toggles never reached an open table.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_table_settings',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          console.debug('[PostgresSync] External Settings mutation detected:', payload);
          if (payload.eventType === 'DELETE') return;
          const next = payload.new as Record<string, unknown>;
          const previous = (payload.old || {}) as Record<string, unknown>;
          for (const setting of USER_TABLE_SETTING_COLUMNS) {
            const value = next[setting];
            if (
              (typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean') &&
              (payload.eventType === 'INSERT' || value !== previous[setting])
            ) {
              masterBus.emit('SETTINGS_CHANGED', {
                setting,
                value,
                userId,
                origin: 'postgres-sync:user-table-settings',
              });
            }
          }
          this.debouncedEmit('settings', 'SETTINGS_UPDATED', { settings: payload.new });
        }
      )
      // 8. Table artwork — account-scoped, cross-device, no polling. The
      // picker already emits optimistically; this is the durable database echo
      // for changes made in another browser or device.
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'user_theme_settings',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const value: Record<string, string> = {};
          for (const field of THEME_SETTING_COLUMNS) {
            if (typeof row[field] === 'string' && row[field]) value[field] = row[field] as string;
          }
          if (Object.keys(value).length) {
            masterBus.emit('UI_THEME_CHANGED', {
              key: typeof row.game_type === 'string' ? row.game_type : 'ALL',
              value,
              userId,
              updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined,
            });
            if (value.cards_id) {
              masterBus.emit('SETTINGS_CHANGED', {
                setting: 'cardBack',
                value: value.cards_id,
                userId,
                origin: 'postgres-sync:user-theme-settings',
              });
            }
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_theme_settings',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const previous = (payload.old || {}) as Record<string, unknown>;
          const value: Record<string, string> = {};
          for (const field of THEME_SETTING_COLUMNS) {
            if (typeof row[field] === 'string' && row[field] && row[field] !== previous[field]) {
              value[field] = row[field] as string;
            }
          }
          if (Object.keys(value).length) {
            masterBus.emit('UI_THEME_CHANGED', {
              key: typeof row.game_type === 'string' ? row.game_type : 'ALL',
              value,
              userId,
              updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined,
            });
            if (value.cards_id) {
              masterBus.emit('SETTINGS_CHANGED', {
                setting: 'cardBack',
                value: value.cards_id,
                userId,
                origin: 'postgres-sync:user-theme-settings',
              });
            }
          }
        }
      )
      // 9. Club Memberships — DEBOUNCED (bulk operations protection)
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
      // Recipient-filtered authorization invalidations. These remain readable
      // after a role is revoked, allowing an already-open management screen or
      // hamburger drawer to fail closed without waiting for navigation.
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'game_management_events',
          filter: `recipient_id=eq.${userId}`,
        },
        (payload) => {
          const row = (payload.new || {}) as Record<string, unknown>;
          if (row.event_type !== 'management_access_changed') return;
          masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
            scope: row.scope_kind === 'union' ? 'union' : 'club',
            scopeId: typeof row.scope_id === 'string' ? row.scope_id : undefined,
            clubId: typeof row.club_id === 'string' ? row.club_id : undefined,
            userId,
          });
        }
      )
      // 9. Chip Ledger — REALTIME transaction notifications
      // NOTE: chip_ledger listeners REMOVED to scoped hook useRealtimeFinancials (2026-04-19)

      // Phase 11: Health monitoring with reconnect logging
      // Phase 15: Emit bus events so ConnectionHUD and other UI elements can react
      // Phase 16: Auto-reconnect on CHANNEL_ERROR / TIMED_OUT
      .subscribe((status, err) => {
        const channelName = `global_db_sync:${userId}`;
        switch (status) {
          case 'SUBSCRIBED':
            console.info(`[PostgresSync] Realtime Hook Active for user ${userId}.`);
            masterBus.emit('REALTIME_CONNECTED', { channelName });
            this.retryCount = 0; // Reset on success
            break;
          case 'CHANNEL_ERROR':
            console.debug(`[PostgresSync] Channel error:`, err?.message || err || 'unknown');
            masterBus.emit('REALTIME_DISCONNECTED', {
              channelName,
              reason: `Channel error: ${err?.message || 'unknown'}`,
            });
            this.scheduleReconnect(userId);
            break;
          case 'TIMED_OUT':
            console.warn(`[PostgresSync] Channel timed out - scheduling reconnect.`);
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
        `[PostgresSync] Max retries (${PostgresSyncHooksService.MAX_RETRIES}) reached - ` +
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
