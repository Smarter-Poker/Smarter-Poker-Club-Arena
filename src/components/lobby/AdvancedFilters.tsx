/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ADVANCED FILTERS — the per-game-type preferences sheet
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20, with seven reference screens: "preferences that need to be
 * enabled for all games."
 *
 * Renders whatever advancedFilterSpec declares for the active tab. Every
 * section is conditional on the SPEC, not on the game type, so the component
 * has no per-variant branches: Spin-It has no feature grid because its spec
 * carries none, Omaha has no games row for the same reason. Adding a variant
 * is a table entry there, not an edit here.
 *
 * PERSISTENCE. Choices are kept per club and per game type in localStorage.
 * A player's filters are a preference, not a session state - coming back to
 * the lobby and finding "Bomb Pot only" quietly forgotten is worse than
 * remembering it, provided the lobby SAYS it is filtering (the bar carries an
 * active dot, and Reset is one tap inside).
 *
 * localStorage can throw (Safari private mode, quota) and can return anything
 * at all, since the user owns the disk. Every read is guarded and validated
 * against the spec: an unknown feature key from an older build is dropped
 * rather than silently filtering on something that no longer exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { createPortal } from 'react-dom';
import {
  FILTER_SPECS,
  emptyFilterValue,
  type FilterGameType,
  type GameFilterSpec,
  type GameFilterValue,
} from './advancedFilterSpec';
import { reportError } from '../../utils/errorReporter';
import { supabase } from '../../lib/supabase';
import { readLocalSession } from '../../lib/authUtils';
import { usePlatformCapability } from '../../hooks/usePlatformCapability';
import './AdvancedFilters.css';

const TABS: { key: FilterGameType; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'HOLDEM', label: "Hold'em" },
  { key: 'OMAHA', label: 'Omaha' },
  { key: 'LIMIT', label: 'Limit' },
  { key: 'MTT', label: 'MTT' },
  { key: 'SPIN', label: 'Spins' },
  { key: 'SNG', label: 'Heads Up' },
];

export type FilterStore = Partial<Record<FilterGameType, GameFilterValue>>;

const storageKey = (clubId: string) => `ca_advanced_filters_${clubId}`;

/** How long a burst of changes must settle before the row is written.
 *  Long enough to swallow a slider drag, short enough that closing the sheet
 *  a moment later has usually already synced (and the unmount flush covers
 *  the rest). */
export const REMOTE_SYNC_DEBOUNCE_MS = 700;

/**
 * Validate a filter store against the CURRENT spec, discarding anything it
 * cannot honour.
 *
 * Extracted 2026-08-31 so the local read and the cross-device read share one
 * door. A row written by an older build can carry a game type or feature key
 * this build no longer defines; letting an unvalidated blob through would
 * filter on something that cannot match, which is an empty lobby with no
 * explanation - the exact failure this validation was hardened against in the
 * first place. It would have been easy to trust the database because "we
 * wrote it", and that is precisely the assumption that breaks on the next
 * spec change.
 */
export function sanitizeStore(parsed: FilterStore | null | undefined): FilterStore {
  if (!parsed || typeof parsed !== 'object') return {};
  const clean: FilterStore = {};
  for (const [type, value] of Object.entries(parsed)) {
    /* PER TAB. This loop used to sit inside the outer try alone, so one
       malformed tab - a `games` saved as a string, say, which throws on
       `.filter` - discarded the user's OTHER, perfectly valid tabs. */
    try {
      const spec = FILTER_SPECS[type as Exclude<FilterGameType, 'ALL'>];
      if (!spec || !value || typeof value !== 'object') continue;
      const known = new Set(spec.features.map((f) => f.key));
      const gameKeys = new Set((spec.games ?? []).map((g) => g.key));
      const styleKeys = new Set((spec.styles ?? []).map((g) => g.key));
      const statusKeys = new Set(spec.statuses.map((s) => s.key));
      const presetKeys = new Set(spec.range.presets.map((pr) => pr.key));
      const list = (x: unknown) => (Array.isArray(x) ? (x as string[]) : []);
      const empty = emptyFilterValue(spec);
      /* NUMBERS ARE UNTRUSTED TOO. `...value` used to overwrite the
         defaults with whatever was on disk, and nothing checked it.
         JSON.stringify writes NaN as `null`, so an older build could leave
         `rangeMin: null` - and the very next thing to touch it is
         `fmt(value.rangeMin)`, which calls `.toFixed(2)` on it and throws
         inside render, unmounting the whole lobby. Clamping also repairs a
         value saved against an older, narrower spec, which otherwise
         persisted verbatim and silently hid rows. */
      const clampTo = (x: unknown, lo: number, hi: number, fallback: number) => {
        const n = Number(x);
        return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
      };
      clean[type as FilterGameType] = {
        ...empty,
        ...value,
        // Drop keys a previous build wrote that this one no longer defines.
        games: list(value.games).filter((g) => gameKeys.has(g)),
        styles: list(value.styles).filter((g) => styleKeys.has(g)),
        statuses: list(value.statuses).filter((st) => statusKeys.has(st)),
        mustHave: list(value.mustHave).filter((k) => known.has(k)),
        hide: list(value.hide).filter((k) => known.has(k)),
        /* Left unvalidated, one preset key this build no longer defines
           made matchesPreset false for EVERY row: an empty lobby, no
           explanation, and no way back except Reset. */
        selectedRanges: list(value.selectedRanges).filter((k) => presetKeys.has(k)),
        rangeMin: clampTo(value.rangeMin, spec.range.min, spec.range.max, empty.rangeMin),
        rangeMax: clampTo(value.rangeMax, spec.range.min, spec.range.max, empty.rangeMax),
        seatMin: spec.seats
          ? clampTo(value.seatMin, spec.seats.min, spec.seats.max, empty.seatMin)
          : empty.seatMin,
        seatMax: spec.seats
          ? clampTo(value.seatMax, spec.seats.min, spec.seats.max, empty.seatMax)
          : empty.seatMax,
      };
      /* CLAMPING EACH BOUND SEPARATELY CANNOT UNDO AN INVERSION. A stored
         pair with min above max survives both clamps unchanged, and the
         one-step gap on the thumbs then keeps re-applying the out-of-range
         partner every drag - the range freezes, the tab empties, and Reset
         is the only way back. An inverted pair is not repairable, so it is
         discarded for the spec's own full range. */
      const repaired = clean[type as FilterGameType]!;
      if (repaired.rangeMin > repaired.rangeMax) {
        repaired.rangeMin = empty.rangeMin;
        repaired.rangeMax = empty.rangeMax;
      }
      if (repaired.seatMin > repaired.seatMax) {
        repaired.seatMin = empty.seatMin;
        repaired.seatMax = empty.seatMax;
      }
    } catch (perTab) {
      reportError(perTab, 'AdvancedFilters.loadFilters.tab', { type });
    }
  }
  return clean;
}

/** Read saved filters from this device's cache, validated. */
export function loadFilters(clubId: string): FilterStore {
  try {
    const raw = localStorage.getItem(storageKey(clubId));
    if (!raw) return {};
    return sanitizeStore(JSON.parse(raw) as FilterStore);
  } catch (e) {
    reportError(e, 'AdvancedFilters.loadFilters');
    return {};
  }
}

/**
 * Exported so the lobby's QUICK preference row writes through the same door.
 * Dan 2026-08-21 asked for tier shortcuts under the action bar; those are not a
 * second, parallel filter state - they are the same saved preference, reachable
 * in one tap instead of three. If they wrote anywhere else the sheet and the
 * row would disagree about what is filtered the moment you opened it.
 */
export function saveFilters(clubId: string, store: FilterStore) {
  try {
    localStorage.setItem(storageKey(clubId), JSON.stringify(store));
  } catch (e) {
    // Quota or private mode. The filters still apply for this session; only
    // the memory of them is lost, which is not worth an error in the player's face.
    reportError(e, 'AdvancedFilters.saveFilters');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CROSS-DEVICE (Dan 2026-08-31)
   ═══════════════════════════════════════════════════════════════════════════
   localStorage made "until changed by the user" true on ONE browser. Set your
   filters on a laptop, open the lobby on your phone, and the board came back
   unfiltered.

   So the DATABASE is the truth (user_lobby_filters, RLS-locked to the owner)
   and localStorage stays as the synchronous first-paint cache - exactly the
   split useUserThemeSettings already uses for the table theme. The sheet still
   opens instantly from cache; the row arrives a moment later and corrects it
   if another device moved on.

   Every write is FIRE AND FORGET. A filter is a preference, not a
   transaction: if the network is down the player must still see their choice
   apply on this device, and a failed sync is worth a report, never a blocked
   interaction or an error in their face. */

function currentUserId(): string | null {
  try {
    return readLocalSession()?.userId ?? null;
  } catch {
    return null;
  }
}

/** Read the saved filters for this club from the database, or null. */
export async function fetchRemoteFilters(clubId: string): Promise<FilterStore | null> {
  const userId = currentUserId();
  if (!userId || !clubId) return null;
  try {
    const { data, error } = await supabase
      .from('user_lobby_filters')
      .select('filters')
      .eq('user_id', userId)
      .eq('club_id', clubId)
      .maybeSingle();
    if (error) {
      reportError(error, 'AdvancedFilters.fetchRemoteFilters', { clubId });
      return null;
    }
    if (!data?.filters || typeof data.filters !== 'object') return null;
    /* Validate through the SAME door as the local read. A row written by an
       older build can carry a game type or feature key this build no longer
       defines, and an unvalidated remote blob would then filter on something
       that cannot match - an empty lobby with no explanation, which is the
       exact failure loadFilters was hardened against. */
    return sanitizeStore(data.filters as FilterStore);
  } catch (e) {
    reportError(e, 'AdvancedFilters.fetchRemoteFilters', { clubId });
    return null;
  }
}

/** Mirror the store to the database. Never throws, never blocks the UI. */
export function pushRemoteFilters(clubId: string, store: FilterStore): void {
  const userId = currentUserId();
  if (!userId || !clubId) return;
  void supabase
    .from('user_lobby_filters')
    .upsert(
      { user_id: userId, club_id: clubId, filters: store, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,club_id' }
    )
    .then(({ error }) => {
      if (error) reportError(error, 'AdvancedFilters.pushRemoteFilters', { clubId });
    });
}

/** Format a range endpoint: blinds keep decimals, buy-ins do not. */
function fmt(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2);
}

interface AdvancedFiltersProps {
  clubId: string;
  /** Tab the sheet opens on, so it matches the lobby the player came from. */
  initialType: FilterGameType;
  onClose: () => void;
  onApply: (store: FilterStore) => void;
  sortKey?: string;
  onSortChange?: (k: any) => void;
  sortOptions?: { key: string; label: string }[];
  /**
   * ALL has no filter spec of its own, and the lobby deliberately ignores the
   * per-type filters while it is the active tab - so on ALL this sheet showed
   * a game-type row and five filter sections that could be set, saved, and
   * then have no effect on the list behind them. In that mode it is a Sort
   * sheet and says so: the type tabs and every filter section are gone, and
   * only Sort By remains. Nothing on screen does nothing.
   */
  sortOnly?: boolean;
}

export default function AdvancedFilters({
  sortKey,
  onSortChange,
  sortOptions,
  clubId,
  initialType,
  onClose,
  onApply,
  sortOnly = false,
}: AdvancedFiltersProps) {
  const [activeType, setActiveType] = useState<FilterGameType>(
    // ALL has no spec of its own; open on Hold'em, the first that does.
    initialType === 'ALL' ? 'HOLDEM' : initialType
  );
  const [store, setStore] = useState<FilterStore>(() => loadFilters(clubId));

  /* SAVE ON CLICK (Dan 2026-08-30): every filter interaction persists the
     moment it happens, not only when Apply is tapped. Before this, tapping
     chips and closing the sheet silently discarded the choices. Apply still
     pushes the store to the lobby; this effect only guarantees the store
     itself survives. Skips the very first render so simply opening the sheet
     never rewrites storage. */
  const hasHydrated = useRef(false);
  const pendingRemoteRef = useRef<FilterStore | null>(null);
  const remoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hasHydrated.current) {
      hasHydrated.current = true;
      return;
    }
    // THIS DEVICE, IMMEDIATELY. localStorage is synchronous and free, so the
    // choice is durable the instant it is made - that is what "saves when
    // clicked" means and it must not wait on a network.
    saveFilters(clubId, store);

    /* THE DATABASE, DEBOUNCED - AND THIS IS NOT AN OPTIMISATION.
       The blinds and seat controls are <input type="range">, whose onChange
       fires on EVERY value change while a thumb is being dragged. Pushing on
       each one turned a single drag across a 0-15,000 slider into dozens of
       upserts of the same row - a write storm on the database, paid for again
       in bandwidth on a phone, for one gesture that has exactly one meaningful
       result: where the thumb was let go.
       Only the LAST value in a burst is worth sending, so the timer restarts
       on each change and only the settled value is written. */
    pendingRemoteRef.current = store;
    if (remoteTimerRef.current) clearTimeout(remoteTimerRef.current);
    remoteTimerRef.current = setTimeout(() => {
      remoteTimerRef.current = null;
      const pending = pendingRemoteRef.current;
      pendingRemoteRef.current = null;
      if (pending) pushRemoteFilters(clubId, pending);
    }, REMOTE_SYNC_DEBOUNCE_MS);
  }, [clubId, store]);

  /* FLUSH WHAT IS STILL PENDING. Without this, a player who taps one chip and
     immediately closes the sheet - the common case - loses the cross-device
     half of that choice until they happen to change something else. Runs on
     unmount AND when clubId changes, so switching club cannot strand a write
     against the club that was just left. */
  useEffect(() => {
    return () => {
      if (remoteTimerRef.current) {
        clearTimeout(remoteTimerRef.current);
        remoteTimerRef.current = null;
      }
      const pending = pendingRemoteRef.current;
      pendingRemoteRef.current = null;
      if (pending) pushRemoteFilters(clubId, pending);
    };
  }, [clubId]);

  /* CROSS-DEVICE HYDRATION. The sheet opens instantly from this device's
     cache; the saved row arrives a moment later and corrects it if another
     device has moved on since. Applied only when it actually DIFFERS, so a
     player who is mid-tap does not see the sheet redraw underneath them for
     no reason, and only while nothing has been touched here yet - their
     current interaction always outranks a late-arriving remote value. */
  const touchedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchRemoteFilters(clubId).then((remote) => {
      if (cancelled || !remote || touchedRef.current) return;
      setStore((prev) => (JSON.stringify(prev) === JSON.stringify(remote) ? prev : remote));
    });
    return () => {
      cancelled = true;
    };
  }, [clubId]);

  /* Same hole the game drawer had (fixed 2026-08-23): the sheet declares
     role=dialog aria-modal=true and trapped nothing, so focus stayed on the
     Filters button behind it and Tab walked the lobby underneath. The trap
     also returns focus to that button on close. */
  const sheetRef = useFocusTrap(true);

  /* And the page scrolled behind the overlay on a phone, so cancelling put
     the player somewhere they had never scrolled to. */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const spec: GameFilterSpec | undefined =
    activeType === 'ALL' ? undefined : FILTER_SPECS[activeType];

  /* A CHIP FOR A CAPABILITY IS DRAWN ONLY WHILE IT IS LIVE (kill-v1). The
     registry is asked only when this tab carries such a chip, and anything but
     a fresh "available" (not yet answered, could not ask, not available) keeps
     the chip off the sheet: a feature no table can have is not advertised. */
  const gatedCapability = spec?.features.find((f) => f.capability)?.capability ?? null;
  const gatedAvailable = usePlatformCapability(gatedCapability);
  const shownFeatures = useMemo(
    () =>
      (spec?.features ?? []).filter(
        (f) => !f.capability || (f.capability === gatedCapability && gatedAvailable === true)
      ),
    [spec, gatedCapability, gatedAvailable]
  );

  const value = useMemo<GameFilterValue>(
    () =>
      spec ? (store[activeType] ?? emptyFilterValue(spec)) : emptyFilterValue(FILTER_SPECS.HOLDEM),
    [store, activeType, spec]
  );

  const activeCount = useMemo(() => {
    if (!spec) return sortKey && sortKey !== 'recommended' ? 1 : 0;
    const empty = emptyFilterValue(spec);
    let count = 0;
    count += value.format.length;
    count += value.games.length;
    count += value.styles?.length ?? 0;
    count += value.statuses.length;
    count += value.mustHave.length;
    count += value.hide.length;
    count += value.selectedRanges?.length ?? 0;
    if (value.rangeMin !== empty.rangeMin || value.rangeMax !== empty.rangeMax) count += 1;
    if (value.seatMin !== empty.seatMin || value.seatMax !== empty.seatMax) count += 1;
    if (sortKey && sortKey !== 'recommended') count += 1;
    return count;
  }, [sortKey, spec, value]);

  const activeTypeLabel = TABS.find((tab) => tab.key === activeType)?.label ?? 'Games';

  /* One step for this spec, shared by both thumbs and both clamps. */
  /* A step of 0.01 is right for the BLINDS slider (min 0.02) and wrong for
     every buy-in slider, whose min is 0 - which also satisfies `< 1`. That
     turned a 0-15,000 range into 1.5 million steps: one arrow key moved the
     filter by a cent, and dragging produced 3847.23 under a header whose own
     formatter says buy-ins carry no decimals. A min ABOVE zero and below one
     is the only case that needs cents. */
  const rangeStep = spec ? (spec.range.min > 0 && spec.range.min < 1 ? 0.01 : 1) : 1;

  const patch = useCallback(
    (next: Partial<GameFilterValue>) => {
      // Any edit here outranks a remote value still in flight.
      touchedRef.current = true;
      setStore((prev) => ({ ...prev, [activeType]: { ...value, ...next } }));
    },
    [activeType, value]
  );

  const toggle = useCallback(
    (field: 'games' | 'format' | 'styles' | 'statuses' | 'mustHave' | 'hide', key: string) => {
      const cur = value[field] ?? [];
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      /* MUST-HAVE and Hide are mutually exclusive for the same feature: asking
         for tables that both have and do not have Bomb Pot returns nothing, and
         an empty lobby with no explanation is the worst outcome here. Selecting
         one side clears the other. */
      if (field === 'mustHave')
        patch({ mustHave: next, hide: value.hide.filter((k) => k !== key) });
      else if (field === 'hide')
        patch({ hide: next, mustHave: value.mustHave.filter((k) => k !== key) });
      else patch({ [field]: next } as Partial<GameFilterValue>);
    },
    [value, patch]
  );

  // Escape closes, matching every other modal in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const chipRow = (
    items: { key: string; label: string }[],
    field: 'games' | 'format' | 'styles' | 'statuses',
    selected: string[]
  ) => (
    <div className="afx-chips">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`afx-chip ${selected.includes(it.key) ? 'is-on' : ''}`}
          aria-pressed={selected.includes(it.key)}
          onClick={() => toggle(field, it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );

  return createPortal(
    <div className="afx-overlay" role="presentation" onClick={onClose}>
      <div
        ref={sheetRef}
        className="afx-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={sortOnly ? 'Sort' : 'Advanced Filters'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="afx-head">
          <div className="afx-head__copy">
            <span className="afx-head__eyebrow">Tournament Board</span>
            <h2>{sortOnly ? 'Sort Games' : 'Game Filters'}</h2>
            <p>
              {sortOnly
                ? 'Choose How The Board Is Ordered'
                : `${activeTypeLabel} · ${activeCount} Active ${activeCount === 1 ? 'Filter' : 'Filters'}`}
            </p>
          </div>
          <button
            type="button"
            className="afx-close"
            onClick={onClose}
            aria-label={sortOnly ? 'Close Sort' : 'Close Game Filters'}
          >
            Close
          </button>
        </header>

        {!sortOnly && (
          <div className="afx-tabs" role="group" aria-label="Game Type">
            {TABS.filter((t) => t.key !== 'ALL').map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={activeType === t.key}
                className={`afx-tab ${activeType === t.key ? 'is-active' : ''}`}
                onClick={() => setActiveType(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="afx-body">
          {sortOptions && onSortChange && (
            /* Open by default in sortOnly mode: it is the ONLY content there,
               and a sheet titled Sort that shows one collapsed accordion row
               looks empty on arrival. In full mode there are six sections and
               collapsed is right. */
            <details className="afx-section" open>
              <summary>
                <h3>Sort The Board</h3>
              </summary>
              <div className="afx-chips">
                {sortOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`afx-chip ${sortKey === opt.key ? 'is-on' : ''}`}
                    aria-pressed={sortKey === opt.key}
                    onClick={() => onSortChange(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </details>
          )}

          {!sortOnly && spec && (
            <>
              {spec.format && (
                <details className="afx-section" open>
                  <summary>
                    <h3>Format</h3>
                  </summary>
                  {chipRow(spec.format, 'format', value.format)}
                </details>
              )}

              {spec.games && (
                <details className="afx-section" open>
                  <summary>
                    <h3>Games</h3>
                  </summary>
                  {chipRow(spec.games, 'games', value.games)}
                </details>
              )}

              {spec.styles && (
                <details className="afx-section" open>
                  <summary>
                    <h3>Game Style</h3>
                  </summary>
                  {chipRow(spec.styles, 'styles', value.styles ?? [])}
                </details>
              )}

              <details className="afx-section" open>
                <summary>
                  <h3>
                    {spec.range.label} · {fmt(value.rangeMin)} - {fmt(value.rangeMax)}
                  </h3>
                </summary>
                {/* Two overlaid range inputs rather than a custom drag handler.
                    A hand-rolled two-thumb slider has to reimplement pointer
                    capture, keyboard stepping and the accessibility tree; two
                    native inputs get all three for free and stay operable with
                    a keyboard. The clamps below stop the thumbs crossing. */}
                <div className="afx-range">
                  <span className="afx-range__track" aria-hidden="true" />
                  <span
                    className="afx-range__fill"
                    aria-hidden="true"
                    style={{
                      left: `${((value.rangeMin - spec.range.min) / (spec.range.max - spec.range.min)) * 100}%`,
                      right: `${100 - ((value.rangeMax - spec.range.min) / (spec.range.max - spec.range.min)) * 100}%`,
                    }}
                  />
                  {/* STEP COMES FROM THE MIN, NOT THE MAX.
                      `spec.range.max > 100 ? 1 : 0.01` chose whole numbers for
                      the blinds slider because its max is 5000 - but the
                      precision is needed at the BOTTOM. A step of 1 based at
                      min 0.02 makes the only reachable values 0.02, 1.02,
                      2.02..., so the Micro (0.02-0.2) and Small (0.2-3) tiers
                      the spec itself defines could not be selected at all.
                      5000 is not step-valid from that base either, so the max
                      thumb was silently sanitised to 4999.02 by the browser -
                      which then read as a permanently active filter that hid
                      every 5000-blind table.

                      And the thumbs keep a one-step gap. Both inputs sit at
                      the same coordinates and the max one is later in the DOM,
                      so it wins the pointer; dragging the min all the way up
                      buried it underneath, where neither could move and the
                      range was frozen to a single point with an empty lobby
                      and no way back but Reset. */}
                  <input
                    type="range"
                    aria-label={`Minimum ${spec.range.label}`}
                    min={spec.range.min}
                    max={spec.range.max}
                    step={rangeStep}
                    value={value.rangeMin}
                    onChange={(e) =>
                      patch({
                        rangeMin: Math.max(
                          spec.range.min,
                          Math.min(Number(e.target.value), value.rangeMax - rangeStep)
                        ),
                        selectedRanges: [],
                      })
                    }
                  />
                  <input
                    type="range"
                    aria-label={`Maximum ${spec.range.label}`}
                    min={spec.range.min}
                    max={spec.range.max}
                    step={rangeStep}
                    value={value.rangeMax}
                    onChange={(e) =>
                      patch({
                        rangeMax: Math.min(
                          spec.range.max,
                          Math.max(Number(e.target.value), value.rangeMin + rangeStep)
                        ),
                        selectedRanges: [],
                      })
                    }
                  />
                </div>
                <div className="afx-chips">
                  {spec.range.presets.map((p) => {
                    const on = (value.selectedRanges || []).includes(p.key);
                    return (
                      <button
                        key={p.key}
                        type="button"
                        className={`afx-chip ${on ? 'is-on' : ''}`}
                        aria-pressed={on}
                        onClick={() => {
                          const arr = value.selectedRanges || [];
                          const nextArr = on ? arr.filter((k) => k !== p.key) : [...arr, p.key];
                          patch({ selectedRanges: nextArr });
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </details>

              <details className="afx-section" open>
                <summary>
                  <h3>
                    {spec.seats
                      ? `${spec.seatsLabel} · ${value.seatMin} Min / ${value.seatMax} Max`
                      : spec.seatsLabel}
                  </h3>
                </summary>
                {chipRow(spec.statuses, 'statuses', value.statuses)}
                {spec.seats && (
                  <div className="afx-range">
                    <span className="afx-range__track" aria-hidden="true" />
                    <span
                      className="afx-range__fill"
                      aria-hidden="true"
                      style={{
                        left: `${((value.seatMin - spec.seats.min) / (spec.seats.max - spec.seats.min)) * 100}%`,
                        right: `${100 - ((value.seatMax - spec.seats.min) / (spec.seats.max - spec.seats.min)) * 100}%`,
                      }}
                    />
                    <input
                      type="range"
                      aria-label="Minimum Seats"
                      min={spec.seats.min}
                      max={spec.seats.max}
                      value={value.seatMin}
                      onChange={(e) =>
                        patch({
                          seatMin: Math.max(
                            spec.seats!.min,
                            Math.min(Number(e.target.value), value.seatMax - 1)
                          ),
                        })
                      }
                    />
                    <input
                      type="range"
                      aria-label="Maximum Seats"
                      min={spec.seats.min}
                      max={spec.seats.max}
                      value={value.seatMax}
                      onChange={(e) =>
                        patch({
                          seatMax: Math.min(
                            spec.seats!.max,
                            Math.max(Number(e.target.value), value.seatMin + 1)
                          ),
                        })
                      }
                    />
                  </div>
                )}
              </details>

              {shownFeatures.length > 0 && (
                <>
                  <details className="afx-section">
                    <summary>
                      <h3>Required Features</h3>
                    </summary>
                    <p className="afx-hint">Only Show Games With Every Selected Feature.</p>
                    <div className="afx-grid">
                      {shownFeatures.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          className={`afx-feat ${value.mustHave.includes(f.key) ? 'is-on' : ''}`}
                          aria-pressed={value.mustHave.includes(f.key)}
                          onClick={() => toggle('mustHave', f.key)}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </details>

                  <details className="afx-section">
                    <summary>
                      <h3>Exclude Features</h3>
                    </summary>
                    <p className="afx-hint">Hide Games That Use Any Selected Feature.</p>
                    <div className="afx-grid">
                      {shownFeatures.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          className={`afx-feat afx-feat--hide ${
                            value.hide.includes(f.key) ? 'is-on' : ''
                          }`}
                          aria-pressed={value.hide.includes(f.key)}
                          onClick={() => toggle('hide', f.key)}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </details>
                </>
              )}
            </>
          )}
        </div>

        {/* In sort-only mode the sort chips apply as they are pressed, so
            Cancel / Reset / Save would be three buttons acting on filters
            that are not on screen. One Done. */}
        {sortOnly ? (
          <footer className="afx-foot">
            <button className="afx-btn afx-btn--save" onClick={onClose}>
              Done
            </button>
          </footer>
        ) : (
          <footer className="afx-foot">
            <button
              className="afx-btn afx-btn--reset"
              onClick={() => {
                /* Resets THIS TAB only. A single Reset that wiped every game
                 type would be a destructive action behind an innocuous label -
                 a player clearing their Hold'em filters does not expect their
                 MTT preferences to go with them. */
                if (!spec) return;
                // Reset does not go through patch(), so it marks the sheet
                // touched itself - otherwise a remote value still in flight
                // could land on top of a deliberate clear.
                touchedRef.current = true;
                setStore((prev) => ({ ...prev, [activeType]: emptyFilterValue(spec) }));
              }}
            >
              Reset {activeTypeLabel}
            </button>
            <button
              className="afx-btn afx-btn--save"
              onClick={() => {
                saveFilters(clubId, store);
                onApply(store);
                onClose();
              }}
            >
              Apply {activeCount > 0 ? `${activeCount} ` : ''}Filters
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}
