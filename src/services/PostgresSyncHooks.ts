import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { decideFieldEcho, acceptNonEmptyString, type EchoFields } from './realtimeFieldEcho';

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
  'all_in_squeeze',
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

/* The five columns the table-artwork mirror carries. The changed-field
   decision itself lives in ./realtimeFieldEcho: `payload.old` on this table is
   the primary key alone, and the comparison that used to need it has to be
   provable on its own. */
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
  private generation = 0;
  private lastSeenMemberships = new Map<string, { balances: string; membership: string }>();

  // Phase 11: Internal debounce timers to batch rapid-fire events
  /* What this client last saw for each mirrored row, keyed by primary key.
     `payload.old` carries the primary key and nothing else on both of these
     tables, so the previous values have to be remembered here or not known at
     all. Cleared on teardown with everything else — a fresh subscription is a
     fresh first sighting, which correctly re-sends a row it has not seen. */
  private lastSeenThemeFields = new Map<string, EchoFields>();
  private lastSeenTableSettings = new Map<string, EchoFields>();

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
    const generation = this.generation;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        if (this.initialized && generation === this.generation) {
          masterBus.emit(eventType, payload as any);
        }
        this.debounceTimers.delete(key);
      }, PostgresSyncHooksService.DEBOUNCE_MS)
    );
  }

  init(userId: string, reconnectAttempt = 0) {
    // Guard: If already initialized with a live channel FOR THE SAME USER, skip.
    // FIX: Also track userId to detect user switches (e.g., logout → login as different user)
    if (this.initialized && this.channel && this._userId === userId) return;

    // Clean up any prior stale channel before creating a new one (idempotent)
    this.destroy();

    // FIX: Set initialized BEFORE any async work to prevent re-entrancy
    this.initialized = true;
    this._userId = userId;
    this.retryCount = reconnectAttempt;
    const generation = this.generation;
    const ownsSubscription = () =>
      this.initialized && this.generation === generation && this._userId === userId;

    // Use a deterministic global channel name scoped to the user to avoid leaks/re-subs
    this.channel = supabase.channel(`global_db_sync:${userId}`);

    this.channel
      // Profiles intentionally stay outside row replication. Appearance and
      // own-account domains use their bounded private app-level carriers.
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
          if (!ownsSubscription()) return;
          console.debug('[PostgresSync] External Settings mutation detected:', payload);
          if (payload.eventType === 'DELETE') return;
          const next = payload.new as Record<string, unknown>;
          /* `payload.old` used to be the comparison here, and it is the primary
             key alone — REPLICA IDENTITY FULL does not change that while RLS is
             on. So every one of the FORTY-EIGHT mirrored columns read as
             changed on every update, and one toggle became forty-eight
             SETTINGS_CHANGED events. useDeckStyle invalidates its cache on any
             of them. Compare against what this client last saw instead. */
          const rowKey = typeof next.user_id === 'string' && next.user_id ? next.user_id : userId;
          const { changed, seed } = decideFieldEcho({
            row: next,
            columns: USER_TABLE_SETTING_COLUMNS,
            remembered:
              payload.eventType === 'INSERT' ? undefined : this.lastSeenTableSettings.get(rowKey),
          });
          this.lastSeenTableSettings.set(rowKey, seed);
          for (const [setting, value] of Object.entries(changed)) {
            masterBus.emit('SETTINGS_CHANGED', {
              setting,
              value,
              userId,
              origin: 'postgres-sync:user-table-settings',
            });
          }
          /* Only when something actually moved. This used to run on every
             update, so a bare updated_at touch rebuilt the whole settings
             object for every listener. */
          if (Object.keys(changed).length) {
            this.debouncedEmit('settings', 'SETTINGS_UPDATED', { settings: payload.new });
          }
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
          if (!ownsSubscription()) return;
          const row = payload.new as Record<string, unknown>;
          /* An INSERT is always a first sighting, so `remembered` is undefined
             and every field comes back as news — which is what this handler
             did before, and is right: a row appearing is a change. */
          const { changed: value, seed } = decideFieldEcho({
            row,
            columns: THEME_SETTING_COLUMNS,
            accept: acceptNonEmptyString,
            remembered: undefined,
          });
          if (typeof row.id === 'string' && row.id) this.lastSeenThemeFields.set(row.id, seed);
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
          if (!ownsSubscription()) return;
          const row = payload.new as Record<string, unknown>;
          /* `payload.old` used to be the comparison here. It is the primary key
             and nothing else on this table (REPLICA IDENTITY DEFAULT), so every
             field read as changed on every update: a felt change dropped the
             deck cache and re-rendered every card on the table. Compare against
             what this client last saw instead — it knows that for certain. */
          const rowId = typeof row.id === 'string' && row.id ? row.id : null;
          const { changed: value, seed } = decideFieldEcho({
            row,
            columns: THEME_SETTING_COLUMNS,
            accept: acceptNonEmptyString,
            remembered: rowId ? this.lastSeenThemeFields.get(rowId) : undefined,
          });
          if (rowId) this.lastSeenThemeFields.set(rowId, seed);
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
          if (!ownsSubscription()) return;
          // The live pools are club_members, not the retired wallets table.
          // Reuse this existing own-user stream; do not publish a hot table or
          // add a channel. Compare the latest complete row with our own baseline,
          // because an RLS old row carries only the composite primary key.
          const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as Record<
            string,
            unknown
          >;
          if (row?.user_id !== userId || typeof row.club_id !== 'string' || !row.club_id) return;
          const clubId = row.club_id;
          if (payload.eventType === 'DELETE') {
            // DELETE is unfilterable. The actual PK is (club_id,user_id), so
            // only this account's deletion may invalidate its access/balance.
            this.lastSeenMemberships.delete(clubId);
            masterBus.emit('CLUB_LEFT', { clubId });
            this.debouncedEmit('wallet_balance', 'BALANCE_UPDATED', {
              source: 'postgres_sync_membership',
              userId,
            });
            return;
          }
          const next = {
            balances: JSON.stringify([row.chip_balance, row.promo_balance, row.locked_chips]),
            membership: JSON.stringify([
              row.role,
              row.status,
              row.is_active,
              row.agent_id,
              row.parent_agent_id,
              row.membership_lifecycle_status,
              row.departed_at,
              row.nickname,
              row.display_name,
              row.credit_limit,
              row.credit_used,
              row.commission_rate,
              row.rakeback_rate,
            ]),
          };
          const previous = this.lastSeenMemberships.get(clubId);
          this.lastSeenMemberships.set(clubId, next);
          if (!previous || previous.balances !== next.balances) {
            this.debouncedEmit('wallet_balance', 'BALANCE_UPDATED', {
              source: 'postgres_sync_membership',
              userId,
            });
          }
          if (!previous || previous.membership !== next.membership) {
            this.debouncedEmit(`membership_${clubId}`, 'CLUB_UPDATED', { clubId });
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
          if (!ownsSubscription()) return;
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
        if (!ownsSubscription()) return;
        const channelName = `global_db_sync:${userId}`;
        switch (status) {
          case 'SUBSCRIBED':
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            this.lastSeenMemberships.clear();
            this.debouncedEmit('wallet_balance', 'BALANCE_UPDATED', {
              source: 'postgres_sync_connected',
              userId,
            });
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
      // init tears down the old owner. Preserve the bounded attempt count
      // across that teardown; only SUBSCRIBED or an actual new owner resets it.
      this.init(userId, this.retryCount);
    }, delay);
  }

  destroy() {
    this.generation++;
    this.lastSeenMemberships.clear();
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
    /* Forget the theme baseline too. The next subscription is a first sighting
       and SHOULD re-send the row: this client may have been away while it
       changed, and a stale baseline would suppress the catch-up. */
    this.lastSeenThemeFields.clear();
    this.lastSeenTableSettings.clear();
    this.initialized = false;
    this._userId = null;
    this.retryCount = 0;
  }
}

export const postgresSyncHooks = new PostgresSyncHooksService();
