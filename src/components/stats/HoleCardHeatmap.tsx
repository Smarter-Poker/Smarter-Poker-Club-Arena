/**
 * HoleCardHeatmap — the 169-cell starting-hand grid.
 *
 * THE SAMPLE-SIZE PROBLEM, WHICH IS THE WHOLE DESIGN
 * --------------------------------------------------
 * There are 169 cells. A player with 2,000 hands averages twelve per cell, and
 * that average flatters it: any specific offsuit combo is about 0.9% of deals,
 * any specific suited combo about 0.3%. At realistic volumes most cells hold
 * single-digit observations.
 *
 * A naive green/red profit heatmap over that will state, with total visual
 * confidence, that J4o is the player's most profitable hand. That is not a
 * leak-finding tool, it is a random number generator with a colour ramp, and
 * it would actively make people play worse.
 *
 * So:
 *  - The DEFAULT view is Frequency, not Profit. How often you played a hand is
 *    a rate over opportunities and stabilises within a few hundred hands. It is
 *    also the view that actually finds leaks: a grid showing K7o opened from
 *    UTG is a real, fixable finding tonight.
 *  - In the Profit view, cells under MIN_CONFIDENT_HANDS render as neutral grey
 *    with their hand count, never as a colour. Above it, saturation scales with
 *    sample size as well as magnitude, so a 35-hand cell is visibly paler than
 *    a 300-hand one.
 *  - The Luck view is labelled as variance, not skill, so nobody reads it as a
 *    strategy signal.
 *
 * PLO: hand_class is NULL for 4-6 card holdings, so those hands never reach the
 * grid. Rather than render an empty 13x13, the component explains why.
 */

import { useEffect, useMemo, useState } from 'react';
import StatsFactsService, {
  type HandGridCell,
  type ClassHand,
} from '../../services/StatsFactsService';
import { CHIP_STATS } from '../../services/statsScope';
import './HoleCardHeatmap.css';

interface Props {
  userId?: string;
  days?: number | null;
}

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

/** Below this many hands, a per-cell profit number is noise, not a signal. */
const MIN_CONFIDENT_HANDS = 30;

/** RPC numerics can be null; a null reaching .toFixed took the panel down. */
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '-';
};

type ViewMode = 'frequency' | 'profit' | 'luck';

const POSITIONS = ['BTN', 'CO', 'HJ', 'LJ', 'MP', 'UTG+1', 'UTG', 'SB', 'BB'];

const VARIANTS: Array<{ key: string | null; label: string }> = [
  { key: null, label: 'All Holdem' },
  { key: 'nlh', label: "No Limit Hold'em" },
  { key: 'short_deck', label: 'Short Deck' },
];

/** 'AKs' for row<col, 'AKo' for row>col, 'AA' on the diagonal. */
function classFor(rowIdx: number, colIdx: number): string {
  const hi = RANKS[Math.min(rowIdx, colIdx)];
  const lo = RANKS[Math.max(rowIdx, colIdx)];
  if (rowIdx === colIdx) return `${hi}${hi}`;
  return `${hi}${lo}${rowIdx < colIdx ? 's' : 'o'}`;
}

function frequencyColor(vpipFraction: number): string {
  // Cyan ramp: unplayed is nearly transparent, always-played is solid.
  const a = 0.06 + Math.min(1, vpipFraction) * 0.72;
  return `rgba(0, 212, 255, ${a.toFixed(3)})`;
}

function signedColor(value: number, scale: number, confidence: number): string {
  if (scale <= 0) return 'rgba(255,255,255,0.05)';
  const magnitude = Math.min(1, Math.abs(value) / scale);
  // Confidence damps the colour as well as magnitude, so a thin cell can never
  // shout as loudly as a well-sampled one.
  const alpha = (0.08 + magnitude * 0.7) * confidence;
  return value >= 0
    ? `rgba(34, 197, 94, ${alpha.toFixed(3)})`
    : `rgba(239, 68, 68, ${alpha.toFixed(3)})`;
}

export default function HoleCardHeatmap({ userId, days = null }: Props) {
  const [cells, setCells] = useState<HandGridCell[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<ViewMode>('frequency');
  const [position, setPosition] = useState<string | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // Drill-down: the individual hands behind one cell.
  const [selected, setSelected] = useState<string | null>(null);
  const [classHands, setClassHands] = useState<ClassHand[] | null>(null);
  const [handsLoading, setHandsLoading] = useState(false);
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHovered(null); // a key from the previous filter would read "never dealt"
    setSelected(null);
    StatsFactsService.getHandGrid(userId, CHIP_STATS, { position, variant, days })
      .then((payload) => {
        if (cancelled) return;
        // Cells with no hands are noise for "classes seen" and for the scale.
        setCells((payload.cells ?? []).filter((c) => c && c.hands > 0));
        setReadError(payload.error ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, position, variant, days, attempt]);

  useEffect(() => {
    if (!userId || !selected) {
      setClassHands(null);
      // Must clear here too: if a fetch was in flight when `selected` went
      // null, its cleanup set `cancelled` and skipped the .finally, so the
      // flag would otherwise stay true for the rest of the session.
      setHandsLoading(false);
      return;
    }
    let cancelled = false;
    setHandsLoading(true);
    setDrillError(null);
    StatsFactsService.getClassHands(userId, CHIP_STATS, selected, { position, variant, days })
      .then((p) => {
        if (cancelled) return;
        setClassHands(p.hands ?? []);
        setDrillError(p.error ?? null);
      })
      .finally(() => {
        if (!cancelled) setHandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, selected, position, variant, days]);

  const byClass = useMemo(() => {
    const m = new Map<string, HandGridCell>();
    for (const c of cells ?? []) m.set(c.hand_class, c);
    return m;
  }, [cells]);

  const totalHands = useMemo(() => (cells ?? []).reduce((s, c) => s + c.hands, 0), [cells]);

  /**
   * Colour scale from the 90th percentile of confident cells rather than the
   * max: one 400bb cooler would otherwise flatten every other cell to grey.
   */
  const scale = useMemo(() => {
    const vals = (cells ?? [])
      .filter((c) => c.hands >= MIN_CONFIDENT_HANDS)
      .map((c) => Math.abs(mode === 'luck' ? c.net_bb - c.ev_net_bb : c.bb100))
      .sort((a, b) => a - b);
    if (vals.length === 0) return 0;
    return vals[Math.floor(vals.length * 0.9)] || vals[vals.length - 1] || 0;
  }, [cells, mode]);

  const hoveredCell = hovered ? byClass.get(hovered) : null;

  if (loading) {
    return (
      <div className="heatmap-card">
        <div className="heatmap-skeleton" />
      </div>
    );
  }

  if (readError) {
    return (
      <div className="heatmap-card heatmap-empty" role="alert">
        <h3 className="heatmap-title">Starting Hands</h3>
        <p className="heatmap-empty-text">
          The Starting Hand Grid Could Not Be Loaded Right Now.{' '}
          <button type="button" className="hand-retry" onClick={() => setAttempt((n) => n + 1)}>
            Try Again
          </button>
        </p>
      </div>
    );
  }

  if (totalHands === 0) {
    return (
      <div className="heatmap-card heatmap-empty">
        <h3 className="heatmap-title">Starting Hands</h3>
        <p className="heatmap-empty-text">
          No Hold'em Hands Recorded Yet For This Filter. The Grid Is Built From A Per-Hand Record
          That Began Collecting Recently, So It Fills In From Your Next Session Onward. Pot Limit
          Omaha Hands Never Appear Here: A 13X13 Grid Cannot Represent A Four To Six Card Holding.
        </p>
      </div>
    );
  }

  return (
    <div className="heatmap-card">
      <div className="heatmap-head">
        <h3 className="heatmap-title">Starting Hands</h3>
        <p className="heatmap-sub">
          {totalHands.toLocaleString()} Hands Dealt Across {byClass.size} Of 169 Starting Hands.
        </p>
      </div>

      <div className="heatmap-controls">
        <div className="heatmap-modes" role="group" aria-label="View Mode">
          {(
            [
              ['frequency', 'How Often'],
              ['profit', 'Profit'],
              ['luck', 'Luck'],
            ] as Array<[ViewMode, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`heatmap-mode${mode === key ? ' is-on' : ''}`}
              aria-pressed={mode === key}
              onClick={() => setMode(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="heatmap-filters">
          <label className="heatmap-select-wrap">
            <span className="heatmap-select-label">Position</span>
            <select
              className="heatmap-select"
              value={position ?? ''}
              onChange={(e) => {
                setSelected(null);
                setPosition(e.target.value || null);
              }}
            >
              <option value="">All</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="heatmap-select-wrap">
            <span className="heatmap-select-label">Game</span>
            <select
              className="heatmap-select"
              value={variant ?? ''}
              onChange={(e) => {
                setSelected(null);
                setVariant(e.target.value || null);
              }}
            >
              {VARIANTS.map((v) => (
                <option key={v.label} value={v.key ?? ''}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="heatmap-scroll">
        <div
          className="heatmap-grid"
          role="grid"
          aria-label="Starting Hand Grid, 13 By 13"
          onMouseLeave={() => setHovered(null)}
        >
          {RANKS.map((rowRank, rowIdx) => (
            // role="grid" requires a row layer. Without it the 169 gridcells
            // were direct children of the grid, which screen readers report as
            // a broken structure. `display: contents` keeps the CSS grid
            // layout identical.
            <div className="heatmap-row" role="row" key={`row-${rowRank}`}>
              {RANKS.map((__, colIdx) => {
                const key = classFor(rowIdx, colIdx);
                const cell = byClass.get(key);
                const hands = cell?.hands ?? 0;
                const confident = hands >= MIN_CONFIDENT_HANDS;

                let bg = 'rgba(255,255,255,0.03)';
                if (cell) {
                  if (mode === 'frequency') {
                    bg = frequencyColor(cell.vpip_pct);
                  } else if (!confident) {
                    // Deliberately colourless: too few hands to claim anything.
                    bg = 'rgba(255,255,255,0.05)';
                  } else {
                    const value = mode === 'luck' ? cell.net_bb - cell.ev_net_bb : cell.bb100;
                    const confidenceWeight = Math.min(1, hands / (MIN_CONFIDENT_HANDS * 4));
                    bg = signedColor(value, scale, 0.45 + confidenceWeight * 0.55);
                  }
                }

                return (
                  <button
                    key={key}
                    type="button"
                    role="gridcell"
                    className={`heatmap-cell${rowIdx === colIdx ? ' is-pair' : ''}${
                      hovered === key ? ' is-hovered' : ''
                    }${cell && mode !== 'frequency' && !confident ? ' is-thin' : ''}`}
                    style={{ background: bg }}
                    onMouseEnter={() => setHovered(key)}
                    onFocus={() => setHovered(key)}
                    // Touch has no hover. Without a click handler the readout
                    // never populated on a phone, on a mobile-first product.
                    // A click also opens the hands behind the cell.
                    onClick={() => {
                      setHovered(key);
                      setSelected((cur) => (cur === key && cell ? null : cell ? key : null));
                    }}
                    aria-expanded={cell ? selected === key : undefined}
                    aria-label={
                      !cell
                        ? `${key}, Never Dealt`
                        : confident
                          ? `${key}, ${hands} Hands, ${n(cell.bb100).toFixed(0)} Big Blinds Per 100`
                          : // Deliberately does NOT state bb/100 below the
                            // confidence threshold. The whole design refuses to
                            // show that number for a thin cell; announcing it to
                            // a screen reader anyway would be the same false
                            // precision, just less visible.
                            `${key}, ${hands} Hands, Too Few To Rate`
                    }
                  >
                    {key}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="heatmap-readout">
        {hoveredCell ? (
          <>
            <strong>{hoveredCell.hand_class}</strong>
            <span>{hoveredCell.hands.toLocaleString()} Dealt</span>
            <span>Played {(n(hoveredCell.vpip_pct) * 100).toFixed(0)}%</span>
            <span className={hoveredCell.net_bb >= 0 ? 'is-up' : 'is-down'}>
              {hoveredCell.net_bb >= 0 ? '+' : ''}
              {n(hoveredCell.net_bb).toFixed(1)} BB
            </span>
            {hoveredCell.hands >= MIN_CONFIDENT_HANDS ? (
              <span className={hoveredCell.bb100 >= 0 ? 'is-up' : 'is-down'}>
                {hoveredCell.bb100 >= 0 ? '+' : ''}
                {n(hoveredCell.bb100).toFixed(0)} BB/100
              </span>
            ) : (
              <span className="is-thin-note">Too Few Hands To Rate</span>
            )}
          </>
        ) : (
          <span className="heatmap-readout-hint">
            {hovered ? `${hovered} - Never Dealt` : 'Hover A Hand For Its Detail'}
          </span>
        )}
      </div>

      {selected && (
        <div className="heatmap-drill">
          <div className="heatmap-drill-head">
            <strong>{selected}</strong>
            <span>
              {handsLoading ? 'Loading Hands...' : `${(classHands ?? []).length} Most Recent`}
            </span>
            <button type="button" className="heatmap-drill-close" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          {!handsLoading && drillError && (
            <p className="heatmap-drill-empty" role="alert">
              The Hands For {selected} Could Not Be Loaded Right Now.
            </p>
          )}
          {!handsLoading && !drillError && (classHands ?? []).length === 0 && (
            <p className="heatmap-drill-empty">
              No Individual Hands Stored For {selected} Yet Under This Filter.
            </p>
          )}
          {(classHands ?? []).length > 0 && (
            <ul className="heatmap-drill-list">
              {(classHands ?? []).map((h) => (
                <li key={h.hand_id} className="heatmap-drill-row">
                  <span className="heatmap-drill-pos">{h.position}</span>
                  <span className="heatmap-drill-date">{shortDate(h.played_at)}</span>
                  <span className="heatmap-drill-tags">
                    {h.was_all_in && <em>All In</em>}
                    {h.showdown && <em>Showdown</em>}
                  </span>
                  <span className={h.net_bb >= 0 ? 'is-up' : 'is-down'}>
                    {h.net_bb >= 0 ? '+' : ''}
                    {n(h.net_bb).toFixed(1)} BB
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="heatmap-note">
        {mode === 'frequency' &&
          'How Often You Voluntarily Played Each Hand. This Is The View That Finds Leaks Earliest, Because A Frequency Settles Down Long Before A Win Rate Does.'}
        {mode === 'profit' &&
          `Profit In Big Blinds Per 100 Hands. Cells With Fewer Than ${MIN_CONFIDENT_HANDS} Hands Are Left Grey On Purpose: At That Sample The Number Is Noise, And Colouring It Would Invent A Pattern That Is Not There.`}
        {mode === 'luck' &&
          'Actual Result Minus All-In Expected Value. This Is Variance, Not Skill. A Hand Glowing Green Here Means You Ran Well With It, Not That You Play It Well.'}
      </p>
    </div>
  );
}
