/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useUserTableSettings — Bible V8 §11.1 User Table Settings Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Central hook for reading/writing user table preferences.
 * Data flow:
 *   1. On mount → read from Supabase `user_table_settings` (keyed by user_id)
 *   2. Fallback → localStorage cache if Supabase fails
 *   3. On toggle → optimistic update + upsert to Supabase + broadcast via MasterBus
 *   4. Cross-component sync via MasterBus SETTINGS_CHANGED events
 *
 * Used in TWO locations (Bible V8 §11.1):
 *   - Table gear icon → TableSettingsPanel
 *   - Hamburger menu → Settings section
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { STORAGE_KEYS } from '../lib/storage';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — matches Bible V8 §11.1.1 exactly
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserTableSettings {
  highlight_active_players: boolean;
  show_avatars: boolean;
  show_badges: boolean;
  cards_pre_sort: boolean;
  gestures_enabled: boolean;
  card_slide: boolean;
  /**
   * Card Squeeze (competitor-parity 2026-08-19, GG-style marquee feature):
   * hero hole cards are dealt FACE DOWN; drag upward on them to bend/peel
   * them open like a live squeeze. Tap bounces a gesture hint. Auto-reveals
   * at showdown / when the hero is all-in so the hero never sees less than
   * the table does.
   */
  card_squeeze: boolean;
  show_stack_in_bb: boolean;
  auto_time_bank: boolean;
  enhanced_view: boolean;
  voice_message: boolean;
  text_message: boolean;
  emoji_enabled: boolean;
  blue_buttons_enabled: boolean;
  /** FIX 173: Bible V8 §10.3 — Skip animations option for speed players */
  skip_animations: boolean;
  /** Use club alias instead of smarter.poker display name */
  use_alias: boolean;
  /** Custom club alias text — shown at table when use_alias is true */
  table_alias: string;
  /** Multi-table (roadmap batch 2): jump to a table when its turn clock is
   *  nearly out. Some grinders hate being yanked mid-read — their call. */
  multi_auto_switch: boolean;
  /** Multi-table (roadmap batch 2): after acting, advance to the next table
   *  already waiting on you (GG-style action queue). */
  multi_action_queue: boolean;
  /** Desktop alerts (2026-08-21): browser Notification when a table needs
   *  you while the browser tab is hidden. Enabling this is the user gesture
   *  that requests Notification permission - the app never prompts on its
   *  own. */
  multi_desktop_alerts: boolean;
  /** BETA (2026-08-21): all tables share ONE engine socket (/ws/multi)
   *  instead of one socket per table. Mirrors to the ca_ws_mux localStorage
   *  flag that EngineStateClient reads at (re)connect time. */
  multi_shared_socket: boolean;
}

export const DEFAULT_USER_TABLE_SETTINGS: UserTableSettings = {
  highlight_active_players: true,
  show_avatars: true,
  show_badges: false,
  cards_pre_sort: true,
  gestures_enabled: false,
  card_slide: true,
  card_squeeze: false,
  show_stack_in_bb: false,
  auto_time_bank: false,
  enhanced_view: true,
  voice_message: true,
  text_message: true,
  emoji_enabled: true,
  blue_buttons_enabled: false,
  skip_animations: false,
  use_alias: false,
  table_alias: '',
  // DEAD under the NO AUTO TABLE SWITCHING law (Dan 2026-08-28) — kept only
  // so the pinned client-default/DB-default equality holds and existing rows
  // parse. No code reads these; none may again.
  multi_auto_switch: true,
  multi_action_queue: true,
  // ── THESE TWO MUST MATCH THE DATABASE ──
  //
  // TableSettingsPanel renders every toggle straight from this object until
  // the user's row loads, and the save path is a per-key upsert — so a client
  // default that disagrees with the column default both lies to the user AND
  // silently flips their other settings on first save (full history in
  // tests/user-table-settings-defaults.test.ts). The database is the source
  // of truth; change it in a migration FIRST, then here.
  //
  // multi_desktop_alerts stays false: Notification permission is only ever
  // requested by the toggle tap, so an alerts switch must never start ON.
  multi_desktop_alerts: false,
  // 2026-08-24 (Dan, binding): shared socket promoted from opt-in beta to the
  // DEFAULT transport. Per-join TLS handshakes (300-600ms) were plaguing
  // every table join globally; the /ws/multi server path shipped 2026-08-21
  // with unit coverage on both sides. DB default flipped to true in migration
  // 20260824_shared_socket_default_on.sql (applied to production the same
  // day). The toggle remains the kill switch: turning it OFF writes
  // ca_ws_mux='0' and EngineStateClient falls back to per-table sockets.
  multi_shared_socket: true,
};

// Metadata for rendering toggles
export interface SettingMeta {
  key: keyof UserTableSettings;
  label: string;
  description: string;
}

// Only list a setting here if flipping it changes what the player sees.
// TABLE_SETTINGS_META drives the toggle list in TableSettingsPanel, so an entry
// with no consumer is a switch that persists to the database and does nothing —
// the player flips it, sees no change, and concludes the table is broken.
//
// Deliberately NOT listed:
//   highlight_active_players — the acting-seat spotlight is unconditional by
//     product decision (2026-08-15: "must always be ON AT ALL TIMES"), so
//     TablePage stopped reading this column. Keeping the switch on screen
//     advertised control that no longer existed.
//   voice_message — there is no voice chat at a poker table in this codebase.
//     Its only consumer muted the TEXT chat, so "Voice Message: off" silently
//     took away text chat instead. List it again when voice actually ships.
//
// Both columns stay in UserTableSettings and in the database: the rows already
// exist, and removing the toggle must not drop a player's stored value.
export const TABLE_SETTINGS_META: SettingMeta[] = [
  {
    key: 'show_avatars',
    label: 'Show Avatars',
    description: 'Display Player Avatar Images At Seats',
  },
  {
    key: 'show_badges',
    label: 'Show Badges',
    description: 'Display VIP/Achievement Badges At Seats',
  },
  {
    key: 'cards_pre_sort',
    label: 'Cards Pre-Sort',
    description: 'Auto-Sort Hole Cards By Rank (High To Low)',
  },
  {
    key: 'gestures_enabled',
    label: 'Gestures',
    description: 'Enable Swipe/Drag Gesture Controls For Actions',
  },
  {
    key: 'card_slide',
    label: 'Card Slide',
    description: 'Enable Card Peek/Slide Reveal Animation',
  },
  {
    key: 'card_squeeze',
    label: 'Card Squeeze',
    description: 'Deal Your Cards Face Down - Drag Up To Squeeze Them Open Like A Live Game',
  },
  {
    key: 'show_stack_in_bb',
    label: 'Show Stack In Big Blinds',
    description: 'Display Chip Stacks As BB Count Instead Of Chip Value',
  },
  {
    key: 'auto_time_bank',
    label: 'Auto Time Bank',
    description: 'Auto-Activate Time Bank When Primary Timer Expires',
  },
  {
    key: 'enhanced_view',
    label: 'Enhanced View',
    description: 'Enable Enhanced Visual Effects And Animations',
  },
  {
    key: 'text_message',
    label: 'Text Messages',
    description: 'Enable Text Chat At Table',
  },
  {
    key: 'emoji_enabled',
    label: 'Emoji Reactions',
    description: 'Enable Emoji Reactions And Throwables',
  },
  {
    key: 'blue_buttons_enabled',
    label: 'Blue Table Buttons',
    description: 'Use the Blue metallic style for table buttons',
  },
  // Dan 2026-08-18: "remove the skip animations toggle, animations are not
  // optional." This definition list is what renders the switches, so dropping
  // the entry removes the control everywhere it appeared. The column and the
  // interface field are deliberately kept - no migration, nothing reading the
  // type breaks - but nothing writes it any more, and TablePage no longer
  // applies it: it now actively clears the duration overrides so a stale
  // cached `true` cannot leave a table permanently un-animated.
  //
  // Accessibility is unaffected; prefers-reduced-motion is handled in CSS.
  {
    key: 'use_alias',
    label: 'Use Club Alias',
    description: 'Display Your Club Alias Instead Of Your Smarter.Poker Name At The Table',
  },
  /* NO AUTO TABLE SWITCHING — LAW (Dan 2026-08-28): the Multi-Table
     Auto-Switch and Action Queue toggles were REMOVED from this panel and
     their consuming effects deleted from MultiTablePage. "YOU CAN NEVER EVER
     AUTO CHANGE TABLES FOR A USER, THEY MUST CHANGE IT BY THEM SELF." The DB
     columns and the keys below survive only so existing rows keep parsing;
     nothing may ever read them to move the active table again. Pinned by
     tests/no-auto-table-switch.law.test.ts. */
  {
    key: 'multi_desktop_alerts',
    label: 'Desktop Turn Alerts',
    description: 'Browser Notification When A Table Needs You And This Tab Is In The Background',
  },
  {
    key: 'multi_shared_socket',
    label: 'Shared Connection',
    description:
      'All Tables Share One Game Connection - Instant Table Joins, Fewer Reconnects, Better Battery',
  },
];

const LOCAL_CACHE_PREFIX = 'user_table_settings_cache:';

const cacheKeyForUser = (userId: string) => `${LOCAL_CACHE_PREFIX}${userId}`;

export function readCachedSettings(userId: string | null | undefined): UserTableSettings {
  if (!userId) return { ...DEFAULT_USER_TABLE_SETTINGS };
  try {
    const cached = localStorage.getItem(cacheKeyForUser(userId));
    if (cached) return { ...DEFAULT_USER_TABLE_SETTINGS, ...JSON.parse(cached) };
  } catch {
    /* stale or unavailable localStorage falls through to canonical defaults */
  }
  return { ...DEFAULT_USER_TABLE_SETTINGS };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE NETWORK READ PER USER, NOT ONE PER COMPONENT (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This hook is called from far more places than it looks. Counted on main:
 *
 *   TablePage (direct)                                            1
 *   useButtonImage — which calls this hook — from TableMenu,
 *     PreviousHandCard, MiniStatsCard, RabbitHunt, TableChat,
 *     TimebankCounter, and twice more inside TablePage itself      8
 *   MultiTablePage, HamburgerMenu, SettingsPanel                   3
 *
 * Nine of those live INSIDE a TablePage, and MultiTablePage keeps up to four
 * TablePages mounted — so opening four tables fired roughly **37 identical
 * `select('*') on user_table_settings`**, all for the same user, all within a
 * second of each other, every one of them a round trip to Supabase before the
 * felt could paint.
 *
 * Nothing was wrong with any single call. The hook is simply used the way a
 * cheap selector is used, while doing the work of a fetch.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO. It de-duplicates the
 * READ and nothing else: concurrent callers for the same user share one
 * in-flight promise, so N mounts cost one query. Every hook instance still
 * keeps its own state, its own MasterBus subscriptions and its own write
 * machinery (`writeTailsRef`, `durableValueRef`, `pendingEchoRef` and the
 * rest), untouched.
 *
 * That restraint is the point. Sharing the STATE as well would be the bigger
 * win and the bigger risk: this hook's write path is a documented minefield of
 * echo suppression and revision counters — the notes above describe a latch
 * that "swallows the next genuine cross-component change" — and collapsing N
 * writers onto one store is a change that deserves its own commit and its own
 * tests, not a line in a performance pass.
 *
 * THE CACHE IS THE IN-FLIGHT PROMISE, NOT THE RESULT. It is dropped as soon as
 * it settles, so this can only ever collapse a burst of simultaneous mounts.
 * A component that mounts later still reads the database, and a settings write
 * is never served a stale row. There is no TTL to tune and no invalidation to
 * forget, because nothing is retained.
 */
const settingsRowQuery = (userId: string) =>
  supabase.from('user_table_settings').select('*').eq('user_id', userId).maybeSingle();

type SettingsRowResult = Awaited<ReturnType<typeof settingsRowQuery>>;

const inFlightSettingsReads = new Map<string, Promise<SettingsRowResult>>();

export function fetchUserTableSettingsRow(userId: string): Promise<SettingsRowResult> {
  const existing = inFlightSettingsReads.get(userId);
  if (existing) return existing;

  // `Promise.resolve` because a PostgREST builder is a THENABLE, not a Promise:
  // it has `.then` but no `.catch`/`.finally`, so it cannot be stored or awaited
  // as one. Resolving it once gives a real Promise that many callers can await.
  const p = Promise.resolve(settingsRowQuery(userId)).then(
    (res) => {
      inFlightSettingsReads.delete(userId);
      return res;
    },
    (err) => {
      // Drop the entry on rejection too, or one network blip would wedge every
      // future mount onto a permanently failed promise.
      inFlightSettingsReads.delete(userId);
      throw err;
    }
  );

  inFlightSettingsReads.set(userId, p);
  return p;
}

/** Test seam: prove the de-duplication rather than assume it. */
export function __inFlightSettingsReadCount(): number {
  return inFlightSettingsReads.size;
}

export function useUserTableSettings(userId: string | null | undefined) {
  const [settings, setSettings] = useState<UserTableSettings>(() => readCachedSettings(userId));
  const [loading, setLoading] = useState(true);
  /* An identity, not a latch — see the long note in useTableSettings. A
     boolean set-before-emit gets permanently stuck the moment MasterBus
     suppresses a duplicate emit, and then swallows the next genuine
     cross-component change. 2026-08-26. */
  const originIdRef = useRef<string>(`uts-${Math.random().toString(36).slice(2)}`);
  const activeUserIdRef = useRef(userId);
  activeUserIdRef.current = userId;
  // Keep a ref to the latest settings to avoid stale closure in toggleSetting
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mutationRevisionRef = useRef(new Map<string, number>());
  const writeTailsRef = useRef(new Map<string, Promise<void>>());
  const durableValueRef = useRef(new Map<string, UserTableSettings[keyof UserTableSettings]>());
  const pendingWriteCountRef = useRef(new Map<string, number>());
  const pendingEchoRef = useRef(new Map<string, string>());

  // ── Load from Supabase on mount ──
  useEffect(() => {
    const cached = readCachedSettings(userId);
    settingsRef.current = cached;
    setSettings(cached);
    setLoading(Boolean(userId));

    if (!userId) {
      setLoading(false);
      return;
    }

    let mounted = true;
    const load = async () => {
      try {
        const { data, error } = await fetchUserTableSettingsRow(userId);

        if (error) {
          console.warn('[useUserTableSettings] Load failed, using cache:', error.message);
          setLoading(false);
          return;
        }

        if (data && mounted && activeUserIdRef.current === userId) {
          const loaded: UserTableSettings = {
            highlight_active_players:
              data.highlight_active_players ?? DEFAULT_USER_TABLE_SETTINGS.highlight_active_players,
            show_avatars: data.show_avatars ?? DEFAULT_USER_TABLE_SETTINGS.show_avatars,
            show_badges: data.show_badges ?? DEFAULT_USER_TABLE_SETTINGS.show_badges,
            cards_pre_sort: data.cards_pre_sort ?? DEFAULT_USER_TABLE_SETTINGS.cards_pre_sort,
            gestures_enabled: data.gestures_enabled ?? DEFAULT_USER_TABLE_SETTINGS.gestures_enabled,
            card_slide: data.card_slide ?? DEFAULT_USER_TABLE_SETTINGS.card_slide,
            card_squeeze: data.card_squeeze ?? DEFAULT_USER_TABLE_SETTINGS.card_squeeze,
            show_stack_in_bb: data.show_stack_in_bb ?? DEFAULT_USER_TABLE_SETTINGS.show_stack_in_bb,
            auto_time_bank: data.auto_time_bank ?? DEFAULT_USER_TABLE_SETTINGS.auto_time_bank,
            enhanced_view: data.enhanced_view ?? DEFAULT_USER_TABLE_SETTINGS.enhanced_view,
            voice_message: data.voice_message ?? DEFAULT_USER_TABLE_SETTINGS.voice_message,
            text_message: data.text_message ?? DEFAULT_USER_TABLE_SETTINGS.text_message,
            emoji_enabled: data.emoji_enabled ?? DEFAULT_USER_TABLE_SETTINGS.emoji_enabled,
            blue_buttons_enabled:
              data.blue_buttons_enabled ?? DEFAULT_USER_TABLE_SETTINGS.blue_buttons_enabled,
            skip_animations: data.skip_animations ?? DEFAULT_USER_TABLE_SETTINGS.skip_animations,
            use_alias: data.use_alias ?? DEFAULT_USER_TABLE_SETTINGS.use_alias,
            table_alias: data.table_alias ?? DEFAULT_USER_TABLE_SETTINGS.table_alias,
            multi_auto_switch:
              data.multi_auto_switch ?? DEFAULT_USER_TABLE_SETTINGS.multi_auto_switch,
            multi_action_queue:
              data.multi_action_queue ?? DEFAULT_USER_TABLE_SETTINGS.multi_action_queue,
            multi_desktop_alerts:
              data.multi_desktop_alerts ?? DEFAULT_USER_TABLE_SETTINGS.multi_desktop_alerts,
            multi_shared_socket:
              data.multi_shared_socket ?? DEFAULT_USER_TABLE_SETTINGS.multi_shared_socket,
          };
          setSettings(loaded);
          // Cache locally for instant loads
          try {
            localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(loaded));
          } catch {
            /* */
          }
          // Shared-socket BETA: the flag follows the account onto every
          // device - mirror the loaded value so EngineStateClient's next
          // (re)connect sees it here too.
          try {
            localStorage.setItem('ca_ws_mux', loaded.multi_shared_socket ? '1' : '0');
          } catch {
            /* private mode */
          }
        }
        // If no row exists, defaults are already set — row will be created on first toggle
      } catch (err) {
        console.warn('[useUserTableSettings] Unexpected error:', err);
      }
      if (mounted && activeUserIdRef.current === userId) setLoading(false);
    };

    load();
    return () => {
      mounted = false;
    };
  }, [userId]);

  // ── Listen for cross-component SETTINGS_CHANGED events ──
  useEffect(() => {
    const mutationUnsub = masterBus.subscribe('CUSTOMIZATION_MUTATION_STATE', (event) => {
      if (event.payload.kind !== 'user-table-setting') return;
      const prefix = `${userId || ''}:`;
      if (!event.payload.scope.startsWith(prefix)) return;
      const setting = event.payload.scope.slice(prefix.length) as keyof UserTableSettings;
      if (!(setting in DEFAULT_USER_TABLE_SETTINGS)) return;
      if (event.payload.state === 'pending') {
        pendingEchoRef.current.set(event.payload.scope, event.payload.mutationId);
      } else if (pendingEchoRef.current.get(event.payload.scope) === event.payload.mutationId) {
        pendingEchoRef.current.delete(event.payload.scope);
      }
    });
    const unsub = masterBus.subscribe('SETTINGS_CHANGED', (event) => {
      if (event.payload?.origin === originIdRef.current) return;
      if (event.payload.userId && event.payload.userId !== userId) return;
      const { setting, value } = event.payload;
      if (
        event.payload?.origin?.startsWith('postgres-sync:') &&
        pendingEchoRef.current.has(`${userId || ''}:${setting}`)
      ) {
        return;
      }
      if (setting && setting in DEFAULT_USER_TABLE_SETTINGS) {
        setSettings((prev) => {
          const updated = { ...prev, [setting]: value };
          settingsRef.current = updated;
          try {
            if (userId) localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(updated));
          } catch {
            /* */
          }
          return updated;
        });
      }
    });
    return () => {
      mutationUnsub();
      unsub();
    };
  }, [userId]);

  // ── Toggle a single setting ──
  const toggleSetting = useCallback(
    async (key: keyof UserTableSettings) => {
      if (!userId) return;

      // Advance the ref synchronously. React state may not commit between two
      // fast taps; reading a render-stale ref made both taps calculate the same
      // value instead of toggling twice.
      const previousValue = Boolean(settingsRef.current[key]);
      const newValue = !previousValue;
      const mutationScope = `${userId}:${String(key)}`;
      const revision = (mutationRevisionRef.current.get(mutationScope) ?? 0) + 1;
      const mutationId = `${mutationScope}:${revision}`;
      mutationRevisionRef.current.set(mutationScope, revision);
      if ((pendingWriteCountRef.current.get(mutationScope) ?? 0) === 0) {
        durableValueRef.current.set(mutationScope, previousValue);
      }
      pendingWriteCountRef.current.set(
        mutationScope,
        (pendingWriteCountRef.current.get(mutationScope) ?? 0) + 1
      );

      // Optimistic update
      const optimistic = { ...settingsRef.current, [key]: newValue };
      settingsRef.current = optimistic;
      setSettings(optimistic);
      try {
        localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(optimistic));
      } catch {
        /* */
      }

      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'user-table-setting',
        scope: mutationScope,
        mutationId,
        state: 'pending',
      });

      // Broadcast for cross-component sync
      masterBus.emit('SETTINGS_CHANGED', {
        setting: key,
        value: newValue,
        userId,
        origin: originIdRef.current,
      });

      // Desktop alerts (2026-08-21): the toggle tap IS the user gesture -
      // this is the one place the app may ask for Notification permission.
      // Denied permission leaves the setting on; the alert path re-checks
      // Notification.permission before posting, so it simply stays quiet.
      if (key === 'multi_desktop_alerts' && newValue) {
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            void Notification.requestPermission();
          }
        } catch {
          /* some webviews throw on access */
        }
      }

      // Shared socket BETA (2026-08-21): EngineStateClient reads the
      // localStorage flag at (re)connect time, so mirroring here makes the
      // toggle take effect on the next reconnect without a reload.
      if (key === 'multi_shared_socket') {
        try {
          localStorage.setItem('ca_ws_mux', newValue ? '1' : '0');
        } catch {
          /* private mode */
        }
      }

      // Backward compat: sync show_stack_in_bb to old localStorage key used by HamburgerMenu
      if (key === 'show_stack_in_bb') {
        try {
          localStorage.setItem(STORAGE_KEYS.SHOW_STACK_BB, String(newValue));
        } catch {
          /* */
        }
      }

      // Persist in tap order. A slower first request must not finish after the
      // second and become the durable value.
      const previousTail = writeTailsRef.current.get(mutationScope) ?? Promise.resolve();
      const task = previousTail.then(async () => {
        try {
          const { error } = await supabase.from('user_table_settings').upsert(
            {
              user_id: userId,
              [key]: newValue,
            },
            { onConflict: 'user_id' }
          );
          return error ?? undefined;
        } catch (error) {
          return error;
        }
      });
      const tail = task.then(() => undefined);
      writeTailsRef.current.set(mutationScope, tail);
      const error = await task;
      if (writeTailsRef.current.get(mutationScope) === tail) {
        writeTailsRef.current.delete(mutationScope);
      }

      if (error) {
        reportError(error, 'useUserTableSettings.Save_failed');
        // Only the latest mutation may roll this field back. Broadcast that
        // rollback too, or the source panel and the other open tables disagree.
        if (
          activeUserIdRef.current === userId &&
          mutationRevisionRef.current.get(mutationScope) === revision &&
          settingsRef.current[key] === newValue
        ) {
          const rollbackValue = Boolean(
            durableValueRef.current.get(mutationScope) ?? previousValue
          );
          const reverted = { ...settingsRef.current, [key]: rollbackValue };
          settingsRef.current = reverted;
          setSettings(reverted);
          try {
            localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(reverted));
          } catch {
            /* */
          }
          masterBus.emit('SETTINGS_CHANGED', {
            setting: key,
            value: rollbackValue,
            userId,
            origin: originIdRef.current,
          });
          if (key === 'multi_shared_socket') {
            try {
              localStorage.setItem('ca_ws_mux', rollbackValue ? '1' : '0');
            } catch {
              /* private mode */
            }
          }
        }
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'user-table-setting',
          scope: mutationScope,
          mutationId,
          state: 'rolled-back',
        });
      } else {
        durableValueRef.current.set(mutationScope, newValue);
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'user-table-setting',
          scope: mutationScope,
          mutationId,
          state: 'confirmed',
        });
      }
      pendingWriteCountRef.current.set(
        mutationScope,
        Math.max(0, (pendingWriteCountRef.current.get(mutationScope) ?? 1) - 1)
      );
    },
    [userId]
  );

  // ── Set a string setting (for table_alias) ──
  const setAlias = useCallback(
    async (alias: string) => {
      if (!userId) return;

      const previousAlias = settingsRef.current.table_alias;
      const mutationScope = `${userId}:table_alias`;
      const revision = (mutationRevisionRef.current.get(mutationScope) ?? 0) + 1;
      const mutationId = `${mutationScope}:${revision}`;
      mutationRevisionRef.current.set(mutationScope, revision);
      if ((pendingWriteCountRef.current.get(mutationScope) ?? 0) === 0) {
        durableValueRef.current.set(mutationScope, previousAlias);
      }

      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'user-table-setting',
        scope: mutationScope,
        mutationId,
        state: 'pending',
      });
      pendingWriteCountRef.current.set(
        mutationScope,
        (pendingWriteCountRef.current.get(mutationScope) ?? 0) + 1
      );

      // Optimistic update
      const optimistic = { ...settingsRef.current, table_alias: alias };
      settingsRef.current = optimistic;
      setSettings(optimistic);
      try {
        localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(optimistic));
      } catch {
        /* */
      }

      // Broadcast for cross-component sync
      masterBus.emit('SETTINGS_CHANGED', {
        setting: 'table_alias',
        value: alias,
        userId,
        origin: originIdRef.current,
      });

      const previousTail = writeTailsRef.current.get(mutationScope) ?? Promise.resolve();
      const task = previousTail.then(async () => {
        try {
          const { error } = await supabase.from('user_table_settings').upsert(
            {
              user_id: userId,
              table_alias: alias,
            },
            { onConflict: 'user_id' }
          );
          return error ?? undefined;
        } catch (error) {
          return error;
        }
      });
      const tail = task.then(() => undefined);
      writeTailsRef.current.set(mutationScope, tail);
      const error = await task;
      if (writeTailsRef.current.get(mutationScope) === tail) {
        writeTailsRef.current.delete(mutationScope);
      }

      if (error) {
        reportError(error, 'useUserTableSettings.Alias_save_failed');
        if (
          activeUserIdRef.current === userId &&
          mutationRevisionRef.current.get(mutationScope) === revision &&
          settingsRef.current.table_alias === alias
        ) {
          const rollbackAlias =
            (durableValueRef.current.get(mutationScope) as string | undefined) ?? previousAlias;
          const reverted = { ...settingsRef.current, table_alias: rollbackAlias };
          settingsRef.current = reverted;
          setSettings(reverted);
          try {
            localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(reverted));
          } catch {
            /* */
          }
          masterBus.emit('SETTINGS_CHANGED', {
            setting: 'table_alias',
            value: rollbackAlias,
            userId,
            origin: originIdRef.current,
          });
        }
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'user-table-setting',
          scope: mutationScope,
          mutationId,
          state: 'rolled-back',
        });
      } else if (!error) {
        durableValueRef.current.set(mutationScope, alias);
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'user-table-setting',
          scope: mutationScope,
          mutationId,
          state: 'confirmed',
        });
      }
      pendingWriteCountRef.current.set(
        mutationScope,
        Math.max(0, (pendingWriteCountRef.current.get(mutationScope) ?? 1) - 1)
      );
    },
    [userId]
  );

  return { settings, loading, toggleSetting, setAlias };
}
