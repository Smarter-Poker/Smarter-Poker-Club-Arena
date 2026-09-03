import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { masterBus } from '../core/MasterBus';
import { useUserStore } from '../stores/useUserStore';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { soundService } from '../services/SoundService';
import { setVibrationAllowed, isVibrationPreferred } from '../utils/vibrationGate';
import { isSoundAllowed } from '../utils/soundGate';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useTableSettings Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages user preferences for poker table UI/UX including:
 * - Sound and haptic feedback control
 * - Animation speed adjustments
 * - Table appearance (theme, deck style)
 * - Display options (HUD, pot odds)
 * - Gameplay preferences (auto-muck, confirm all-in, etc.)
 *
 * All settings are persisted to localStorage and automatically applied to the DOM.
 */

export interface TableUserSettings {
  isSoundEnabled: boolean;
  soundVolume: number; // 0-100
  isHapticEnabled: boolean;
  animationSpeed: number; // 0.5, 1, 1.5, 2
  theme: string; // 'green', 'blue', 'red', 'purple', etc.
  fourColorDeck: boolean;
  showHUD: boolean;
  showPotOdds: boolean;
  showBetSizePresets: boolean;
  confirmAllIn: boolean;
  autoMuck: boolean;
  /**
   * SHOWDOWN AUDIT 2026-08-25 (Dan: "ENABLE AUTO MUCK BY DEFAULT, AND MAKE
   * USERS TURN IT OFF MANUALLY"): true only once the user has personally
   * toggled autoMuck. The old default was FALSE and this hook persists the
   * WHOLE settings object on every write, so any player who ever changed any
   * table setting has autoMuck:false sitting in localStorage without ever
   * choosing it. Without this marker, flipping the default to true did
   * nothing for exactly those players — worse, it would auto-SHOW their
   * losing hands. The loader below forces autoMuck true unless this marker
   * proves the false was a deliberate choice made AFTER the toggle shipped.
   */
  autoMuckExplicit: boolean;
  autoMuckWinners: boolean;
  autoPostBlinds: boolean;
  cardBack: string; // Card back design ID
  showStackInBB: boolean;
  autoRebuy: boolean; // Auto-rebuy when stack drops below threshold
  /**
   * Dan 2026-08-28: "add a toggle in the table settings, and in the Club
   * Arena settings, to turn the ticker on or off." The scrolling
   * tournament/announcement marquee (TournamentStartingTicker's .mtt-ticker)
   * reads this; default ON. The BBJ banner is a different element and is NOT
   * governed by this.
   */
  showTicker: boolean;
}

/**
 * Exported as `DEFAULT_TABLE_USER_SETTINGS` below so
 * tests/user-table-settings-defaults.test.ts can pin each value against the
 * column default it now has to match — the per-key upsert means a drift here
 * silently rewrites a user's OTHER settings.
 */
const DEFAULT_SETTINGS: TableUserSettings = {
  isSoundEnabled: true,
  soundVolume: 70,
  isHapticEnabled: true,
  animationSpeed: 1,
  theme: 'black',
  fourColorDeck: false,
  showHUD: true,
  showPotOdds: false,
  showBetSizePresets: true,
  confirmAllIn: true,
  // SHOWDOWN follow-up 2026-08-25 (Dan spec section 37): AUTO-MUCK LOSING
  // HANDS, on by default — the engine mucks a beaten hand automatically at
  // showdown. Switching it OFF means "always table my hand": the client
  // answers the engine's muck ruling with the existing voluntary-show call
  // (POST /showhand), so the hand turns face up with NO prompt — prompts
  // remain forbidden (Dan 2026-08-18, binding). The setting can never muck
  // a winner (the engine auto-tables winners regardless) and can never hide
  // an all-in showdown (every live all-in hand is force-exposed).
  autoMuck: true,
  autoMuckExplicit: false,
  autoMuckWinners: false,
  autoPostBlinds: true,
  // Dan 2026-08-18: was 'black', which has no `.card-back--black` rule in
  // CardImage.css - so the DEFAULT card back rendered as a blank rectangle for
  // every player who never opened the picker. 'classic_blue' is a real design
  // and matches SeatSlot's own fallback. CardBack normalises unknown ids now
  // too, so a stale 'black' already sitting in localStorage also recovers.
  cardBack: 'classic_blue',
  showStackInBB: false,
  autoRebuy: false,
  showTicker: true,
};

/** The client half of the default pairing the per-key upsert depends on. */
export const DEFAULT_TABLE_USER_SETTINGS: Readonly<TableUserSettings> = DEFAULT_SETTINGS;

import { STORAGE_KEYS } from '../lib/storage';
const STORAGE_KEY = STORAGE_KEYS.TABLE_SETTINGS;
const CSS_VAR_ANIMATION_SPEED = '--animation-speed';
/**
 * Dan 2026-08-28 (settings must apply live): `data-theme` was owned by TWO
 * unrelated systems at once — this hook wrote the table COLOR theme
 * ('black'/'green'/'blue'/...) into it, while the Theme Studio's Interface
 * toggle, Shell.tsx, useSettingsStore and MasterBus all write 'light'/'dark'
 * into the same attribute. Whichever wrote last won, so picking Light mode
 * held only until this hook's effect re-ran (every table mount) and stamped
 * it back to a color name — the "doesn't stick until reload" symptom.
 *
 * The color theme now rides its own attribute. design-tokens.css matches
 * BOTH `[data-theme=…]` and `[data-color-theme=…]` for every palette, so no
 * skin changes; `data-theme` itself now belongs exclusively to the
 * light/dark interface mode.
 */
const DOM_ATTR_THEME = 'data-color-theme';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE STORE, NOT ONE PER COMPONENT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE
 * SETTINGS, THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL
 * PAGES. AND NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM
 * MANUALLY."
 *
 * THE MECHANISM BEHIND "AUTO CHANGE BACK", and it was structural rather than a
 * bug in any one setting:
 *
 * This hook used to hold the settings in a per-instance `useState`, and persist
 * the WHOLE object to one localStorage key on every change. It is called by
 * TablePage, SettingsPage and TournamentStartingTicker — and MultiTablePage
 * keeps up to SIX TablePages mounted at once. So there were commonly eight
 * independent copies of the settings, each one writing its own complete blob
 * over the same key.
 *
 * Live updates between them relied entirely on the `SETTINGS_CHANGED` bus
 * message arriving everywhere. Miss one — and MasterBus drops a duplicate
 * `{type, payload}` fingerprint inside 500ms, which happens whenever a value is
 * set to what it already is — and that instance is now stale. It does not fail
 * loudly. It waits. The next time ANY setting changes in that instance, its
 * stale full object is written over the key, and every setting the user changed
 * elsewhere in the meantime silently reverts. That is the reported symptom
 * exactly: settings that change back on their own, with no error.
 *
 * A single module-level store removes the failure by construction. There is one
 * object, so there is nothing to diverge; every consumer reads the same value
 * through `useSyncExternalStore`, so a change is visible on every table and
 * every page in the same tick, whether or not the bus message is delivered. The
 * bus emit is kept for OTHER browser tabs, where it is still the only channel.
 *
 * LAZY, not initialised at import: the store reads localStorage on first use so
 * a test (or any caller) that stubs storage before rendering still gets a
 * truthful load. `__resetTableSettingsStoreForTest` is the seam for that.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  …AND THE STORE FOLLOWS THE USER, NOT THE BROWSER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Same rule, second half: "THEY NEED TO SAVE GLOBALLY". Sharing one store fixed
 * every table and page WITHIN a browser. These settings still lived only in one
 * unscoped localStorage key, so signing in on a phone showed none of them, and
 * two accounts on one machine shared one blob.
 *
 * Each key below is mirrored to a column on `user_table_settings` — already
 * per-user (PK user_id, RLS auth.uid() = user_id) and already in the
 * `supabase_realtime` publication, so `PostgresSyncHooks`'s existing
 * subscription delivers a change made on another device without any new
 * transport.
 *
 * localStorage is KEPT, as the offline cache and the signed-out store. It is
 * what makes a hostile start safe: a cold load paints from cache immediately,
 * the row arrives a moment later, and a player who is never signed in behaves
 * exactly as before.
 *
 * `showTicker` maps onto the `show_ticker` column that already existed. Until
 * now that column and this blob were two owners of one setting, which is its own
 * quiet way for a value to change back.
 *
 * NOT MIRRORED: `showHUD` and `autoRebuy` (no control renders them), and
 * `showStackInBB`, which `useUserTableSettings` already owns — a second writer
 * is the bug, not the fix.
 */
const COLUMN_FOR_KEY: Partial<Record<keyof TableUserSettings, string>> = {
  isSoundEnabled: 'sound_enabled',
  soundVolume: 'sound_volume',
  isHapticEnabled: 'haptic_enabled',
  animationSpeed: 'animation_speed',
  theme: 'color_theme',
  fourColorDeck: 'four_color_deck',
  showPotOdds: 'show_pot_odds',
  showBetSizePresets: 'show_bet_size_presets',
  showTicker: 'show_ticker',
  autoMuck: 'auto_muck',
  autoMuckExplicit: 'auto_muck_explicit',
  autoMuckWinners: 'auto_muck_winners',
  autoPostBlinds: 'auto_post_blinds',
  confirmAllIn: 'confirm_all_in',
  cardBack: 'card_back',
};

const KEY_FOR_COLUMN: Record<string, keyof TableUserSettings> = Object.fromEntries(
  Object.entries(COLUMN_FOR_KEY).map(([key, column]) => [column, key as keyof TableUserSettings])
) as Record<string, keyof TableUserSettings>;

/**
 * The column recording which settings this account has DELIBERATELY set.
 * Written only by `fn_mark_table_setting_touched`; see migration
 * 20260829125943_a_setting_records_that_it_was_chosen.sql for the bug it closes.
 */
export const TOUCHED_COLUMN = 'settings_touched';

/**
 * Ceiling on the touched-mark RPC. Generous — this is not a latency budget, it
 * is a guard against a call that never settles taking the ordered write queue
 * in `useUserTableSettings` with it. See `markSettingsTouched`.
 */
const TOUCH_MARK_TIMEOUT_MS = 8000;

/** OWN keys only. See the note at the bus subscriber for why `in` is unsafe. */
function isSettingKey(name: string): name is keyof TableUserSettings {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, name);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POSTGREST HANDS BACK `numeric` AS A STRING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-29. `animation_speed` and `sound_volume` are `numeric` columns, and
 * PostgREST serialises `numeric` as a STRING with its scale intact — this repo
 * already documents that for `tables.small_blind` ("384000.00", never 384000).
 *
 * `hydrateFromServer` compares the row against `DEFAULT_SETTINGS` to decide
 * whether the account ever chose a value. `"1" !== 1` is ALWAYS true, so
 * `animationSpeed` was permanently judged "the server chose this", with three
 * consequences, all silent:
 *
 *   1. the carry-up branch could never run for it, so a returning player's
 *      chosen speed was never adopted onto their account;
 *   2. `merged.animationSpeed` was set to the STRING on every hydrate, so a
 *      player who had picked Slow on this browser had it reset to normal on
 *      sign-in. That is the auto-change-back, arriving at the login screen;
 *   3. the string was then written into localStorage and re-merged forever,
 *      violating the declared `animationSpeed: number` at runtime.
 *
 * Coerce on the way in, against the TYPE OF THE DEFAULT rather than a list of
 * column names, so a column that becomes numeric later cannot reintroduce it.
 */
function coerceToDefaultType(key: keyof TableUserSettings, raw: unknown): unknown {
  const expected = typeof DEFAULT_SETTINGS[key];
  if (expected === 'number' && typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS[key];
  }
  if (expected === 'boolean' && typeof raw !== 'boolean') {
    return Boolean(raw);
  }
  return raw;
}

/** The one copy. `null` until first read — see the note above on laziness. */
let sharedSettings: TableUserSettings | null = null;
const listeners = new Set<() => void>();

/** Whose row the store currently holds. Null when signed out. */
let hydratedUserId: string | null = null;

/**
 * Keys the user has changed IN THIS SESSION.
 *
 * Hydration merges the server row over the local cache — except for these. A
 * player who flips a switch during the second the row is in flight must not
 * have it flipped back by an answer that was already stale when it was asked
 * for. That is the "auto change back" failure in its most infuriating form,
 * because it happens exactly when someone is actively using the panel.
 */
const locallyTouched = new Set<keyof TableUserSettings>();

function loadFromStorage(): TableUserSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const merged = {
        ...DEFAULT_SETTINGS,
        ...JSON.parse(saved),
      };
      // SHOWDOWN AUDIT 2026-08-25 — hostile-state migration. autoMuck's
      // default used to be false and rode along in every persisted write,
      // so a stored false proves nothing about what the player wants. Only
      // a false written by the user's own toggle (autoMuckExplicit) is
      // honoured; every other stored value is lifted to the new default.
      // Auto-muck is ON unless the user personally turned it off.
      if (merged.autoMuckExplicit !== true) {
        merged.autoMuck = true;
      }
      return merged;
    }
    return DEFAULT_SETTINGS;
  } catch (error) {
    console.warn('Failed to load table settings from localStorage:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Everything a settings value has to reach OUTSIDE React, done once per change
 * rather than once per mounted component.
 *
 * These were three `useEffect`s keyed on individual fields. With eight mounted
 * copies that was eight writers racing over the same DOM attribute and the same
 * localStorage mirror on every render pass — the same collision class as the
 * `data-theme` ownership fight documented above.
 */
function applySideEffects(next: TableUserSettings): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute(DOM_ATTR_THEME, next.theme);
    document.documentElement.style.setProperty(
      CSS_VAR_ANIMATION_SPEED,
      String(next.animationSpeed)
    );
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('Failed to save table settings to localStorage:', error);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHY applySideEffects NO LONGER WRITES `vibrationsEnabled`
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * It used to, "because HapticService reads its own key". That made this store a
 * SECOND, unsynchronised writer of `vibrationGate`'s settings key — the same
 * ownership collision this file's own `data-theme` postmortem describes, applied
 * to localStorage instead of to a DOM attribute.
 *
 * And `applySideEffects` runs on the FIRST `getSnapshot()`, i.e. the first
 * render of any TablePage, SettingsPage or TournamentStartingTicker. So: mute
 * haptics in the hamburger menu while no consumer of this store is mounted, the
 * bus relay never reaches the store (its subscription does not exist until
 * `attachBusOnce` has run from inside the hook), the blob still says
 * `isHapticEnabled: true`, and the next table mount stamps
 * `vibrationsEnabled='true'` straight over the mute. Vibration turns itself back
 * on, which is precisely Dan's rule 10 again.
 *
 * The gate owns those keys. This store now writes them only when the USER
 * changes the setting, through `setVibrationAllowed`, which writes both of them
 * together — see `updateSetting`.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AT BOOT, THE GATES ARE RIGHT AND THIS BLOB FOLLOWS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-29, second pass. `applyGateChanges` runs only from `commit`, and
 * deliberately not from `applySideEffects` — writing the blob's value over the
 * gate keys on the first render of any table is the second-writer bug that
 * silently un-muted people. But that left the opposite hole at boot: nothing
 * reconciled the two at all.
 *
 * Cold load, blob says sound ON (say, a value synced from another device last
 * session), gate keys say muted because the player muted from the hamburger
 * menu. The blob is what /settings and the table switches RENDER, so the
 * switches read ON while the app is silent — and `hydrateFromServer` only
 * commits when something `changed`, so if the server agrees with the blob
 * nothing ever corrects it.
 *
 * Which side wins is not arbitrary. `utils/soundGate` and `utils/vibrationGate`
 * are the owners: they are what `SoundService.shouldPlay` and every haptic call
 * site consult, they are written by the hamburger menu and the in-table
 * switches, and they fail closed on either of their two keys. So at boot the
 * blob adopts them — locally, with no push and no bus emit, because this is not
 * a change the user made, it is this copy catching up with the truth.
 *
 * A genuine cross-device change still arrives the other way, through
 * `hydrateFromServer` -> `commit` -> `applyGateChanges`, which writes the gates.
 * The two directions do not fight: one runs once at boot, the other only on a
 * value the account actually chose.
 */
function reconcileWithGates(loaded: TableUserSettings): TableUserSettings {
  /* IT MAY ONLY TURN THINGS OFF.
     `isSoundAllowed()` and `isVibrationPreferred()` both return TRUE when their
     keys are absent — "no recorded preference", not "the user chose on". A
     first version adopted the answer in both directions, which meant that on any
     browser holding a muted blob and no gate keys, boot would force the blob to
     `true` and `applySideEffects` would persist that over the stored `false` on
     the very next line: a muted player un-muted, and the record of the mute
     destroyed. The gates are authoritative about a MUTE, which is the direction
     they fail closed in; silence from them is not consent. */
  const patch: Partial<TableUserSettings> = {};
  if (loaded.isSoundEnabled && !isSoundAllowed()) patch.isSoundEnabled = false;
  if (loaded.isHapticEnabled && !isVibrationPreferred()) patch.isHapticEnabled = false;
  return Object.keys(patch).length === 0 ? loaded : { ...loaded, ...patch };
}

function getSnapshot(): TableUserSettings {
  if (sharedSettings === null) {
    sharedSettings = reconcileWithGates(loadFromStorage());
    applySideEffects(sharedSettings);
    /* And push the volume, which has no gate of its own — the engine's default
       is 0.7 and the store's may be anything. Sound and haptics are already
       correct by construction one line above. */
    soundService.setMasterVolume(Math.max(0, Math.min(100, sharedSettings.soundVolume)) / 100);
  }
  return sharedSettings;
}

/**
 * Reach the two things that are NOT this store: the sound engine and the
 * vibration gate.
 *
 * ON CHANGE ONLY, and from `commit` rather than from one call site, so it covers
 * every route a value can take — a local toggle, `updateSettings`, a reset, a
 * cross-TAB bus echo, and a cross-DEVICE `sound_enabled` relayed by
 * PostgresSyncHooks. That last one is why this exists at all: `isSoundEnabled`
 * was persisted here, mirrored to a column, and synced across devices, and
 * NOTHING read it back to the audio engine. Muting on your phone updated a
 * database column and left your laptop playing.
 *
 * Not in `applySideEffects`, which also runs on the first snapshot: stamping the
 * gate keys from a freshly-loaded blob is the second-writer bug documented above
 * it.
 */
function applyGateChanges(prev: TableUserSettings | null, next: TableUserSettings): void {
  if (!prev || prev.isSoundEnabled !== next.isSoundEnabled) {
    soundService.setEnabled(next.isSoundEnabled);
  }
  if (!prev || prev.isHapticEnabled !== next.isHapticEnabled) {
    setVibrationAllowed(next.isHapticEnabled);
  }
  /* Master volume has ONE owner, and as of 2026-08-29 that is finally true.
     `SoundService.restoreStoredConfig` used to set it at boot from a
     localStorage key nothing has ever written; a TablePage effect set it on
     every mount of every one of six tables; the settings-panel handler set it
     again right after calling `updateSetting`, which had already applied it;
     and SettingsPage did the same on save. All four derived it from this store,
     so nothing ever visibly disagreed — which is exactly why four copies
     accumulated behind a comment claiming there was one. They are gone. The
     store is the owner because it is the copy that is user-scoped and follows
     the account across devices. 0-100 here, 0-1 in the engine — the unit
     conversion is the reason it must live in one place. */
  if (!prev || prev.soundVolume !== next.soundVolume) {
    soundService.setMasterVolume(Math.max(0, Math.min(100, next.soundVolume)) / 100);
  }
}

/** Replace the one copy, persist it, apply it, and wake every consumer. */
function commit(update: (prev: TableUserSettings) => TableUserSettings): void {
  const previous = sharedSettings;
  const next = update(getSnapshot());
  if (next === sharedSettings) return;
  sharedSettings = next;
  applySideEffects(next);
  applyGateChanges(previous, next);
  for (const listener of listeners) listener();
}

function subscribeToStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * WHO EMITTED THIS — an identity, not a latch. Module-level now, because the
 * store is: one store, one origin. Shaped as a `.current` box deliberately, so
 * the emits below keep reading `origin: originIdRef.current` — the property
 * `tests/unit/settingsEchoOrigin.test.ts` pins, for the reasons its header
 * gives at length.
 */
const originIdRef = { current: `ts-${Math.random().toString(36).slice(2)}` };

/**
 * ONE bus subscription for the whole app, attached on first use.
 *
 * Previously every hook instance subscribed, so a cross-tab change woke eight
 * handlers that each mutated their own copy. Now it wakes the single store.
 */
let busAttached = false;
function attachBusOnce(): void {
  if (busAttached) return;
  busAttached = true;
  masterBus.subscribe('SETTINGS_CHANGED', (event) => {
    // Skip only OUR OWN echo (prevent a redundant commit).
    if (event.payload?.origin === originIdRef.current) return;
    const activeUserId = useUserStore.getState().user?.id;
    if (event.payload.userId && event.payload.userId !== activeUserId) return;
    /* An event can name the setting two ways. Another TAB emits the camelCase
       key; `PostgresSyncHooks` relays a row change from ANOTHER DEVICE and
       names the COLUMN. Both are this setting — translate before matching, or
       cross-device changes arrive and are silently discarded. */
    const rawSetting = event.payload.setting as string | undefined;
    /* `own()`, not `in`. `'constructor' in DEFAULT_SETTINGS` is TRUE — `in`
       walks the prototype chain — so the whitelist admitted every Object
       member and would have spread one straight into the settings object. */
    const setting =
      rawSetting && isSettingKey(rawSetting) ? rawSetting : KEY_FOR_COLUMN[rawSetting ?? ''];
    const { value } = event.payload;
    if (setting && isSettingKey(setting)) {
      commit((prev) => ({
        ...prev,
        [setting]: value,
        // SHOWDOWN AUDIT 2026-08-25: cross-tab autoMuck toggles are just as
        // deliberate as local ones — mark them explicit too, or the other
        // tab's loader would lift the user's own choice back to true.
        ...(setting === 'autoMuck' ? { autoMuckExplicit: true } : {}),
      }));
    }
  });
}

/**
 * Persist ONE key to the user's row.
 *
 * A per-key upsert, matching how `useUserTableSettings` writes the same table.
 * That shape carries a known hazard — for a user with NO row it inserts one and
 * every other column takes its SQL default — which is why the migration that
 * added these columns sets each default to the matching value in
 * `DEFAULT_SETTINGS` and asserts the pairing, and why
 * tests/user-table-settings-defaults.test.ts pins them.
 *
 * Fire-and-forget by design: the local store and localStorage have already been
 * updated, so a failed write costs the CROSS-DEVICE copy, not the setting. It
 * deliberately does NOT roll the switch back — reverting a control the user just
 * set, because a network call failed, is the exact behaviour Dan ruled out
 * ("NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM MANUALLY").
 * The next change, or the next sign-in, reconciles it.
 */
function pushKeyToServer(key: keyof TableUserSettings, value: unknown): void {
  const column = COLUMN_FOR_KEY[key];
  if (!column || !hydratedUserId) return;
  /* `.then(onFulfilled)` with ONE argument handles fulfilment only, and a
     PostgREST builder REJECTS on transport failure (offline, DNS, aborted
     fetch) rather than resolving with an `error`. So every settings change made
     with the connection down produced an unhandled rejection and reached
     telemetry through neither branch: the reportError below sits on the path
     that was never taken. Fire-and-forget must still catch. */
  void (async () => {
    try {
      const { error } = await supabase
        .from('user_table_settings')
        .upsert({ user_id: hydratedUserId, [column]: value }, { onConflict: 'user_id' });
      if (error) {
        reportError(error, 'useTableSettings.Save_failed');
        return;
      }
      await markSettingsTouched([column]);
    } catch (error) {
      reportError(error, 'useTableSettings.Save_failed');
    }
  })();
}

/**
 * Record that the user CHOSE these columns, so hydration stops having to guess
 * from the value. Best-effort and deliberately never surfaced: the setting is
 * already saved, and the worst case of a lost mark is that this account keeps
 * the pre-2026-08-29 inference for that one column until the next write.
 *
 * Shared with `useUserTableSettings`, which writes different columns of the same
 * row — one marker for one table, or the two hooks would disagree about which
 * half of a user's settings were deliberate.
 */
export async function markSettingsTouched(columns: string[]): Promise<void> {
  if (columns.length === 0) return;
  try {
    /* BOUNDED, because `useUserTableSettings` awaits this INSIDE its ordered
       write queue: the promise it returns is what the next tap of the same
       switch chains behind. A `supabase.rpc` on a hung connection never
       settles, so without a ceiling one stalled call would block that switch
       from ever reaching the server again — silently, because the optimistic
       UI has already flipped and the player sees nothing until they reload.
       Losing the mark costs that one column the pre-2026-08-29 inference until
       the next write; losing the queue costs the setting. */
    const result = await Promise.race([
      supabase.rpc('fn_mark_table_setting_touched', { p_columns: columns }),
      new Promise<{ error: unknown }>((resolve) =>
        setTimeout(
          () => resolve({ error: new Error('fn_mark_table_setting_touched timed out') }),
          TOUCH_MARK_TIMEOUT_MS
        )
      ),
    ]);
    if (result.error) reportError(result.error, 'useTableSettings.Touch_mark_failed');
  } catch (error) {
    reportError(error, 'useTableSettings.Touch_mark_failed');
  }
}

/**
 * Adopt the signed-in user's row.
 *
 * MERGE, NOT REPLACE, and the direction matters. A player who has been using
 * this browser signed out — or signed in before these columns existed — has
 * real preferences in localStorage and a row full of defaults. Overwriting the
 * former with the latter would look exactly like every setting resetting itself
 * on login.
 *
 * So the row wins only where it actually differs from the column default: that
 * is the signal the value was CHOSEN. Anything still at its default is left to
 * the local value, and any local value the server has never seen is pushed up,
 * which is what carries a returning player's existing settings onto their
 * account the first time they sign in after this ships.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHOSE PREFERENCES ARE IN THIS BROWSER?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-29. `hydrateFromServer` pushes a local value UP when the account has
 * no opinion on it, which is what carries a returning player's existing
 * settings onto their account the first time they sign in after these columns
 * shipped. On a personal device that is exactly right.
 *
 * On a SHARED one it was account contamination. Person A mutes sound and signs
 * out; sound settings deliberately survive a sign-out (`clearUserCaches` keeps
 * device preferences — "a sign-out is not a factory reset", and there is a test
 * pinning that). Person B signs in, their row is all defaults, so every one of
 * A's choices was written into B's ACCOUNT and followed B to their phone. Not
 * a stale local copy: a permanent, cross-device edit to someone else's
 * settings, made by nobody.
 *
 * The discriminator is ownership, recorded here. The upward push is allowed
 * when this browser's settings are UNCLAIMED — the pre-existing blob the
 * migration exists to rescue — or already claimed by the user signing in. It
 * is refused when they belong to somebody else.
 *
 * The claim is written on the FIRST hydrate of any user, so the unclaimed
 * window is one sign-in per browser, which is the smallest it can be while
 * still letting the migration happen at all.
 *
 * NOT PURGED ON SIGN-OUT, deliberately. `clearUserCaches` would be the obvious
 * place, and putting it there would clear the claim and re-open the window on
 * every sign-out — precisely the case this guards.
 */
export const TABLE_SETTINGS_OWNER_KEY = 'ca_table_settings_owner';

function localSettingsOwner(): string | null {
  try {
    return localStorage.getItem(TABLE_SETTINGS_OWNER_KEY);
  } catch {
    return null; // private mode: treat as unknown, and refuse below
  }
}

function claimLocalSettings(userId: string): void {
  try {
    localStorage.setItem(TABLE_SETTINGS_OWNER_KEY, userId);
  } catch {
    /* private mode */
  }
}

async function hydrateFromServer(userId: string): Promise<void> {
  const columns = [...Object.values(COLUMN_FOR_KEY), TOUCHED_COLUMN].join(', ');
  let row: Record<string, unknown> | null = null;
  try {
    const { data, error } = await supabase
      .from('user_table_settings')
      .select(columns)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    row = (data as Record<string, unknown> | null) ?? null;
  } catch (error) {
    /* Unreadable is UNKNOWN, never "defaults". Keep the cached values and try
       again on the next sign-in; a settings panel that empties itself because
       one read timed out is worse than one that is briefly device-local. */
    reportError(error, 'useTableSettings.Hydrate_failed');
    return;
  }

  if (hydratedUserId !== userId) return; // signed out or switched mid-flight

  const local = getSnapshot();
  const merged: TableUserSettings = { ...local };
  const toPush: Array<[keyof TableUserSettings, unknown]> = [];
  let changed = false;

  /* May this browser's values be written into THIS account? See the note above
     TABLE_SETTINGS_OWNER_KEY. Unclaimed is the migration case; a claim by
     somebody else means these preferences are not this person's to inherit. */
  const owner = localSettingsOwner();
  const mayAdoptLocal = owner === null || owner === userId;
  claimLocalSettings(userId);

  /* WHICH COLUMNS THIS ACCOUNT ACTUALLY CHOSE.
     Until 2026-08-29 this was inferred as `serverValue !== DEFAULT`, which is
     wrong for every setting whose ON state IS the default: turn the ticker off
     on a laptop, back on from a phone, and the laptop reads the row's `true` as
     "never set" and pushes its stale `false` back up — the ticker turns itself
     off on both devices with nobody touching a control. The row now records the
     FACT of the choice (migration 20260829125943). */
  const touched = new Set(
    Array.isArray(row?.[TOUCHED_COLUMN]) ? (row[TOUCHED_COLUMN] as string[]) : []
  );

  for (const [key, column] of Object.entries(COLUMN_FOR_KEY) as Array<
    [keyof TableUserSettings, string]
  >) {
    const serverValue = row?.[column];
    if (row === null || serverValue === null || serverValue === undefined) {
      // No row, or a column this row predates: the local value is all there is.
      if (mayAdoptLocal && local[key] !== DEFAULT_SETTINGS[key]) toPush.push([key, local[key]]);
      continue;
    }
    if (locallyTouched.has(key)) continue; // a live edit outranks a stale read

    if (touched.has(column)) {
      // PostgREST returns `numeric` as a string; see coerceToDefaultType.
      const adopted = coerceToDefaultType(key, serverValue);
      if (merged[key] !== adopted) {
        (merged as unknown as Record<string, unknown>)[key] = adopted;
        changed = true;
      }
    } else if (mayAdoptLocal && local[key] !== DEFAULT_SETTINGS[key]) {
      // The account has never chosen this; carry this browser's choice up to it.
      toPush.push([key, local[key]]);
    }
  }

  if (changed) commit(() => merged);
  for (const [key, value] of toPush) pushKeyToServer(key, value);
}

/**
 * Follow the signed-in user. Called from the hook so it runs inside React's
 * lifecycle, but guarded so the work happens ONCE per user rather than once per
 * mounted table.
 */
function syncToUser(userId: string | null): void {
  if (userId === hydratedUserId) return;
  hydratedUserId = userId;
  locallyTouched.clear();
  if (userId) void hydrateFromServer(userId);
}

/**
 * TEST SEAM. The store is a module singleton, so a suite that wants to assert
 * load-time behaviour has to be able to forget it — the same way it already
 * clears localStorage between cases.
 */
export function __resetTableSettingsStoreForTest(): void {
  sharedSettings = null;
  listeners.clear();
  hydratedUserId = null;
  locallyTouched.clear();
  busAttached = false;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ONE WRITER, AVAILABLE WITHOUT MOUNTING THE HOOK
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This was the body of `updateSetting`, trapped inside the hook. Every surface
 * that could not conveniently call a hook therefore hand-rolled its own
 * half-write instead — and on 2026-08-29 an audit found FOUR of them for sound
 * alone (the bus `TOGGLE_SOUNDS` branch, the quick-actions bar, the table menu
 * and the side menu), each calling `setIsSoundEnabled` and stopping. The result
 * was that muting from anywhere except the settings panel never reached the
 * store, never reached `user_table_settings.sound_enabled`, and so never
 * followed the account to another device — while the panel went on showing
 * Sound ON.
 *
 * Hoisting it costs nothing (the body only ever touched module-level state) and
 * removes the reason to write a fifth copy.
 */
export function setTableSetting<K extends keyof TableUserSettings>(
  key: K,
  value: TableUserSettings[K]
): void {
  /* The hook subscribes on render; this entry point has to do it itself, or a
     caller that reached the store WITHOUT mounting `useTableSettings` would
     commit and broadcast while never listening for anybody else's changes.
     Idempotent by design — that is what the `busAttached` latch is for. Today
     TablePage mounts both hooks so it cannot happen; leaving the two doors into
     one store with different behaviour is how it would start. */
  attachBusOnce();
  commit((prev) => ({
    ...prev,
    [key]: value,
    // SHOWDOWN AUDIT 2026-08-25: a personal autoMuck toggle is the ONLY
    // thing that makes a stored false authoritative — see the loader.
    ...(key === 'autoMuck' ? { autoMuckExplicit: true } : {}),
  }));
  // Broadcast for cross-TAB sync. Within this tab the shared store above
  // has already updated every consumer, so a dropped message costs nothing.
  masterBus.emit('SETTINGS_CHANGED', {
    setting: key,
    value: value as string | number | boolean,
    origin: originIdRef.current,
  });
  // …and up to the user's row, for cross-DEVICE.
  locallyTouched.add(key);
  pushKeyToServer(key, value);
  if (key === 'autoMuck') {
    // The explicit marker is what makes a stored OFF authoritative, so it
    // has to travel with the setting rather than staying in one browser.
    locallyTouched.add('autoMuckExplicit');
    pushKeyToServer('autoMuckExplicit', true);
  }
}

export function useTableSettings() {
  attachBusOnce();
  const settings = useSyncExternalStore(subscribeToStore, getSnapshot, getSnapshot);

  /* Adopt the signed-in user's row when auth resolves.
     `syncToUser` is a no-op unless the id actually changed, so this costs one
     comparison per render even with six tables mounted — and the hydrate itself
     happens once per user, not once per table. */
  const userId = useUserStore((state) => state.user?.id ?? null);
  useEffect(() => {
    syncToUser(userId);
  }, [userId]);

  // Update a single setting by key
  const updateSetting = useCallback(setTableSetting, []);

  // Reset all settings to defaults
  const resetSettings = useCallback(() => {
    commit(() => DEFAULT_SETTINGS);
    // Broadcast each default for cross-tab sync
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      masterBus.emit('SETTINGS_CHANGED', {
        setting: key,
        value: value as string | number | boolean,
        origin: originIdRef.current,
      });
      /* A reset is a manual choice, so it travels to the row like any other.
         Marked locally-touched too, or an in-flight hydrate could answer with
         the pre-reset values and undo it. */
      locallyTouched.add(key as keyof TableUserSettings);
      pushKeyToServer(key as keyof TableUserSettings, value);
    }
  }, []);

  // Bulk update multiple settings at once
  const updateSettings = useCallback((updates: Partial<TableUserSettings>) => {
    commit((prev) => ({
      ...prev,
      ...updates,
      // SHOWDOWN AUDIT 2026-08-25: same rule as updateSetting — an autoMuck
      // value arriving through the bulk path is a user action too.
      ...('autoMuck' in updates ? { autoMuckExplicit: true } : {}),
    }));
    // Broadcast each change for cross-tab sync
    for (const [key, value] of Object.entries(updates)) {
      masterBus.emit('SETTINGS_CHANGED', {
        setting: key,
        value: value as string | number | boolean,
        origin: originIdRef.current,
      });
      locallyTouched.add(key as keyof TableUserSettings);
      pushKeyToServer(key as keyof TableUserSettings, value);
    }
    if ('autoMuck' in updates) {
      locallyTouched.add('autoMuckExplicit');
      pushKeyToServer('autoMuckExplicit', true);
    }
  }, []);

  return {
    settings,
    updateSetting,
    updateSettings,
    resetSettings,
  };
}
