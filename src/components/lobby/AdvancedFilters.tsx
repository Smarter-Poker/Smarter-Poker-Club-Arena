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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FILTER_SPECS,
  emptyFilterValue,
  type FilterGameType,
  type GameFilterSpec,
  type GameFilterValue,
} from './advancedFilterSpec';
import { reportError } from '../../utils/errorReporter';
import './AdvancedFilters.css';

const TABS: { key: FilterGameType; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'HOLDEM', label: "Hold'em" },
  { key: 'OMAHA', label: 'Omaha' },
  { key: 'MTT', label: 'MTT' },
  { key: 'SPIN', label: 'Spin-It' },
  { key: 'SNG', label: 'HU' },
];

export type FilterStore = Partial<Record<FilterGameType, GameFilterValue>>;

const storageKey = (clubId: string) => `ca_advanced_filters_${clubId}`;

/** Read saved filters, discarding anything the current spec cannot honour. */
export function loadFilters(clubId: string): FilterStore {
  try {
    const raw = localStorage.getItem(storageKey(clubId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as FilterStore;
    if (!parsed || typeof parsed !== 'object') return {};

    const clean: FilterStore = {};
    for (const [type, value] of Object.entries(parsed)) {
      const spec = FILTER_SPECS[type as Exclude<FilterGameType, 'ALL'>];
      if (!spec || !value) continue;
      const known = new Set(spec.features.map((f) => f.key));
      const gameKeys = new Set((spec.games ?? []).map((g) => g.key));
      const statusKeys = new Set(spec.statuses.map((s) => s.key));
      clean[type as FilterGameType] = {
        ...emptyFilterValue(spec),
        ...value,
        // Drop keys a previous build wrote that this one no longer defines.
        games: (value.games ?? []).filter((g) => gameKeys.has(g)),
        statuses: (value.statuses ?? []).filter((s) => statusKeys.has(s)),
        mustHave: (value.mustHave ?? []).filter((k) => known.has(k)),
        hide: (value.hide ?? []).filter((k) => known.has(k)),
      };
    }
    return clean;
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
}

export default function AdvancedFilters({
  clubId,
  initialType,
  onClose,
  onApply,
}: AdvancedFiltersProps) {
  const [activeType, setActiveType] = useState<FilterGameType>(
    // ALL has no spec of its own; open on Hold'em, the first that does.
    initialType === 'ALL' ? 'HOLDEM' : initialType
  );
  const [store, setStore] = useState<FilterStore>(() => loadFilters(clubId));

  const spec: GameFilterSpec | undefined =
    activeType === 'ALL' ? undefined : FILTER_SPECS[activeType];

  const value = useMemo<GameFilterValue>(
    () =>
      spec ? (store[activeType] ?? emptyFilterValue(spec)) : emptyFilterValue(FILTER_SPECS.HOLDEM),
    [store, activeType, spec]
  );

  const patch = useCallback(
    (next: Partial<GameFilterValue>) => {
      setStore((prev) => ({ ...prev, [activeType]: { ...value, ...next } }));
    },
    [activeType, value]
  );

  const toggle = useCallback(
    (field: 'games' | 'format' | 'statuses' | 'mustHave' | 'hide', key: string) => {
      const cur = value[field];
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
    field: 'games' | 'format' | 'statuses',
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
        className="afx-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Advanced Filters"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="afx-head">
          <button className="afx-back" onClick={onClose} aria-label="Close advanced filters">
            &#8249;&#8249;
          </button>
          <h2>Advanced Filters</h2>
        </header>

        <div className="afx-tabs" role="tablist" aria-label="Game type">
          {TABS.filter((t) => t.key !== 'ALL').map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={activeType === t.key}
              className={`afx-tab ${activeType === t.key ? 'is-active' : ''}`}
              onClick={() => setActiveType(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="afx-body">
          {spec && (
            <>
              {spec.format && (
                <section className="afx-section">
                  <h3>Format:</h3>
                  {chipRow(spec.format, 'format', value.format)}
                </section>
              )}

              {spec.games && (
                <section className="afx-section">
                  <h3>Games:</h3>
                  {chipRow(spec.games, 'games', value.games)}
                </section>
              )}

              <section className="afx-section">
                <h3>
                  {spec.range.label}: {fmt(value.rangeMin)} - {fmt(value.rangeMax)}
                </h3>
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
                  <input
                    type="range"
                    aria-label={`Minimum ${spec.range.label}`}
                    min={spec.range.min}
                    max={spec.range.max}
                    step={spec.range.max > 100 ? 1 : 0.01}
                    value={value.rangeMin}
                    onChange={(e) =>
                      patch({ rangeMin: Math.min(Number(e.target.value), value.rangeMax) })
                    }
                  />
                  <input
                    type="range"
                    aria-label={`Maximum ${spec.range.label}`}
                    min={spec.range.min}
                    max={spec.range.max}
                    step={spec.range.max > 100 ? 1 : 0.01}
                    value={value.rangeMax}
                    onChange={(e) =>
                      patch({ rangeMax: Math.max(Number(e.target.value), value.rangeMin) })
                    }
                  />
                </div>
                <div className="afx-chips">
                  {spec.range.presets.map((p) => {
                    const on = value.rangeMin === p.min && value.rangeMax === p.max;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        className={`afx-chip ${on ? 'is-on' : ''}`}
                        aria-pressed={on}
                        onClick={() =>
                          patch(
                            on
                              ? { rangeMin: spec.range.min, rangeMax: spec.range.max }
                              : { rangeMin: p.min, rangeMax: p.max }
                          )
                        }
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="afx-section">
                <h3>
                  {spec.seats
                    ? `${spec.seatsLabel}: ${value.seatMin} min ${value.seatMax} max`
                    : spec.seatsLabel}
                </h3>
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
                      aria-label="Minimum seats"
                      min={spec.seats.min}
                      max={spec.seats.max}
                      value={value.seatMin}
                      onChange={(e) =>
                        patch({ seatMin: Math.min(Number(e.target.value), value.seatMax) })
                      }
                    />
                    <input
                      type="range"
                      aria-label="Maximum seats"
                      min={spec.seats.min}
                      max={spec.seats.max}
                      value={value.seatMax}
                      onChange={(e) =>
                        patch({ seatMax: Math.max(Number(e.target.value), value.seatMin) })
                      }
                    />
                  </div>
                )}
              </section>

              {spec.features.length > 0 && (
                <>
                  <section className="afx-section">
                    <h3>Must-Have Features:</h3>
                    <p className="afx-hint">Show Tables Only With ALL Selected Features.</p>
                    <div className="afx-grid">
                      {spec.features.map((f) => (
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
                  </section>

                  <section className="afx-section">
                    <h3>Hide:</h3>
                    <p className="afx-hint">Tables With Selected Features Will Be Hidden.</p>
                    <div className="afx-grid">
                      {spec.features.map((f) => (
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
                  </section>
                </>
              )}
            </>
          )}
        </div>

        <footer className="afx-foot">
          <button className="afx-btn afx-btn--cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="afx-btn afx-btn--reset"
            onClick={() => {
              /* Resets THIS TAB only. A single Reset that wiped every game
                 type would be a destructive action behind an innocuous label -
                 a player clearing their Hold'em filters does not expect their
                 MTT preferences to go with them. */
              if (!spec) return;
              setStore((prev) => ({ ...prev, [activeType]: emptyFilterValue(spec) }));
            }}
          >
            Reset
          </button>
          <button
            className="afx-btn afx-btn--save"
            onClick={() => {
              saveFilters(clubId, store);
              onApply(store);
              onClose();
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
