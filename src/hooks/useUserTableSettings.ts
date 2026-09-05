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
import { markSettingsTouched } from './useTableSettings';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — matches Bible V8 §11.1.1 exactly
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserTableSettings {
  highlight_active_players: boolean;
  show_avatars: boolean;
  show_badges: boolean;
  cards_pre_sort: boolean;
  gestures_enabled: boolean;
  /**
   * CARD SLIDE (Dan 2026-09-04): hero hole cards are dealt FACE DOWN and the
   * player looks at them by pinching a corner and peeling it back, exactly as
   * at a live table - the corner tracks the finger, the hand lifts off the
   * felt, and letting go early drops it flat again. Off by default. Auto-
   * reveals at showdown / all-in so the hero never sees less than the table.
   *
   * This is the ONE switch for the feature. `card_squeeze` (competitor-parity
   * 2026-08-19) was the same feature under a second name with a hinge
   * animation; migration 20260905050000 carried every `card_squeeze = true`
   * into `card_slide` and the column is no longer read or shown.
   */
  card_slide: boolean;
  /** Retired 2026-09-04 in favour of card_slide; column kept, never read. */
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
  /**
   * Rabbit Hunt button (Dan 2026-09-05): "IT NEEDS A DISABLE OR HIDE OPTION IN
   * THE TABLE SETTINGS FOR USERS THAT DON'T WANT IT POPPING UP."
   *
   * ON by default, because the feature is a paid one a player has to opt OUT
   * of noticing rather than opt in to owning. Off hides the button only. It
   * does not shorten HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS, which is table
   * rhythm every seat shares (CLAUDE.md 10.5) and would otherwise let one
   * player's preference change the pace of everybody else's game - and tell
   * the table something about the deck while it did.
   */
  rabbit_hunt_button: boolean;
}

export const DEFAULT_USER_TABLE_SETTINGS: UserTableSettings = {
  highlight_active_players: true,
  show_avatars: true,
  show_badges: false,
  cards_pre_sort: true,
  gestures_enabled: false,
  card_slide: false, // 2026-09-04: the corner peel, OFF by default (Dan); 20260905001550
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
  rabbit_hunt_button: true,
};

// Metadata for rendering toggles
export interface SettingMeta {
  key: keyof UserTableSettings;
  label: string;
  description: string;
  /**
   * Surfaced inline in the Hero Hub's Table tab (2026-08-30), as well as in
   * the full settings panel.
   *
   * The hub's Table tab used to be a single button that closed the hub and
   * opened SettingsPanel — the same weakness the Stats tab had before its
   * figures were inlined. These are the switches a player reaches for DURING
   * a session, so they belong one tap from the avatar rather than three.
   *
   * The flag lives HERE, next to the settings' single owner, on purpose: the
   * quick list must never become a second hand-maintained list of keys that
   * can drift from this one. Marking a setting `quick` is the whole edit;
   * the hub renders whatever carries the flag and writes through the same
   * `toggleSetting` as the panel, so there is still exactly one owner and one
   * persisted copy per setting.
   */
  quick?: boolean;
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
    quick: true,
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
    quick: true,
  },
  {
    key: 'card_slide',
    label: 'Card Slide',
    description: 'Deal Your Cards Face Down And Peel A Corner Back To Look, Like A Live Game',
    quick: true,
  },
  {
    key: 'rabbit_hunt_button',
    label: 'Rabbit Hunt Button',
    description: 'Offer To Show The Cards That Would Have Come After A Hand Ends',
    quick: true,
  },
  {
    key: 'show_stack_in_bb',
    label: 'Show Stack In Big Blinds',
    description: 'Display Chip Stacks As BB Count Instead Of Chip Value',
    quick: true,
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
export const SETTINGS_READ_TIMEOUT_MS = 8_000;

export function fetchUserTableSettingsRow(userId: string): Promise<SettingsRowResult> {
  const existing = inFlightSettingsReads.get(userId);
  if (existing) return existing;

  // `Promise.resolve` because a PostgREST builder is a THENABLE, not a Promise:
  // it has `.then` but no `.catch`/`.finally`, so it cannot be stored or awaited
  // as one. Resolving it once gives a real Promise that many callers can await.
  const request = Promise.resolve(settingsRowQuery(userId));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`User table settings read timed out after ${SETTINGS_READ_TIMEOUT_MS} ms.`));
    }, SETTINGS_READ_TIMEOUT_MS);
  });

  const p = Promise.race([request, timeout]).then(
    (res) => {
      if (timeoutId) clearTimeout(timeoutId);
      inFlightSettingsReads.delete(userId);
      return res;
    },
    (err) => {
      if (timeoutId) clearTimeout(timeoutId);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A FAILED SAVE HOLDS THE USER'S CHOICE. IT NEVER UNDOES IT.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE
 * SETTINGS, THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL
 * PAGES. AND NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM
 * MANUALLY."
 *
 * Until 2026-08-29 this hook did the opposite. A refused or timed-out upsert
 * ran a rollback block that re-wrote the OLD value into state, into
 * localStorage, and onto the bus — so one dropped request flipped the switch
 * back on the panel the user was looking at AND on every other open table.
 * `toggleSetting` did it with no message at all, which is the exact shape of
 * "my settings keep changing themselves": no error, no console, and it looks
 * like the app disagreeing with you.
 *
 * `useTableSettings` had already been fixed the other way (its
 * `pushKeyToServer` is fire-and-forget and documents that it deliberately does
 * not roll back). The two hooks write the same table and now behave the same
 * way, which is the point — a user cannot tell which one owns a given switch.
 *
 * WHAT REPLACED THE ROLLBACK
 *
 *  1. RETRY. A lost write is usually a blip, so the upsert is attempted up to
 *     three times with a short backoff before anyone is told anything. Most
 *     failures never reach the user at all.
 *  2. HOLD. If all three fail the optimistic value STAYS — on screen, in
 *     localStorage, and on the bus. What is lost is the cross-device copy,
 *     not the setting.
 *  3. SAY SO. One toast, so the user knows the choice is device-local rather
 *     than believing it synced. The Toast layer dedupes identical messages,
 *     so a burst of failed writes cannot stack up popups.
 *
 * A SUPERSEDED WRITE STOPS RETRYING. If the user taps again while attempt two
 * is in flight, the newer revision owns the column; re-writing the older value
 * would be the auto-change-back this whole change exists to prevent. The
 * retry loop checks `stillCurrent()` before each attempt and abandons quietly
 * — no toast, no terminal state, because the newer mutation emits its own.
 */
const SAVE_RETRY_DELAYS_MS = [400, 1500] as const;

const SAVE_FAILED_TOAST = 'Setting Saved On This Device Only. We Could Not Reach The Server.';

type PersistOutcome =
  | { status: 'saved' }
  | { status: 'superseded' }
  | { status: 'failed'; error: unknown };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertSettingColumn(
  userId: string,
  column: string,
  value: unknown
): Promise<unknown | undefined> {
  try {
    const { error } = await supabase
      .from('user_table_settings')
      .upsert({ user_id: userId, [column]: value }, { onConflict: 'user_id' });
    return error ?? undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Persist one column, retrying a lost write instead of undoing it.
 *
 * `stillCurrent` is the supersede check described above. It is a callback
 * rather than a captured boolean because the answer changes WHILE this is
 * awaiting — a value read once at entry would always say yes.
 */
async function persistSettingColumn(
  userId: string,
  column: string,
  value: unknown,
  stillCurrent: () => boolean
): Promise<PersistOutcome> {
  let error = await upsertSettingColumn(userId, column, value);
  if (!error) {
    await markSettingsTouched([column]);
    return { status: 'saved' };
  }

  for (const backoff of SAVE_RETRY_DELAYS_MS) {
    await delay(backoff);
    if (!stillCurrent()) return { status: 'superseded' };
    error = await upsertSettingColumn(userId, column, value);
    if (!error) {
      await markSettingsTouched([column]);
      return { status: 'saved' };
    }
  }

  return { status: 'failed', error };
}

/** One toast, whichever column failed. The Toast layer dedupes the rest. */
function announceSaveFailure(): void {
  masterBus.emit('SHOW_TOAST', {
    severity: 'warning',
    message: SAVE_FAILED_TOAST,
    source: 'useUserTableSettings',
  });
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
  /**
   * Keys the user has changed since this hook mounted.
   *
   * `useTableSettings` has had this guard since 2026-08-28 and this hook did
   * not, so the last of the four auto-change-backs lived here: the panel mounts,
   * the row read goes out, the user taps a switch inside that window, and then
   * the stale answer lands and `setSettings(loaded)` puts it back — writing the
   * old value to the cache and to `ca_ws_mux` too. The database ends up holding
   * what the user asked for while the panel shows the opposite, until reload.
   *
   * The in-flight de-duplication WIDENS that window rather than closing it: a
   * component mounting during a burst shares one promise, so the answer it gets
   * is as old as the first mount.
   */
  const locallyTouchedRef = useRef(new Set<keyof UserTableSettings>());
  /* `durableValueRef` and `pendingWriteCountRef` lived here until 2026-08-29.
     Both existed only to reconstruct the value a failed write should be rolled
     back TO. Nothing rolls back any more, so both had become write-only — the
     shape of dead code that reads like live code. */
  const pendingEchoRef = useRef(new Map<string, string>());

  // ── Load from Supabase on mount ──
  useEffect(() => {
    // A new account's row must not be reconciled against the previous account's
    // live edits.
    locallyTouchedRef.current.clear();
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
          /* Reported, not just console-warned. A settings read that fails for
             EVERY user — an RLS regression, a dropped column, a revoked grant —
             used to produce zero telemetry and a UI quietly serving defaults.
             Both write paths in this file already report; the read did not. */
          reportError(error, 'useUserTableSettings.Load_failed');
          if (mounted && activeUserIdRef.current === userId) setLoading(false);
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
            rabbit_hunt_button:
              data.rabbit_hunt_button ?? DEFAULT_USER_TABLE_SETTINGS.rabbit_hunt_button,
          };
          /* A LIVE EDIT OUTRANKS A STALE READ. Anything the user changed while
             this row was in flight keeps the value they chose — see the note on
             locallyTouchedRef. Without this the answer that was already stale
             when it was asked for silently undid their tap. */
          const reconciled = { ...loaded };
          for (const key of locallyTouchedRef.current) {
            (reconciled as Record<string, unknown>)[key] = settingsRef.current[key];
          }
          settingsRef.current = reconciled;
          setSettings(reconciled);
          // Cache locally for instant loads
          try {
            localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(reconciled));
          } catch {
            /* */
          }
          // Shared-socket BETA: the flag follows the account onto every
          // device - mirror the loaded value so EngineStateClient's next
          // (re)connect sees it here too.
          try {
            localStorage.setItem('ca_ws_mux', reconciled.multi_shared_socket ? '1' : '0');
          } catch {
            /* private mode */
          }
        }
        // If no row exists, defaults are already set — row will be created on first toggle
      } catch (err) {
        /* This is the rejection `fetchUserTableSettingsRow` deliberately
           re-throws so one blip cannot wedge the shared promise. Swallowing it
           to the console meant that re-throw reached nothing that records it. */
        reportError(err, 'useUserTableSettings.Load_threw');
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
      /* `in` walks the prototype chain, so a payload naming 'constructor' or
         'toString' passed this test and wrote a function into settings. The
         sister hook fixed this at useTableSettings.ts:232; it was never
         back-ported here. */
      if (setting && Object.prototype.hasOwnProperty.call(DEFAULT_USER_TABLE_SETTINGS, setting)) {
        /* ═══ A LIVE EDIT OUTRANKS A STALE BROADCAST ════════════════════════
           Dan 2026-08-31: "every time he logs in, Card Slide and Card Squeeze
           are always turned off, even though he keeps changing it."

           The load path has enforced this since 2026-08-28 (see
           locallyTouchedRef) and `useTableSettings` enforces it on its own bus
           path at :725 — "a live edit outranks a stale read". This hook applied
           the guard to the load and NOT to the bus, which is the last of the
           auto-change-backs the note above this file describes.

           It matters more than a one-frame flicker, because of what reads this
           value next. `toggleSetting` computes the next value from
           `settingsRef.current`, not from rendered state. Let a stale broadcast
           put `true` back into that ref while the switch renders OFF, and the
           user's next tap writes `false` — the switch does not move, and the
           default is persisted again. Tap it ten times and it never moves. That
           is the report, exactly. */
        if (locallyTouchedRef.current.has(setting as keyof UserTableSettings)) return;
        /* Derived from the ref and assigned OUTSIDE the updater. React may run
           an updater in a render it then discards (concurrent interruption,
           StrictMode double-invoke); mutating the ref in there can leave it
           holding a value that never became `settings`, and `toggleSetting`
           would then calculate from a value the user never saw. */
        const updated = { ...settingsRef.current, [setting]: value };
        settingsRef.current = updated;
        try {
          if (userId) localStorage.setItem(cacheKeyForUser(userId), JSON.stringify(updated));
        } catch {
          /* */
        }
        setSettings(updated);
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
      locallyTouchedRef.current.add(key);

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
      const task = previousTail.then(() =>
        persistSettingColumn(
          userId,
          String(key),
          newValue,
          () =>
            activeUserIdRef.current === userId &&
            mutationRevisionRef.current.get(mutationScope) === revision
        )
      );
      const tail = task.then(() => undefined);
      writeTailsRef.current.set(mutationScope, tail);
      const outcome = await task;
      if (writeTailsRef.current.get(mutationScope) === tail) {
        writeTailsRef.current.delete(mutationScope);
      }

      // A superseded write is not a failure and not a save. The newer tap owns
      // the column and emits its own terminal state; saying anything here would
      // either double-count it or contradict it.
      if (outcome.status === 'superseded') return;

      if (outcome.status === 'failed') {
        reportError(outcome.error, 'useUserTableSettings.Save_failed');
        // THE VALUE STAYS. See the long note above persistSettingColumn.
        if (activeUserIdRef.current === userId) announceSaveFailure();
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'user-table-setting',
          scope: mutationScope,
          mutationId,
          state: 'save-failed',
        });
        return;
      }

      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'user-table-setting',
        scope: mutationScope,
        mutationId,
        state: 'confirmed',
      });
    },
    [userId]
  );

  // ── Set a string setting (for table_alias) ──
  const setAlias = useCallback(
    async (alias: string) => {
      if (!userId) return;

      const mutationScope = `${userId}:table_alias`;
      const revision = (mutationRevisionRef.current.get(mutationScope) ?? 0) + 1;
      const mutationId = `${mutationScope}:${revision}`;
      mutationRevisionRef.current.set(mutationScope, revision);
      locallyTouchedRef.current.add('table_alias');

      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'user-table-setting',
        scope: mutationScope,
        mutationId,
        state: 'pending',
      });

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
      const task = previousTail.then(() =>
        persistSettingColumn(
          userId,
          'table_alias',
          alias,
          () =>
            activeUserIdRef.current === userId &&
            mutationRevisionRef.current.get(mutationScope) === revision
        )
      );
      const tail = task.then(() => undefined);
      writeTailsRef.current.set(mutationScope, tail);
      const outcome = await task;
      if (writeTailsRef.current.get(mutationScope) === tail) {
        writeTailsRef.current.delete(mutationScope);
      }

      if (outcome.status === 'superseded') return;

      if (outcome.status === 'failed') {
        reportError(outcome.error, 'useUserTableSettings.Alias_save_failed');
        // THE ALIAS STAYS. Retyping a name because one request was dropped is
        // the same regression as a switch flipping itself back.
        if (activeUserIdRef.current === userId) announceSaveFailure();
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'user-table-setting',
          scope: mutationScope,
          mutationId,
          state: 'save-failed',
        });
        return;
      }

      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'user-table-setting',
        scope: mutationScope,
        mutationId,
        state: 'confirmed',
      });
    },
    [userId]
  );

  return { settings, loading, toggleSetting, setAlias };
}
