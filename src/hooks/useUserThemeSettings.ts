/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useUserThemeSettings — Bible V8 §11.2 Theme Persistence Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Loads the user's theme selections from `user_theme_settings` and keeps them
 * live: a save made anywhere in the app repaints every mounted table at once.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * AUDIT 2026-08-25 — three defects, all of which read to a player as "my theme
 * did not save". Production held 2 rows across 1,025 users when this was found.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * 1. THE ROW WAS WRITTEN INTO A BUCKET THIS READER NEVER LOOKED IN.
 *    `user_theme_settings` is keyed UNIQUE(user_id, game_type), and this hook
 *    only ever asked for the CANONICAL bucket ('ALL' | 'NLH' | '6+' | 'PLO' |
 *    'PINEAPPLE' | 'MTT' | 'SNG'). But production carries a row keyed
 *    `game_type = 'plo4'` — a RAW variant string, saved by a writer that passed
 *    the variant straight through. Canonicalising 'plo4' gives 'PLO', so the
 *    lookup missed, fell through to the 'ALL' row, and the player's PLO choice
 *    was invisible forever while sitting safely in the table.
 *
 *    Fixed by reading the user's rows ONCE and resolving in-memory:
 *      exact canonical match  >  a row that CANONICALISES to the same bucket
 *                             >  the 'ALL' row.
 *    One round trip instead of two, and every raw-variant row already in the
 *    database starts working without a migration. `canonicalGameType` is
 *    exported so the WRITE side can be keyed the same way at source.
 *
 * 2. THE LIVE LISTENER WAS NEVER ATTACHED AT A TOURNAMENT.
 *    The `UI_THEME_CHANGED` subscription lived below `if (isTournament &&
 *    !tournamentType) return;`. That early return exists for a good reason (see
 *    the note on the load effect), but it also skipped the subscribe — so at
 *    any tournament table whose format had not resolved yet, a theme saved
 *    mid-session did not apply until a remount. The subscription is now its own
 *    effect and always attaches.
 *
 * 3. A FAILED QUERY RENDERED AS A CONFIDENT DEFAULT.
 *    supabase-js RETURNS errors, it does not throw. The old code checked
 *    `!error && data`, then silently proceeded to the fallback and finally to
 *    DEFAULT_THEME with `loading: false` and no signal at all. "We could not
 *    reach the database" and "you have never picked a theme" produced the exact
 *    same screen. `error` is now returned so callers can tell them apart.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * FIX 2026-08-28 — THE FIRST FRAMES SHOWED SOMEBODY ELSE'S TABLE.
 * ───────────────────────────────────────────────────────────────────────────────
 * State began at DEFAULT_THEME on every mount and the saved theme arrived only
 * after a network round trip, so EVERY table open flashed the default felt,
 * background, buttons and deck for a split second before snapping to the
 * player's choice. A second flash source: the bucket re-resolves when the
 * table's game type arrives from the server, repainting again mid-open.
 *
 * Fixed by caching the user's theme ROWS (the same shape the query returns) in
 * localStorage, keyed per user. The first render resolves synchronously from
 * that cache through the SAME pickThemeRow precedence the network path uses,
 * so the first frame already wears the saved theme — across navigation, page
 * changes and refreshes. The database remains the source of truth: every
 * successful load overwrites the cache, and every live UI_THEME_CHANGED
 * application is merged into it so a refresh immediately after a change still
 * first-paints the new selection. A cold cache (first visit on a device) shows
 * the defaults exactly once, then never again.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { getLocalStorage, setLocalStorage } from '../lib/storage';
import { recordCustomizationOperation } from '../services/CustomizationOperationsTelemetry';

export interface UserThemeSelection {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

export const THEME_FIELDS = [
  'theme_id',
  'table_id',
  'button_id',
  'background_id',
  'cards_id',
] as const;

const DEFAULT_THEME: UserThemeSelection = {
  theme_id: 'default-dark',
  // Must match the database default. A first partial upsert fills untouched
  // columns from schema defaults; disagreement here made a card-back-only
  // change swap the felt underneath a brand-new player on the database echo.
  table_id: 'classic_green',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

/** The only values `user_theme_settings.game_type` may be keyed on. */
export const CANONICAL_GAME_TYPES = ['ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'] as const;

export type CanonicalGameType = (typeof CANONICAL_GAME_TYPES)[number];

/**
 * Maps a game variant string to a theme game type. Categories match the
 * platform's approved variants only — FIX 116 removed FLH / FLO / MIXED, so
 * those branches are gone (they could never match a selectable game type).
 * Approved: ALL | NLH | 6+ (short deck) | PLO | PINEAPPLE | MTT | SNG.
 */
export function getThemeGameType(
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
): CanonicalGameType {
  if (isTournament) {
    if (tournamentType === 'sng' || tournamentType === 'spin') return 'SNG';
    return 'MTT';
  }
  const v = (gameVariant || '').toLowerCase();
  if (v.includes('nlh') || v === 'no_limit_holdem') return 'NLH';
  if (v.includes('short') || v.includes('6+')) return '6+';
  if (v.includes('pineapple')) return 'PINEAPPLE';
  if (v.includes('plo')) return 'PLO';
  return 'ALL';
}

/**
 * The bucket a stored `game_type` BELONGS to.
 *
 * A value already canonical is returned untouched — importantly '6+', which
 * getThemeGameType would otherwise read as a variant string and, since it
 * contains '6+', happens to answer '6+' anyway; the explicit check means that
 * is by decision rather than by luck. Anything else (a raw variant such as
 * 'plo4', 'nlh6', 'shortdeck') is canonicalised.
 *
 * Exported so the WRITE side can key rows with the same function this reader
 * uses. A writer and a reader that disagree about the key is defect 1 above.
 */
export function canonicalGameType(stored: string | null | undefined): CanonicalGameType {
  const raw = (stored || '').trim();
  if (!raw) return 'ALL';
  const upper = raw.toUpperCase();
  if ((CANONICAL_GAME_TYPES as readonly string[]).includes(upper)) {
    return upper as CanonicalGameType;
  }
  return getThemeGameType(raw);
}

/**
 * The bucket this table's theme should be read from, or NULL when it is not
 * knowable yet.
 *
 * A tournament whose FORMAT has not resolved must not resolve a theme.
 * getThemeGameType answers 'MTT' for anything it cannot identify, so resolving
 * here would paint the player's MTT felt at a Spin and then swap it under them
 * a moment later when the format arrives. Waiting costs a few hundred
 * milliseconds of the default theme, which is what the first frames show
 * anyway; guessing costs a visible change of table mid-sit.
 *
 * This used to be an inline `if (isTournament && !tournamentType) return;` in
 * the load effect, and two test files pinned it by grepping for that exact
 * line. A guard worth keeping is worth asserting as BEHAVIOUR, so it is a
 * function now and those tests call it.
 */
export function resolveThemeBucket(
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
): CanonicalGameType | null {
  if (isTournament && !tournamentType) return null;
  return getThemeGameType(gameVariant, isTournament, tournamentType);
}

type ThemeRow = Partial<UserThemeSelection> & {
  game_type?: string | null;
  /** Row timestamp — lets a NEWER 'Apply To: ALL' save beat an older
   *  per-variant row (Dan 2026-08-28, see pickThemeRow). */
  updated_at?: string | null;
};

/** Fill every field, so a row with a NULL column cannot blank the felt. */
function toSelection(row: ThemeRow): UserThemeSelection {
  return {
    theme_id: row.theme_id || DEFAULT_THEME.theme_id,
    table_id: row.table_id || DEFAULT_THEME.table_id,
    button_id: row.button_id || DEFAULT_THEME.button_id,
    background_id: row.background_id || DEFAULT_THEME.background_id,
    cards_id: row.cards_id || DEFAULT_THEME.cards_id,
  };
}

/**
 * exact bucket  >  a row that canonicalises INTO the bucket  >  the 'ALL' row
 * — EXCEPT that a strictly NEWER 'ALL' row beats a stale bucket row.
 *
 * Dan 2026-08-28 ("settings need to update and refresh in real time"): the
 * Theme Studio's Apply-To selector defaults to 'ALL', and the live listener
 * applies an ALL save to every mounted table — but this resolver used to
 * prefer any per-variant row unconditionally, so a player who once saved an
 * NLH row watched their new everywhere-theme take effect and then VANISH on
 * the next rejoin. Last write wins now: whichever of the bucket row and the
 * ALL row was saved most recently is the player's current intent. A bucket
 * row still wins ties and rows with no timestamp, which is exactly the old
 * precedence — the fixtures that pin it carry no updated_at.
 *
 * Exported for the test that pins the 'plo4' recovery, and because the same
 * precedence has to hold anywhere else this table is read.
 */
export function pickThemeRow(rows: ThemeRow[], gameType: CanonicalGameType): ThemeRow | null {
  if (!rows.length) return null;
  const allRow = rows.find((r) => (r.game_type || '') === 'ALL') ?? null;
  // The alias step is deliberately NOT applied to 'ALL'. canonicalGameType
  // answers 'ALL' for anything it does not recognise, so allowing it here
  // would let a row keyed on junk ('', 'not_a_variant', a typo) become the
  // player's global default — the everywhere-bucket must be claimed by a
  // literal 'ALL' row and nothing else.
  const bucketRow =
    rows.find((r) => (r.game_type || '') === gameType) ??
    (gameType !== 'ALL'
      ? (rows.find(
          (r) => (r.game_type || '') !== 'ALL' && canonicalGameType(r.game_type) === gameType
        ) ?? null)
      : null);
  if (bucketRow && allRow && bucketRow !== allRow) {
    const bucketTs = Date.parse(bucketRow.updated_at || '') || 0;
    const allTs = Date.parse(allRow.updated_at || '') || 0;
    return allTs > bucketTs ? allRow : bucketRow;
  }
  return bucketRow ?? allRow;
}

/* ─── One read per burst, not one per table (perf, 2026-08-28) ──────────────
 *
 * Up to FOUR TablePages are mounted at once inside the persistent table
 * layer, and each one calls this hook. The query below is keyed on `user_id`
 * ALONE — the bucket is resolved in memory by `pickThemeRow` — so four
 * mounts issued four byte-identical queries for the same user on every table
 * open. This is the same amplification #1601 fixed for `user_table_settings`,
 * in the hook right next door; the remedy is copied from it deliberately,
 * down to the reasoning.
 *
 * THE CACHE IS THE IN-FLIGHT PROMISE, NOT THE RESULT. It is dropped as soon
 * as it settles, so this can only ever collapse a burst of simultaneous
 * mounts. A table opened later still reads the database, and a theme write is
 * never served a stale row. No TTL to tune, no invalidation to forget.
 */
const themeRowsQuery = (userId: string) =>
  supabase
    .from('user_theme_settings')
    .select('game_type, theme_id, table_id, button_id, background_id, cards_id, updated_at')
    .eq('user_id', userId);

type ThemeRowsResult = Awaited<ReturnType<typeof themeRowsQuery>>;

const inFlightThemeReads = new Map<string, Promise<ThemeRowsResult>>();

export function fetchUserThemeRows(userId: string): Promise<ThemeRowsResult> {
  const existing = inFlightThemeReads.get(userId);
  if (existing) return existing;

  // `Promise.resolve` because a PostgREST builder is a THENABLE, not a
  // Promise: it has `.then` but no `.catch`/`.finally`, so it cannot be
  // stored or awaited as one.
  const p = Promise.resolve(themeRowsQuery(userId)).then(
    (res) => {
      inFlightThemeReads.delete(userId);
      return res;
    },
    (err) => {
      // Drop on rejection too, or one network blip wedges every future mount
      // onto a permanently failed promise.
      inFlightThemeReads.delete(userId);
      throw err;
    }
  );

  inFlightThemeReads.set(userId, p);
  return p;
}

/** Test seam: prove the de-duplication rather than assume it. */
export function __inFlightThemeReadCount(): number {
  return inFlightThemeReads.size;
}

/* ─── First-paint cache (2026-08-28) ────────────────────────────────────────
   Rows, not a resolved selection: caching the rows lets a bucket change (the
   game type arriving, or navigating NLH -> PLO without a remount) re-resolve
   synchronously through pickThemeRow instead of waiting on the network. */

const THEME_ROWS_CACHE_PREFIX = 'ca_user_theme_rows:';

export type UserThemeRealtimeState = 'local' | 'connecting' | 'live' | 'error';

type ThemeRealtimeListener = (
  state: Exclude<UserThemeRealtimeState, 'local'>,
  recovered: boolean
) => void;

type ThemeRealtimeEntry = {
  refs: number;
  channel: ReturnType<typeof supabase.channel> | null;
  state: Exclude<UserThemeRealtimeState, 'local'>;
  listeners: Set<ThemeRealtimeListener>;
  everLive: boolean;
  generation: number;
  errorStartedAt: number | null;
};

const themeRealtimeByUser = new Map<string, ThemeRealtimeEntry>();

function notifyThemeRealtime(entry: ThemeRealtimeEntry, recovered = false): void {
  entry.listeners.forEach((listener) => listener(entry.state, recovered));
}

function startThemeRealtime(userId: string, entry: ThemeRealtimeEntry): void {
  entry.generation += 1;
  const generation = entry.generation;
  entry.state = 'connecting';
  notifyThemeRealtime(entry);

  const channel = supabase
    .channel(`user-theme-settings:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'user_theme_settings',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        if (entry.generation !== generation || themeRealtimeByUser.get(userId) !== entry) return;
        if (payload.eventType === 'DELETE') {
          // Deleting a per-game row does not mean "paint defaults"; it means
          // resolve the remaining rows again (usually falling back to ALL).
          // Realtime carries no replacement row, so use the same authoritative
          // reconciliation path as a recovered connection.
          notifyThemeRealtime(entry, true);
          return;
        }
        const raw = payload.new as ThemeRow;
        if (!raw || typeof raw !== 'object') return;
        const value = Object.fromEntries(
          THEME_FIELDS.flatMap((field) =>
            typeof raw[field] === 'string' && raw[field] ? [[field, raw[field]]] : []
          )
        );
        masterBus.emit('UI_THEME_CHANGED', {
          key: canonicalGameType(raw.game_type),
          value,
          userId,
          updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
        });
      }
    )
    .subscribe((status) => {
      if (entry.generation !== generation || themeRealtimeByUser.get(userId) !== entry) return;
      if (status === 'SUBSCRIBED') {
        const recovered = entry.everLive && entry.state !== 'live';
        const firstAuthoritativeHandoff = !entry.everLive;
        if (recovered) {
          recordCustomizationOperation({
            userId,
            event: 'realtime_recovered',
            surface: 'table-runtime',
            category: 'appearance',
            durationMs: entry.errorStartedAt ? Date.now() - entry.errorStartedAt : undefined,
            reasonCode: 'channel_resubscribed',
          });
        }
        entry.state = 'live';
        entry.everLive = true;
        entry.errorStartedAt = null;
        // Close the initial SELECT -> SUBSCRIBE gap as well as an actual
        // reconnect gap. Realtime does not replay a row committed between the
        // first read and its acknowledgement, so every successful handoff gets
        // one authoritative reconciliation before relying on events.
        notifyThemeRealtime(entry, recovered || firstAuthoritativeHandoff);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (entry.state !== 'error') {
          entry.errorStartedAt = Date.now();
          recordCustomizationOperation({
            userId,
            event: 'realtime_failed',
            surface: 'table-runtime',
            category: 'appearance',
            reasonCode: status.toLowerCase(),
          });
        }
        entry.state = 'error';
        notifyThemeRealtime(entry);
      }
    });
  entry.channel = channel;
}

/** One database channel per account, even when four persistent tables mount. */
function acquireThemeRealtime(userId: string, listener: ThemeRealtimeListener): () => void {
  const existing = themeRealtimeByUser.get(userId);
  if (existing) {
    existing.refs += 1;
    existing.listeners.add(listener);
    listener(existing.state, false);
    return () => releaseThemeRealtime(userId, listener);
  }

  // Several unit suites intentionally provide a minimal PostgREST-only mock.
  if (typeof (supabase as { channel?: unknown }).channel !== 'function') {
    listener('error', false);
    return () => undefined;
  }

  const entry: ThemeRealtimeEntry = {
    refs: 1,
    channel: null,
    state: 'connecting',
    listeners: new Set([listener]),
    everLive: false,
    generation: 0,
    errorStartedAt: null,
  };
  themeRealtimeByUser.set(userId, entry);
  startThemeRealtime(userId, entry);
  return () => releaseThemeRealtime(userId, listener);
}

function releaseThemeRealtime(userId: string, listener: ThemeRealtimeListener): void {
  const entry = themeRealtimeByUser.get(userId);
  if (!entry) return;
  entry.listeners.delete(listener);
  entry.refs -= 1;
  if (entry.refs > 0) return;
  themeRealtimeByUser.delete(userId);
  entry.generation += 1;
  if (entry.channel) void supabase.removeChannel(entry.channel);
}

export function __themeRealtimeChannelCount(): number {
  return themeRealtimeByUser.size;
}

/**
 * Shared health + recovery handle for the account-scoped table-art channel.
 * A recovered channel increments `reconciliationRevision`: callers use that
 * revision to re-read the authoritative rows because Realtime does not replay
 * changes that occurred while the device was offline.
 */
export function useUserThemeRealtime(
  userId: string | null | undefined,
  enabled = true
): {
  state: UserThemeRealtimeState;
  reconciliationRevision: number;
  retry: () => void;
} {
  const [state, setState] = useState<UserThemeRealtimeState>(
    userId && enabled ? (themeRealtimeByUser.get(userId)?.state ?? 'connecting') : 'local'
  );
  const [reconciliationRevision, setReconciliationRevision] = useState(0);

  useEffect(() => {
    if (!userId || !enabled) {
      setState('local');
      return undefined;
    }
    const listener: ThemeRealtimeListener = (next, recovered) => {
      setState(next);
      if (recovered) setReconciliationRevision((revision) => revision + 1);
    };
    return acquireThemeRealtime(userId, listener);
  }, [enabled, userId]);

  const retry = useCallback(() => {
    if (!userId || !enabled) return;
    const entry = themeRealtimeByUser.get(userId);
    if (!entry) return;
    const oldChannel = entry.channel;
    entry.generation += 1;
    entry.channel = null;
    if (oldChannel) void supabase.removeChannel(oldChannel);
    startThemeRealtime(userId, entry);
  }, [enabled, userId]);

  return { state, reconciliationRevision, retry };
}

function themeRowsCacheKey(userId: string): string {
  return `${THEME_ROWS_CACHE_PREFIX}${userId}`;
}

function readCachedThemeRows(userId: string | null | undefined): ThemeRow[] {
  if (!userId) return [];
  const rows = getLocalStorage<ThemeRow[]>(themeRowsCacheKey(userId), []);
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
}

function writeCachedThemeRows(userId: string | null | undefined, rows: ThemeRow[]): void {
  if (!userId) return;
  setLocalStorage(themeRowsCacheKey(userId), rows);
}

/**
 * The theme the first frame should wear, or null when nothing is cached yet.
 * Exported for the regression test that pins the no-flash first paint.
 */
export function resolveCachedTheme(
  userId: string | null | undefined,
  gameType: CanonicalGameType | null
): UserThemeSelection | null {
  if (!userId || !gameType) return null;
  const row = pickThemeRow(readCachedThemeRows(userId), gameType);
  return row ? toSelection(row) : null;
}

/** Merge a live appearance patch into the cached row for its bucket. */
function mergeCachedThemeRow(
  userId: string | null | undefined,
  bucket: CanonicalGameType,
  patch: Partial<UserThemeSelection>,
  updatedAt?: string
): void {
  if (!userId || (!Object.keys(patch).length && !updatedAt)) return;
  const rows = readCachedThemeRows(userId);
  const index = rows.findIndex((r) => (r.game_type || '') === bucket);
  if (index >= 0) {
    rows[index] = { ...rows[index], ...patch, ...(updatedAt ? { updated_at: updatedAt } : {}) };
  } else {
    rows.push({ game_type: bucket, ...patch, ...(updatedAt ? { updated_at: updatedAt } : {}) });
  }
  writeCachedThemeRows(userId, rows);
}

function sameSelection(a: UserThemeSelection, b: UserThemeSelection): boolean {
  return THEME_FIELDS.every((f) => a[f] === b[f]);
}

export function useUserThemeSettings(
  userId: string | null | undefined,
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
) {
  const [theme, setTheme] = useState<UserThemeSelection>(() => {
    // FIRST PAINT (2026-08-28): resolve synchronously from the cache so the
    // opening frame already wears the saved theme instead of flashing the
    // defaults for the length of a network round trip.
    const bucket = resolveThemeBucket(gameVariant, isTournament, tournamentType);
    return resolveCachedTheme(userId, bucket) ?? { ...DEFAULT_THEME };
  });
  const [loading, setLoading] = useState(true);
  /**
   * Non-null when the LOAD failed. `theme` still holds the defaults so the felt
   * paints, but a caller must never present those as "the player's choice" —
   * see defect 3 in the header.
   */
  const [error, setError] = useState<string | null>(null);
  const pendingMutationsRef = useRef(new Map<CanonicalGameType, Set<string>>());
  const realtime = useUserThemeRealtime(userId);

  /**
   * null while a tournament's format is unresolved: the bucket is not yet
   * knowable, and guessing is what the load effect refuses to do.
   */
  const gameType = useMemo<CanonicalGameType | null>(
    () => resolveThemeBucket(gameVariant, isTournament, tournamentType),
    [gameVariant, isTournament, tournamentType]
  );

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    // Null bucket: a tournament whose format has not arrived. Wait rather than
    // guess — see resolveThemeBucket for why.
    if (!gameType) return;

    // The bucket or account just changed (game type arrived, navigation
    // without a remount, login). Re-resolve from the cache SYNCHRONOUSLY so
    // the swap — if the buckets differ at all — happens this frame, not after
    // the round trip below.
    const cached = resolveCachedTheme(userId, gameType);
    if (cached) setTheme((prev) => (sameSelection(prev, cached) ? prev : cached));

    let mounted = true;

    const load = async () => {
      try {
        // ONE query for the user's rows — the table is UNIQUE(user_id,
        // game_type) over seven buckets, so this is a handful of rows at most,
        // and resolving in memory is both cheaper than the old two round trips
        // and the only way to see a row stored under a raw variant key.
        const { data, error: queryError } = await fetchUserThemeRows(userId);

        if (!mounted) return;

        if (queryError) {
          // A failed read is NOT "no theme saved". Say so and keep the
          // defaults on screen rather than reporting them as a selection.
          setError(queryError.message || 'Could not load theme settings');
          setLoading(false);
          return;
        }

        setError(null);
        // The database answered: it is the truth, and the cache follows it.
        // (Only a real array is cached — some test doubles resolve to nothing.)
        if (Array.isArray(data)) writeCachedThemeRows(userId, data as ThemeRow[]);
        const row = pickThemeRow((data as ThemeRow[]) || [], gameType);
        if (row) {
          const selection = toSelection(row);
          setTheme((prev) => (sameSelection(prev, selection) ? prev : selection));
        } else if (Array.isArray(data)) {
          // No row at all for this user: the seeded cache (possibly stale, a
          // row deleted from another device) must not outlive the truth.
          setTheme((prev) => (sameSelection(prev, DEFAULT_THEME) ? prev : { ...DEFAULT_THEME }));
        }
      } catch (err) {
        if (!mounted) return;
        console.warn('[useUserThemeSettings] Failed:', err);
        setError(err instanceof Error ? err.message : 'Could not load theme settings');
      }
      if (mounted) setLoading(false);
    };

    load();

    return () => {
      mounted = false;
    };
  }, [userId, gameType, realtime.reconciliationRevision]);

  useEffect(() => {
    // A persisted hook can survive logout/login in the same shell. Pending
    // writes belong to the old account and must never suppress the new
    // account's first realtime row.
    pendingMutationsRef.current.clear();
  }, [userId]);

  /**
   * Dan 2026-08-19: apply theme changes LIVE. The modal broadcasts the
   * selection the moment it saves; any table currently mounted (including ones
   * the player is only watching) repaints instantly instead of waiting for a
   * remount. A change saved against "ALL" applies to every game type; a
   * per-game-type change only applies to that type.
   *
   * AUDIT 2026-08-25: this used to live inside the load effect, BELOW the
   * unresolved-tournament early return — so at a tournament whose format had
   * not arrived yet, nothing was ever subscribed and live application silently
   * did not happen. Its own effect now, so it always attaches.
   */
  useEffect(() => {
    let mounted = true;

    const mutationOff = masterBus.subscribe('CUSTOMIZATION_MUTATION_STATE', (event) => {
      if (event.payload.kind !== 'table-appearance') return;
      const separator = event.payload.scope.lastIndexOf(':');
      if (separator < 0) return;
      const scopedUser = event.payload.scope.slice(0, separator);
      if (scopedUser !== (userId || 'guest')) return;
      const savedBucket = canonicalGameType(event.payload.scope.slice(separator + 1));
      if (savedBucket !== 'ALL' && (!gameType || savedBucket !== gameType)) return;
      if (event.payload.state === 'pending') {
        const pending = pendingMutationsRef.current.get(savedBucket) ?? new Set<string>();
        pending.add(event.payload.mutationId);
        pendingMutationsRef.current.set(savedBucket, pending);
      } else if (event.payload.state !== 'rolling-back') {
        const pending = pendingMutationsRef.current.get(savedBucket);
        pending?.delete(event.payload.mutationId);
        if (pending?.size === 0) pendingMutationsRef.current.delete(savedBucket);
        // The optimistic patch already updated the cached artwork. Only a
        // successful durable write may advance its precedence timestamp; doing
        // this on the first tap would make a failed ALL save outrank a valid
        // per-game row after refresh.
        if (event.payload.state === 'confirmed') {
          mergeCachedThemeRow(userId, savedBucket, {}, new Date().toISOString());
        }
      }
    });

    const off = masterBus.subscribe('UI_THEME_CHANGED', (event) => {
      // AUDIT 2026-08-19 (P0): masterBus hands subscribers the EVENT WRAPPER
      // ({ type, payload, timestamp }), not the raw payload. Reading .key/.value
      // off the wrapper always yielded undefined, so this listener returned early
      // on every emit and live theme application silently never worked.
      const body = (event as { payload?: unknown })?.payload ?? event;
      const savedFor = (body as { key?: string })?.key;
      const selection = (body as { value?: Partial<UserThemeSelection> })?.value;
      const eventUserId = (body as { userId?: string })?.userId;
      const mutationId = (body as { mutationId?: string })?.mutationId;
      const updatedAt = (body as { updatedAt?: string })?.updatedAt;
      if (!mounted || !selection) return;
      if (eventUserId && eventUserId !== userId) return;
      // AUDIT 2026-08-19: UI_THEME_CHANGED is a SHARED event — useSettingsStore
      // emits it as { key: 'theme', value: '<theme name string>' }. The gameType
      // guard below already rejects that, but spreading a string into the
      // selection object would produce garbage keys, so validate the shape
      // explicitly rather than relying on the guard alone.
      if (typeof selection !== 'object' || Array.isArray(selection)) return;
      if (!THEME_FIELDS.some((f) => f in selection)) return;

      // A change saved against "ALL" applies everywhere.
      const savedBucket = savedFor ? canonicalGameType(savedFor) : null;
      if (savedFor && savedFor !== 'ALL' && savedBucket !== 'ALL') {
        // While a tournament's format is unresolved this table has no bucket of
        // its own, so only an "ALL" save may touch it — the same refusal to
        // guess that the load effect makes.
        if (!gameType || savedBucket !== gameType) return;
      }

      /* Optimistic paints and rollbacks carry their mutation id and are always
         legitimate. A database echo carries none; suppress it while ANY write
         for that bucket is pending. Tracking a set (not only the newest id)
         also lets an older failed table-field mutation roll back while a newer
         button-field mutation is still saving. */
      if (savedBucket) {
        const pending = pendingMutationsRef.current.get(savedBucket);
        if (!mutationId && pending?.size) return;
      }

      // Only the five theme fields, never whatever else rode along on the bus.
      const clean: Partial<UserThemeSelection> = {};
      for (const field of THEME_FIELDS) {
        const value = (selection as Record<string, unknown>)[field];
        if (typeof value === 'string' && value) clean[field] = value;
      }
      if (!Object.keys(clean).length) return;

      setTheme((prev) => ({ ...prev, ...clean }));
      // Keep the first-paint cache current, so a page change or refresh
      // immediately after a change still opens wearing it — no flash back.
      mergeCachedThemeRow(userId, canonicalGameType(savedFor), clean, updatedAt);
    });

    return () => {
      mounted = false;
      mutationOff();
      try {
        off?.();
      } catch {
        /* listener already detached */
      }
    };
  }, [gameType, userId]);

  return {
    theme,
    loading,
    error,
    realtimeState: realtime.state,
    retryRealtime: realtime.retry,
  };
}
