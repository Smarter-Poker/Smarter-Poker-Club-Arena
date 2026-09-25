/**
 * The Performance tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('performance')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { Suspense, lazy } from 'react';
import PanelBoundary from '../../components/stats/PanelBoundary';
import { StatRow } from './StatRow';
import { SCOPE_ALL_GAMES, SCOPE_CASH, ratioOrUnmeasured } from './format';
import type { OverallStats } from './types';

const EVLuckChart = lazy(() => import('../../components/stats/EVLuckChart'));

export interface PerformanceTabProps {
  overall: OverallStats;
  /** Display-ready, including the `%`, or Not Yet Measured (the page formats it). */
  showdownWinRate: string;
  isOwnProfile: boolean;
  panelResetKey: string;
  targetUserId: string | undefined;
  windowDays: number | null;
  printing: boolean;
}

export default function PerformanceTab({
  overall,
  showdownWinRate,
  isOwnProfile,
  panelResetKey,
  targetUserId,
  windowDays,
  printing,
}: PerformanceTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Luck first. Every number below it is a rate the player can act
          on; this is the one that tells them whether the results they are
          staring at were earned or dealt. Owner only: it is derived from
          their own per-hand records. */}
      {isOwnProfile && (
        <PanelBoundary name="EV And Luck" resetKey={panelResetKey}>
          <Suspense fallback={<div className="hand-empty hand-loading">Loading Chart...</div>}>
            <EVLuckChart userId={targetUserId} days={windowDays} still={printing} />
          </Suspense>
        </PanelBoundary>
      )}

      {/* Preflop */}
      <div>
        <div className="stats-section-header">
          <h3>Preflop</h3>
        </div>
        {/* STATS CONTRACT TRUTH (2026-09-20): every grid on this tab mixes
            cash-only money with counts over every hand, so each row carries
            its scope, and an empty sample says Not Yet Measured. */}
        <div className="stats-grid">
          <StatRow
            label="VPIP"
            value={`${(overall.vpip * 100).toFixed(1)}%`}
            color="#00d4ff"
            scope={SCOPE_ALL_GAMES}
          />
          <StatRow
            label="PFR"
            value={`${(overall.pfr * 100).toFixed(1)}%`}
            color="#8b5cf6"
            scope={SCOPE_ALL_GAMES}
          />
          <StatRow
            label="3-Bet %"
            value={`${(overall.three_bet_percent * 100).toFixed(1)}%`}
            color="#f59e0b"
            scope={SCOPE_ALL_GAMES}
          />
          <StatRow
            label="Fold To 3-Bet"
            value={`${(overall.fold_to_three_bet * 100).toFixed(1)}%`}
            color="#ef4444"
            scope={SCOPE_ALL_GAMES}
          />
        </div>
      </div>
      {/* Postflop */}
      <div>
        <div className="stats-section-header">
          <h3>Postflop</h3>
        </div>
        <div className="stats-grid">
          <StatRow
            label="C-Bet Flop"
            value={`${(overall.cbet_flop * 100).toFixed(1)}%`}
            color="#8b5cf6"
            scope={SCOPE_ALL_GAMES}
          />
          <StatRow
            label="WTSD"
            value={`${(overall.wtsd * 100).toFixed(1)}%`}
            color="#6366f1"
            scope={SCOPE_ALL_GAMES}
          />
          {/* See the Overview tab: the provable empty sample is "no hands". */}
          <StatRow
            label="Aggression Factor"
            value={ratioOrUnmeasured(overall.aggression_factor, overall.total_hands, (v) =>
              v.toFixed(2)
            )}
            color="#f59e0b"
            scope={SCOPE_ALL_GAMES}
          />
          <StatRow
            label="Showdown Win %"
            value={showdownWinRate}
            color="#22c55e"
            scope={SCOPE_ALL_GAMES}
          />
        </div>
      </div>
      {/* Results */}
      <div>
        <div className="stats-section-header">
          <h3>Results</h3>
        </div>
        <div className="stats-grid">
          <StatRow
            label="Cash Profit"
            value={overall.total_profit.toLocaleString()}
            color="#22c55e"
            highlight
          />
          <StatRow
            label="BB/100"
            value={ratioOrUnmeasured(overall.bb_per_100, overall.cash_hands, (v) => v.toFixed(2))}
            color="#4169E1"
            scope={SCOPE_CASH}
          />
          <StatRow
            label="Total Won"
            value={overall.total_winnings.toLocaleString()}
            color="#10b981"
            scope={SCOPE_CASH}
          />
          <StatRow
            label="Total Invested"
            value={overall.total_invested.toLocaleString()}
            color="#06b6d4"
            scope={SCOPE_CASH}
          />
          <StatRow
            label="Biggest Pot Won"
            value={overall.biggest_pot_won.toLocaleString()}
            color="#10b981"
            scope={SCOPE_CASH}
          />
          <StatRow
            label="Biggest Hand Loss"
            value={overall.biggest_hand_loss.toLocaleString()}
            color="#ef4444"
            scope={SCOPE_CASH}
          />
          <StatRow
            label="Hands Won"
            value={overall.hands_won.toLocaleString()}
            color="#22c55e"
            scope={SCOPE_ALL_GAMES}
          />
          <StatRow
            label="Hands Lost"
            value={overall.hands_lost.toLocaleString()}
            color="#ef4444"
            scope={SCOPE_ALL_GAMES}
          />
        </div>
      </div>
    </div>
  );
}
