/**
 * PositionalRadar — VPIP / PFR / 3-Bet plotted across every position.
 *
 * WHY THIS AND NOT PlayerStyleRadar
 * ---------------------------------
 * PlayerStyleRadar (on ProfilePage) plots six DERIVED personality axes —
 * Aggression, Tightness, Bluff Frequency and so on. It answers "what kind of
 * player am I". This answers a different and more actionable question: "is my
 * positional discipline the right shape".
 *
 * A winning player's VPIP rises monotonically from UTG to the button, because
 * acting last is worth more than any two cards. A losing player's is flat, or
 * inverted. That shape is invisible in a table of numbers and obvious the
 * instant it is a polygon, which is the entire reason this chart exists.
 *
 * DATA: pure presentation. It takes the `positions` array the stats page has
 * ALREADY loaded from ca_player_stats_full and passes to PositionWinRates —
 * no fetch, no cache, no loading state of its own. That also makes it
 * trivially testable.
 *
 * SCALE TRAP: ca_player_stats_full returns rates as FRACTIONS (0..1) while
 * player_position_stats (which PlayerStyleRadar reads) is PERCENT-scaled. This
 * component sidesteps both by taking raw counts and dividing them itself. Do
 * not port normalisation code in from PlayerStyleRadar without re-checking.
 */

import { useMemo, useState } from 'react';
import './PositionalRadar.css';

export interface PositionalRadarRow {
  position: string;
  hands_played: number;
  vpip_count: number;
  pfr_count: number;
  three_bet_count: number;
  /** Chances to re-raise. Present since the 2026-09-03 stats migration. */
  three_bet_opps?: number;
  hands_won?: number;
  total_profit?: number;
  bb100?: number;
}

interface Props {
  positions: PositionalRadarRow[] | null | undefined;
  /**
   * Below this many hands in a position, the axis is drawn dimmed and flagged.
   * 30 hands is roughly where a frequency stops being an accident.
   */
  minHands?: number;
}

/**
 * Table order, early to late. Positions arriving from the RPC that are not on
 * this list (or future additions) are appended rather than dropped, so the
 * chart can never silently hide a position a player actually played.
 */
const POSITION_ORDER = ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

type MetricKey = 'vpip' | 'pfr' | 'three_bet';

interface MetricDef {
  key: MetricKey;
  label: string;
  color: string;
  /** Each metric is normalised against its own realistic ceiling so all three
   *  are legible on one radius. Raw percentages are shown on the axis labels
   *  so the normalisation never has to be explained to anyone. */
  ceiling: number;
  count: (r: PositionalRadarRow) => number;
  /** The denominator the rate is over. VPIP and PFR are per hand dealt. */
  denom: (r: PositionalRadarRow) => number;
}

const METRICS: MetricDef[] = [
  {
    key: 'vpip',
    label: 'VPIP',
    color: '#3b82f6',
    ceiling: 60,
    count: (r) => r.vpip_count,
    denom: (r) => r.hands_played,
  },
  {
    key: 'pfr',
    label: 'PFR',
    color: '#22c55e',
    ceiling: 40,
    count: (r) => r.pfr_count,
    denom: (r) => r.hands_played,
  },
  {
    /**
     * 3-bet is per OPPORTUNITY, the same convention as the reference values
     * and the 15% ceiling below. It was per hand dealt, so a healthy 7% 3-bet
     * plotted at roughly 1.5% against a dashed reference drawn at 7% - the
     * denominator collision statBenchmarks.ts exists to prevent. Payloads
     * without three_bet_opps fall back to per hand dealt and say so.
     */
    key: 'three_bet',
    label: '3-Bet',
    color: '#f59e0b',
    ceiling: 15,
    count: (r) => r.three_bet_count,
    denom: (r) =>
      typeof r.three_bet_opps === 'number' && r.three_bet_opps > 0
        ? r.three_bet_opps
        : r.hands_played,
  },
];

/**
 * A general reference shape, not a rule. These are broadly conventional
 * opening frequencies: VPIP climbing toward the button, the big blind wide
 * because it is already partly invested, the small blind tighter because it is
 * out of position for the rest of the hand.
 *
 * Shown dashed and clearly labelled as a reference, and it can be switched
 * off. It is here because "you are playing the button tighter than UTG" is a
 * finding a player can act on tonight, and without something to compare
 * against, a radar chart is just a decorative shape.
 */
const REFERENCE: Record<string, Record<MetricKey, number>> = {
  UTG: { vpip: 15, pfr: 13, three_bet: 4 },
  'UTG+1': { vpip: 16, pfr: 14, three_bet: 4 },
  MP: { vpip: 18, pfr: 15, three_bet: 5 },
  LJ: { vpip: 20, pfr: 17, three_bet: 5 },
  HJ: { vpip: 23, pfr: 19, three_bet: 6 },
  CO: { vpip: 27, pfr: 22, three_bet: 7 },
  BTN: { vpip: 35, pfr: 28, three_bet: 8 },
  SB: { vpip: 25, pfr: 20, three_bet: 9 },
  BB: { vpip: 40, pfr: 12, three_bet: 11 },
};

const SIZE = 260;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 88;
const RINGS = [0.25, 0.5, 0.75, 1];

function pointAt(index: number, total: number, radius: number): [number, number] {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return [CX + Math.cos(angle) * radius, CY + Math.sin(angle) * radius];
}

function toPath(values: number[]): string {
  if (values.length === 0) return '';
  return (
    values
      .map((v, i) => {
        const [x, y] = pointAt(i, values.length, Math.max(0, Math.min(1, v)) * R);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ') + ' Z'
  );
}

const pct = (n: number, d: number): number => (d > 0 ? (n / d) * 100 : 0);

export default function PositionalRadar({ positions, minHands = 30 }: Props) {
  const [visible, setVisible] = useState<Record<MetricKey, boolean>>({
    vpip: true,
    pfr: true,
    three_bet: false,
  });
  const [showReference, setShowReference] = useState(true);
  const [focused, setFocused] = useState<number | null>(null);

  const rows = useMemo(() => {
    const src = (positions ?? []).filter((p) => p && p.hands_played > 0);
    const rank = (p: string) => {
      const i = POSITION_ORDER.indexOf(p);
      return i === -1 ? POSITION_ORDER.length + 1 : i;
    };
    return [...src].sort((a, b) => rank(a.position) - rank(b.position));
  }, [positions]);

  const total = rows.length;

  const series = useMemo(() => {
    const out: Record<MetricKey, number[]> = { vpip: [], pfr: [], three_bet: [] };
    for (const m of METRICS) {
      out[m.key] = rows.map((r) => pct(m.count(r), m.denom(r)) / m.ceiling);
    }
    return out;
  }, [rows]);

  /**
   * The reference shape is only drawn when EVERY axis has a reference value.
   * Previously a position with no entry fell back to 0, spiking the dashed
   * polygon to the centre and reading as "the reference says play 0% from
   * here". POSITION_ORDER deliberately tolerates unknown positions by
   * appending them, and the RPC can emit 'UNK', so this was reachable.
   */
  const referenceComplete = useMemo(
    () => rows.length > 0 && rows.every((r) => REFERENCE[r.position] !== undefined),
    [rows]
  );

  const referenceSeries = useMemo(() => {
    const out: Record<MetricKey, number[]> = { vpip: [], pfr: [], three_bet: [] };
    if (!referenceComplete) return out;
    for (const m of METRICS) {
      out[m.key] = rows.map((r) => (REFERENCE[r.position]?.[m.key] ?? 0) / m.ceiling);
    }
    return out;
  }, [rows, referenceComplete]);

  // Three axes is the minimum that makes a closed polygon mean anything; below
  // that a radar is a line segment and misleads more than it shows.
  if (total < 3) {
    return (
      <div className="pos-radar-card pos-radar-empty">
        <h3 className="pos-radar-title">Positional Shape</h3>
        <p className="pos-radar-empty-text">
          Play Hands From At Least Three Different Positions And Your Positional Shape Will Appear
          Here.
        </p>
      </div>
    );
  }

  const lowSample = rows.filter((r) => r.hands_played < minHands);
  const activeRow = focused !== null ? rows[focused] : null;

  return (
    <div className="pos-radar-card">
      <div className="pos-radar-head">
        <div>
          <h3 className="pos-radar-title">Positional Shape</h3>
          <p className="pos-radar-sub">
            Strong Positional Play Widens Toward The Button. A Flat Or Inverted Web Is A Leak.
          </p>
        </div>
      </div>

      <div className="pos-radar-body">
        <div className="pos-radar-chart-wrap">
          <svg
            className="pos-radar-svg"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            role="img"
            aria-label={
              METRICS.some((m) => visible[m.key])
                ? `Radar Chart Of ${METRICS.filter((m) => visible[m.key])
                    .map((m) => m.label)
                    .join(', ')} Across ${total} Positions`
                : `Radar Chart Across ${total} Positions, No Metrics Currently Shown`
            }
          >
            <defs>
              {METRICS.map((m) => (
                <radialGradient key={m.key} id={`pos-radar-grad-${m.key}`}>
                  <stop offset="0%" stopColor={m.color} stopOpacity="0.34" />
                  <stop offset="100%" stopColor={m.color} stopOpacity="0.08" />
                </radialGradient>
              ))}
            </defs>

            {/* Rings */}
            {RINGS.map((ring) => (
              <path
                key={ring}
                className="pos-radar-ring"
                d={toPath(new Array(total).fill(ring))}
                fill="none"
              />
            ))}

            {/* Spokes */}
            {rows.map((r, i) => {
              const [x, y] = pointAt(i, total, R);
              return (
                <line
                  key={`spoke-${r.position}`}
                  className="pos-radar-spoke"
                  x1={CX}
                  y1={CY}
                  x2={x}
                  y2={y}
                />
              );
            })}

            {/* Reference shape, dashed and behind the data */}
            {showReference &&
              referenceComplete &&
              METRICS.filter((m) => visible[m.key]).map((m) => (
                <path
                  key={`ref-${m.key}`}
                  className="pos-radar-reference"
                  d={toPath(referenceSeries[m.key])}
                  stroke={m.color}
                  fill="none"
                />
              ))}

            {/* Data polygons */}
            {METRICS.filter((m) => visible[m.key]).map((m) => (
              <path
                key={`data-${m.key}`}
                d={toPath(series[m.key])}
                fill={`url(#pos-radar-grad-${m.key})`}
                stroke={m.color}
                strokeWidth={2}
                strokeLinejoin="round"
                style={{ transformOrigin: `${CX}px ${CY}px` }}
              />
            ))}

            {/* Vertices — hover/focus targets */}
            {METRICS.filter((m) => visible[m.key]).map((m) =>
              series[m.key].map((v, i) => {
                const [x, y] = pointAt(i, total, Math.max(0, Math.min(1, v)) * R);
                return (
                  <circle
                    key={`dot-${m.key}-${i}`}
                    className="pos-radar-dot"
                    cx={x}
                    cy={y}
                    r={focused === i ? 4 : 2.6}
                    fill={m.color}
                  />
                );
              })
            )}

            {/* Axis labels */}
            {rows.map((r, i) => {
              const [x, y] = pointAt(i, total, R + 22);
              const dim = r.hands_played < minHands;
              return (
                <text
                  key={`label-${r.position}`}
                  className={`pos-radar-axis-label${dim ? ' is-dim' : ''}${
                    focused === i ? ' is-focused' : ''
                  }`}
                  x={x}
                  y={y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  /* Tap and keyboard reach it too (2026-08-29): hover was the
                     only way to focus an axis, so on a phone the radar could
                     not be interrogated at all. */
                  tabIndex={0}
                  role="button"
                  onMouseEnter={() => setFocused(i)}
                  onMouseLeave={() => setFocused(null)}
                  onFocus={() => setFocused(i)}
                  onBlur={() => setFocused(null)}
                  onClick={() => setFocused((cur) => (cur === i ? null : i))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setFocused((cur) => (cur === i ? null : i));
                    }
                  }}
                >
                  {r.position}
                </text>
              );
            })}
          </svg>
        </div>

        <div className="pos-radar-side">
          <div className="pos-radar-legend" role="group" aria-label="Metrics">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                className={`pos-radar-toggle${visible[m.key] ? ' is-on' : ''}`}
                aria-pressed={visible[m.key]}
                onClick={() => setVisible((v) => ({ ...v, [m.key]: !v[m.key] }))}
              >
                <span className="pos-radar-swatch" style={{ background: m.color }} />
                {m.label}
              </button>
            ))}
            {referenceComplete && (
              <button
                type="button"
                className={`pos-radar-toggle pos-radar-toggle-ref${showReference ? ' is-on' : ''}`}
                aria-pressed={showReference}
                onClick={() => setShowReference((s) => !s)}
              >
                <span className="pos-radar-swatch is-dashed" />
                Reference
              </button>
            )}
          </div>

          <table className="pos-radar-table">
            <thead>
              <tr>
                <th scope="col">Pos</th>
                <th scope="col">Hands</th>
                {METRICS.filter((m) => visible[m.key]).map((m) => (
                  <th scope="col" key={m.key}>
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.position}
                  className={`${r.hands_played < minHands ? 'is-dim' : ''}${
                    focused === i ? ' is-focused' : ''
                  }`}
                  /* The table row highlights its matching radar axis. On a
                     phone that link did not exist, because it was hover-only. */
                  tabIndex={0}
                  onMouseEnter={() => setFocused(i)}
                  onMouseLeave={() => setFocused(null)}
                  onFocus={() => setFocused(i)}
                  onBlur={() => setFocused(null)}
                  onClick={() => setFocused((cur) => (cur === i ? null : i))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setFocused((cur) => (cur === i ? null : i));
                    }
                  }}
                >
                  <th scope="row">{r.position}</th>
                  <td>{r.hands_played.toLocaleString()}</td>
                  {METRICS.filter((m) => visible[m.key]).map((m) => (
                    <td key={m.key} style={{ color: m.color }}>
                      {pct(m.count(r), m.denom(r)).toFixed(1)}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {activeRow && (
        <p className="pos-radar-readout">
          <strong>{activeRow.position}</strong>: {activeRow.hands_played.toLocaleString()} Hands,
          VPIP {pct(activeRow.vpip_count, activeRow.hands_played).toFixed(1)}%, PFR{' '}
          {pct(activeRow.pfr_count, activeRow.hands_played).toFixed(1)}%, 3-Bet{' '}
          {pct(activeRow.three_bet_count, activeRow.hands_played).toFixed(1)}%
        </p>
      )}

      {lowSample.length > 0 && (
        <p className="pos-radar-note">
          Dimmed Positions Have Under {minHands} Hands, Which Is Too Few To Read Anything Into:{' '}
          {lowSample.map((r) => r.position).join(', ')}.
        </p>
      )}
      {showReference && referenceComplete && (
        <p className="pos-radar-note">
          The Dashed Shape Is A Conventional Opening-Frequency Reference Written Into This Chart,
          Not A Measurement Of Any Field. It Is A Comparison Point, Not A Target.
        </p>
      )}
    </div>
  );
}
