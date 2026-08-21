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

import { useEffect, useMemo, useRef, useState } from 'react';
import StatsFactsService, { type HandGridCell } from '../../services/StatsFactsService';
import './HoleCardHeatmap.css';

interface Props {
  userId?: string;
  days?: number | null;
}

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

/** Below this many hands, a per-cell profit number is noise, not a signal. */
const MIN_CONFIDENT_HANDS = 30;

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
  const [mode, setMode] = useState<ViewMode>('frequency');
  const [position, setPosition] = useState<string | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    StatsFactsService.getHandGrid(userId, { position, variant, days })
      .then((payload) => {
        if (!cancelled && aliveRef.current) setCells(payload.cells ?? []);
      })
      .finally(() => {
        if (!cancelled && aliveRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, position, variant, days]);

  const byClass = useMemo(() => {
    const m = new Map<string, HandGridCell>();
    for (const c of cells ?? []) m.set(c.hand_class, c);
    return m;
  }, [cells]);

  const totalHands = useMemo(
    () => (cells ?? []).reduce((s, c) => s + c.hands, 0),
    [cells]
  );

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

  if (totalHands === 0) {
    return (
      <div className="heatmap-card heatmap-empty">
        <h3 className="heatmap-title">Starting Hands</h3>
        <p className="heatmap-empty-text">
          No hold'em hands recorded yet for this filter. The grid is built from a per-hand record
          that began collecting recently, so it fills in from your next session onward. Pot Limit
          Omaha hands never appear here: a 13x13 grid cannot represent a four to six card holding.
        </p>
      </div>
    );
  }

  return (
    <div className="heatmap-card">
      <div className="heatmap-head">
        <h3 className="heatmap-title">Starting Hands</h3>
        <p className="heatmap-sub">
          {totalHands.toLocaleString()} hands dealt across {byClass.size} of 169 starting hands.
        </p>
      </div>

      <div className="heatmap-controls">
        <div className="heatmap-modes" role="group" aria-label="View mode">
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
              onChange={(e) => setPosition(e.target.value || null)}
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
              onChange={(e) => setVariant(e.target.value || null)}
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
          aria-label="Starting hand grid, 13 by 13"
          onMouseLeave={() => setHovered(null)}
        >
          {RANKS.map((_, rowIdx) =>
            RANKS.map((__, colIdx) => {
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
                  aria-label={
                    cell
                      ? `${key}, ${hands} hands, ${cell.bb100} big blinds per 100`
                      : `${key}, never dealt`
                  }
                >
                  {key}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="heatmap-readout" aria-live="polite">
        {hoveredCell ? (
          <>
            <strong>{hoveredCell.hand_class}</strong>
            <span>{hoveredCell.hands.toLocaleString()} dealt</span>
            <span>played {(hoveredCell.vpip_pct * 100).toFixed(0)}%</span>
            <span className={hoveredCell.net_bb >= 0 ? 'is-up' : 'is-down'}>
              {hoveredCell.net_bb >= 0 ? '+' : ''}
              {hoveredCell.net_bb.toFixed(1)} bb
            </span>
            {hoveredCell.hands >= MIN_CONFIDENT_HANDS ? (
              <span className={hoveredCell.bb100 >= 0 ? 'is-up' : 'is-down'}>
                {hoveredCell.bb100 >= 0 ? '+' : ''}
                {hoveredCell.bb100.toFixed(0)} bb/100
              </span>
            ) : (
              <span className="is-thin-note">too few hands to rate</span>
            )}
          </>
        ) : (
          <span className="heatmap-readout-hint">
            {hovered ? `${hovered} - never dealt` : 'Hover a hand for its detail'}
          </span>
        )}
      </div>

      <p className="heatmap-note">
        {mode === 'frequency' &&
          'How often you voluntarily played each hand. This is the view that finds leaks earliest, because a frequency settles down long before a win rate does.'}
        {mode === 'profit' &&
          `Profit in big blinds per 100 hands. Cells with fewer than ${MIN_CONFIDENT_HANDS} hands are left grey on purpose: at that sample the number is noise, and colouring it would invent a pattern that is not there.`}
        {mode === 'luck' &&
          'Actual result minus all-in expected value. This is variance, not skill. A hand glowing green here means you ran well with it, not that you play it well.'}
      </p>
    </div>
  );
}
