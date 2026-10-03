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
import { CHIP_STATS, type StatsClubId, type StatsScope } from '../../services/statsScope';
import { StatRow } from './StatRow';
import { NOT_YET_MEASURED, SCOPE_ALL_GAMES, SCOPE_CASH, ratioOrUnmeasured } from './format';
import type { OverallStats } from './types';
import type { StatsMetricAvailabilityContract } from '../../services/statsContract';
import { formatRateEvidence, formatSampleEvidence } from './binomialConfidence';
import type { CashOpportunityStats } from '../../services/StatsFactsService';
import type { CashEvidenceMetric } from '../../components/stats/CashIntelligencePanel';

const EVLuckChart = lazy(() => import('../../components/stats/EVLuckChart'));
const CashIntelligencePanel = lazy(() => import('../../components/stats/CashIntelligencePanel'));

export interface PerformanceTabProps {
  /** The asset the page reads: chips, or Diamonds in the Diamond Arena. */
  scope?: StatsScope;
  clubId?: StatsClubId;
  metricAvailability: StatsMetricAvailabilityContract;
  overall: OverallStats;
  /** Display-ready, including the `%`, or Not Yet Measured (the page formats it). */
  showdownWinRate: string;
  isOwnProfile: boolean;
  panelResetKey: string;
  targetUserId: string | undefined;
  windowDays: number | null;
  printing: boolean;
  cashOpportunityStats?: CashOpportunityStats | null;
  cashOpportunityLoading?: boolean;
  cashOpportunityError?: string | null;
  onRetryCashOpportunities?: () => void;
  onOpenCashEvidence?: (metric: CashEvidenceMetric) => void;
}

export default function PerformanceTab({
  scope = CHIP_STATS,
  clubId = null,
  metricAvailability,
  overall,
  showdownWinRate,
  isOwnProfile,
  panelResetKey,
  targetUserId,
  windowDays,
  printing,
  cashOpportunityStats = null,
  cashOpportunityLoading = false,
  cashOpportunityError = null,
  onRetryCashOpportunities,
  onOpenCashEvidence,
}: PerformanceTabProps) {
  const exactThreeBet = cashOpportunityStats?.opportunities.three_bet;
  const exactCbet = cashOpportunityStats?.opportunities.cbet_flop;
  const threeBetMeasured = Boolean(exactThreeBet && exactThreeBet.opportunities > 0);
  const cbetMeasured = Boolean(exactCbet && exactCbet.opportunities > 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Luck first. Every number below it is a rate the player can act
          on; this is the one that tells them whether the results they are
          staring at were earned or dealt. Owner only: it is derived from
          their own per-hand records. */}
      {isOwnProfile && (
        <PanelBoundary name="EV And Luck" resetKey={panelResetKey}>
          <Suspense fallback={<div className="hand-empty hand-loading">Loading Chart...</div>}>
            <EVLuckChart
              userId={targetUserId}
              days={windowDays}
              still={printing}
              scope={scope}
              clubId={clubId}
            />
          </Suspense>
        </PanelBoundary>
      )}

      {isOwnProfile && (
        <PanelBoundary name="Cash Intelligence" resetKey={panelResetKey}>
          <Suspense
            fallback={<div className="hand-empty hand-loading">Loading Cash Intelligence...</div>}
          >
            <CashIntelligencePanel
              data={cashOpportunityStats}
              loading={cashOpportunityLoading}
              error={cashOpportunityError}
              onRetry={onRetryCashOpportunities}
              onOpenEvidence={onOpenCashEvidence}
            />
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
            evidence={formatRateEvidence(overall.vpip, overall.total_hands)}
          />
          <StatRow
            label="PFR"
            value={`${(overall.pfr * 100).toFixed(1)}%`}
            color="#8b5cf6"
            scope={SCOPE_ALL_GAMES}
            evidence={formatRateEvidence(overall.pfr, overall.total_hands)}
          />
          <StatRow
            label="3-Bet %"
            value={
              exactThreeBet
                ? threeBetMeasured
                  ? `${((exactThreeBet.actions / exactThreeBet.opportunities) * 100).toFixed(1)}%`
                  : NOT_YET_MEASURED
                : metricAvailability?.three_bet_percent !== true
                  ? NOT_YET_MEASURED
                  : `${(overall.three_bet_percent * 100).toFixed(1)}%`
            }
            color="#f59e0b"
            scope={exactThreeBet ? SCOPE_CASH : SCOPE_ALL_GAMES}
            evidence={formatRateEvidence(
              exactThreeBet && threeBetMeasured
                ? exactThreeBet.actions / exactThreeBet.opportunities
                : overall.three_bet_percent,
              exactThreeBet?.opportunities ?? metricAvailability?.three_bet_opportunities,
              exactThreeBet ? threeBetMeasured : metricAvailability?.three_bet_percent === true
            )}
          />
          <StatRow
            label="Fold To 3-Bet"
            value={
              metricAvailability?.fold_to_three_bet !== true
                ? NOT_YET_MEASURED
                : `${(overall.fold_to_three_bet * 100).toFixed(1)}%`
            }
            color="#ef4444"
            scope={SCOPE_ALL_GAMES}
            evidence={formatRateEvidence(
              overall.fold_to_three_bet,
              metricAvailability?.fold_to_three_bet_opportunities,
              metricAvailability?.fold_to_three_bet === true
            )}
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
            value={
              exactCbet
                ? cbetMeasured
                  ? `${((exactCbet.actions / exactCbet.opportunities) * 100).toFixed(1)}%`
                  : NOT_YET_MEASURED
                : metricAvailability?.cbet_flop !== true
                  ? NOT_YET_MEASURED
                  : `${(overall.cbet_flop * 100).toFixed(1)}%`
            }
            color="#8b5cf6"
            scope={exactCbet ? SCOPE_CASH : SCOPE_ALL_GAMES}
            evidence={formatRateEvidence(
              exactCbet && cbetMeasured
                ? exactCbet.actions / exactCbet.opportunities
                : overall.cbet_flop,
              exactCbet?.opportunities ?? metricAvailability?.cbet_flop_opportunities,
              exactCbet ? cbetMeasured : metricAvailability?.cbet_flop === true
            )}
          />
          <StatRow
            label="WTSD"
            value={
              metricAvailability?.wtsd !== true
                ? NOT_YET_MEASURED
                : `${(overall.wtsd * 100).toFixed(1)}%`
            }
            color="#6366f1"
            scope={SCOPE_ALL_GAMES}
            evidence={formatRateEvidence(
              overall.wtsd,
              metricAvailability?.wtsd_opportunities,
              metricAvailability?.wtsd === true
            )}
          />
          {/* See the Overview tab: the provable empty sample is "no hands". */}
          <StatRow
            label="Aggression Factor"
            value={
              metricAvailability?.aggression_factor !== true
                ? NOT_YET_MEASURED
                : ratioOrUnmeasured(overall.aggression_factor, overall.total_hands, (v) =>
                    v.toFixed(2)
                  )
            }
            color="#f59e0b"
            scope={SCOPE_ALL_GAMES}
            evidence={formatSampleEvidence(
              metricAvailability?.aggression_factor_denominator,
              'Passive Action',
              'Passive Actions',
              metricAvailability?.aggression_factor === true
            )}
          />
          <StatRow
            label="Showdown Win %"
            value={showdownWinRate}
            color="#22c55e"
            scope={SCOPE_ALL_GAMES}
            evidence={formatRateEvidence(
              overall.showdowns_won / overall.showdowns_total,
              overall.showdowns_total
            )}
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
            evidence={formatSampleEvidence(overall.cash_hands, 'Cash Hand')}
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
