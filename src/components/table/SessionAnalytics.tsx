/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION ANALYTICS — Detailed session panel behind "Detailed Analytics"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every number on this panel is read from SessionStatsService, which is fed
 * once per completed hand by TablePage (recordHand) and on every top-up
 * (recordRebuy). Nothing here is derived from anything but that record.
 *
 * WHAT WAS HERE, AND WHY IT IS GONE (2026-09-10, audit CL-1, CRITICAL)
 *
 * Until today this panel had four tabs, and three of them were invented:
 *
 *   - Positions: hands per position was handsPlayed/7 plus random(3), hands
 *     won was hands x (0.2 + random x 0.3), the displayed win rate came from
 *     that, and the per-position net was round((random - 0.45) x P&L / 7),
 *     which did not sum to the session P&L and could show a winning position
 *     as losing.
 *   - Actions: fold / call / raise / all-in percentages were pure
 *     Math.random() with an empty dependency array.
 *   - Pots: five pots of round(500 + random x 3000), won or lost by coin flip,
 *     with hand ids minted from Date.now().
 *
 * A player opened "Detailed Analytics" and was shown a record of their own
 * session that nobody had recorded. That is the single worst finding in the
 * 2026-09-08 audit and it is the reason
 * `tests/a-player-is-never-shown-an-invented-number.law.test.ts` exists: a
 * component under src/components or src/pages may not call Math.random()
 * unless it is on that law's allowlist with a stated non-data reason, and may
 * not carry a sample-data generator at all.
 *
 * SessionStatsService does not track the hero's position or per-street
 * actions, so there is no honest per-position or per-action breakdown to
 * show. The panel therefore shows what IS recorded - the P&L, the trajectory
 * and the six session counters - and nothing else. When the service records
 * position and action per hand, those views can return, fed from the record.
 * Do not bring them back fed from anything else.
 */

import { useMemo } from 'react';
import type { SessionStats } from '../../services/SessionStatsService';
import './SessionAnalytics.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionAnalyticsProps {
  isOpen: boolean;
  onClose: () => void;
  stats: SessionStats;
  currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SessionAnalytics({ isOpen, onClose, stats, currency = '' }: SessionAnalyticsProps) {
  // ── Sparkline rendering (from the recorded trajectory) ──
  const sparklinePoints = useMemo(() => {
    if (!stats.trajectory || stats.trajectory.length < 2) return '';
    const values = stats.trajectory.map((t) => t[1]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const width = 300;
    const height = 100;
    return values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * width;
        const y = height - ((v - min) / range) * (height - 8) - 4;
        return `${x},${y}`;
      })
      .join(' ');
  }, [stats.trajectory]);

  const plClass = stats.profitLoss >= 0 ? 'sa-positive' : 'sa-negative';

  if (!isOpen) return null;

  return (
    <div className="session-analytics-overlay" onClick={onClose}>
      <div className="session-analytics" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sa-header">
          <h2 className="sa-header__title">Session Analytics</h2>
          <button className="sa-header__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="sa-content">
          {/* Hero P&L */}
          <div className="sa-hero">
            <span className="sa-hero__label">Session P&L</span>
            <span className={`sa-hero__value ${plClass}`}>
              {stats.profitLoss >= 0 ? '+' : ''}
              {currency}
              {stats.profitLoss.toLocaleString()}
            </span>
            <span className="sa-hero__bb">
              ({stats.bigBlindsWon >= 0 ? '+' : ''}
              {stats.bigBlindsWon.toFixed(1)} BB)
            </span>
          </div>

          {/* P&L Chart */}
          {sparklinePoints && (
            <div className="sa-chart">
              <svg viewBox="0 0 300 100" preserveAspectRatio="none">
                <polyline
                  points={sparklinePoints}
                  fill="none"
                  stroke={stats.profitLoss >= 0 ? '#3fb950' : '#ef4444'}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          )}

          {/* Session counters, every one recorded by SessionStatsService */}
          <div className="sa-grid">
            <div className="sa-grid__item">
              <span className="sa-grid__value">{stats.handsPlayed}</span>
              <span className="sa-grid__label">Hands</span>
            </div>
            <div className="sa-grid__item">
              <span className="sa-grid__value">{stats.handsWon}</span>
              <span className="sa-grid__label">Won</span>
            </div>
            <div className="sa-grid__item">
              <span className="sa-grid__value">{stats.handsPerHour}</span>
              <span className="sa-grid__label">H/Hour</span>
            </div>
            <div className="sa-grid__item">
              <span className="sa-grid__value">{stats.vpipPercent}%</span>
              <span className="sa-grid__label">VPIP</span>
            </div>
            <div className="sa-grid__item">
              <span className="sa-grid__value">{stats.pfrPercent}%</span>
              <span className="sa-grid__label">PFR</span>
            </div>
            <div className="sa-grid__item">
              <span className={`sa-grid__value ${plClass}`}>
                {stats.handsPlayed > 0
                  ? ((stats.bigBlindsWon / stats.handsPlayed) * 100).toFixed(1)
                  : '0.0'}
              </span>
              <span className="sa-grid__label">BB/100</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SessionAnalytics;
