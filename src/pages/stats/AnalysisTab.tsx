/**
 * The Analysis tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('analysis')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { Suspense, lazy, useMemo, type ReactNode } from 'react';
import PanelBoundary from '../../components/stats/PanelBoundary';
import LeakPanel from '../../components/stats/LeakPanel';
import type { AdvancedStatsInput } from '../../components/stats/AdvancedStatsSummary';
import { formatCard, handDate } from './format';
import StatsEvidenceLink from '../../components/stats/StatsEvidenceLink';
import { buildStatsHandEvidencePath } from '../../lib/statsEvidenceNavigation';
import { localDateFromYmd } from '../../lib/localTime';
import { compactChips } from '../../utils/format';
import { reportError } from '../../utils/errorReporter';
import { enumToTitleCase } from '../../utils/titleCase';
import type { StatsContractMetadata } from '../../services/statsContract';
import type { StatsScope } from '../../services/statsScope';
import {
  RANGES,
  type FullStats,
  type HandEvidenceFilter,
  type HandMode,
  type HandRow,
  type OverallStats,
  type SessionRow,
  type TournamentSummary,
} from './types';

const StatsCharts = lazy(() => import('../../components/stats/StatsCharts'));
const BankrollTracker = lazy(() => import('../../components/stats/BankrollTracker'));
const SessionHistory = lazy(() => import('../../components/stats/SessionHistory'));
const AdvancedStatsSummary = lazy(() => import('../../components/stats/AdvancedStatsSummary'));

export interface AnalysisTabProps {
  overall: OverallStats;
  full: FullStats | null;
  panelResetKey: string;
  targetUserId: string | undefined;
  rangeKey: string;
  rangeLabel: string;
  printing: boolean;
  advancedInitialData: AdvancedStatsInput;
  sessionRows: SessionRow[];
  sessionsAvailable: boolean;
  sessionsReason: string | null;
  exportContext: {
    clubName: string;
    timezone: string;
    asset: StatsScope;
    contract: StatsContractMetadata;
    tournaments: TournamentSummary;
    privacyPresentationMode: boolean;
  };
  handMode: HandMode;
  setHandMode: (mode: HandMode) => void;
  hands: HandRow[] | null;
  handsLoading: boolean;
  handsError: boolean;
  setHandsReload: (fn: (n: number) => number) => void;
  openHandEvidence: (filter?: HandEvidenceFilter) => void;
  clubId?: string | null;
  exactSessionPanel?: ReactNode;
}

export default function AnalysisTab({
  overall,
  full,
  panelResetKey,
  targetUserId,
  rangeKey,
  rangeLabel,
  printing,
  advancedInitialData,
  sessionRows,
  sessionsAvailable,
  sessionsReason,
  exportContext,
  handMode,
  setHandMode,
  hands,
  handsLoading,
  handsError,
  setHandsReload,
  openHandEvidence,
  clubId = null,
  exactSessionPanel,
}: AnalysisTabProps) {
  const dailySeries = useMemo(() => {
    let cumulative = 0;
    return (full?.daily ?? []).map((day) => {
      cumulative += day.profit || 0;
      return {
        // The server cuts this local calendar day in the player's timezone.
        date: localDateFromYmd(day.date).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
        profit: day.profit || 0,
        hands: day.hands || 0,
        cumulative: Math.round(cumulative * 100) / 100,
      };
    });
  }, [full?.daily]);
  const positionPie = useMemo(
    () =>
      (full?.positions ?? [])
        .filter((position) => position.hands_won > 0)
        .map((position) => ({ name: position.position, value: position.hands_won })),
    [full?.positions]
  );

  /** Text alternatives stay with the Analysis-only charts they describe. */
  const profitChartSummary = useMemo(() => {
    if (dailySeries.length === 0) return 'No cash results in this range.';
    const last = dailySeries[dailySeries.length - 1];
    const best = dailySeries.reduce((a, b) => (b.profit > a.profit ? b : a));
    const worst = dailySeries.reduce((a, b) => (b.profit < a.profit ? b : a));
    return `Cumulative cash profit across ${dailySeries.length.toLocaleString()} days, ${dailySeries[0].date} to ${last.date}, ending at ${compactChips(last.cumulative)}. Best day ${best.date} at ${compactChips(best.profit)}. Worst day ${worst.date} at ${compactChips(worst.profit)}.`;
  }, [dailySeries]);
  const dailyChartSummary = useMemo(() => {
    if (dailySeries.length === 0) return 'No daily results in this range.';
    const up = dailySeries.filter((day) => day.profit > 0).length;
    return `Daily cash result for ${dailySeries.length.toLocaleString()} days. ${up.toLocaleString()} winning days, ${(dailySeries.length - up).toLocaleString()} losing or break-even.`;
  }, [dailySeries]);
  const positionChartSummary = useMemo(() => {
    if (positionPie.length === 0) return 'No positional data in this range.';
    return `Hands won by position: ${positionPie
      .map((position) => `${position.name} ${position.value.toLocaleString()}`)
      .join(', ')}.`;
  }, [positionPie]);

  const exportMetadata = () => ({
    clubId,
    clubName: exportContext.clubName,
    range: rangeLabel === 'All' ? 'All Time' : `Last ${rangeLabel}`,
    timezone: exportContext.timezone,
    asset: exportContext.asset,
    unit: exportContext.asset,
    coverage: JSON.stringify({
      analysis_hand_cap: exportContext.contract.coverage.analysis_hand_cap,
      analysis_hands_capped: exportContext.contract.coverage.analysis_hands_capped,
      lifetime_index_complete: exportContext.contract.coverage.lifetime_index_complete,
      rollup_covered_through: exportContext.contract.coverage.rollup_covered_through,
      club_breakdown_starts_at: exportContext.contract.quality.club_breakdown_starts_at,
    }),
    source: exportContext.contract.quality.cash_money_source,
    schemaVersion: exportContext.contract.contract_version,
    generatedAt: exportContext.contract.generated_at,
    privacyPresentationMode: exportContext.privacyPresentationMode,
  });
  const exportSessionsCSV = async () => {
    try {
      const { exportStatsSessions } = await import('./statsCsvExport');
      exportStatsSessions(
        sessionRows.map((session) => ({
          date: new Date(session.date).toLocaleString(),
          ended: session.ended ? new Date(session.ended).toLocaleString() : '',
          duration_minutes: session.duration_minutes,
          hands: session.hands_played,
          buy_in: session.buy_in,
          cash_out: session.cash_out,
          profit: session.profit_loss,
        })),
        exportMetadata(),
        `player_session_history_${clubId ?? 'all_clubs'}_${rangeKey}.csv`
      );
    } catch (error) {
      reportError(error, 'PlayerStatsPage.exportSessionsCSV');
    }
  };
  const exportOverviewCSV = async () => {
    try {
      const { exportStatsOverview } = await import('./statsCsvExport');
      const rateFields = new Set([
        'vpip',
        'pfr',
        'three_bet_percent',
        'fold_to_three_bet',
        'cbet_flop',
        'wtsd',
        'itm_percent',
        'roi',
      ]);
      const availability = exportContext.contract.quality.metric_availability;
      const tournaments = exportContext.tournaments;
      exportStatsOverview(
        {
          ...overall,
          three_bet_percent:
            clubId && !availability.three_bet_percent ? 'Unavailable' : overall.three_bet_percent,
          fold_to_three_bet:
            clubId && !availability.fold_to_three_bet ? 'Unavailable' : overall.fold_to_three_bet,
          cbet_flop: clubId && !availability.cbet_flop ? 'Unavailable' : overall.cbet_flop,
          aggression_factor:
            clubId && !availability.aggression_factor ? 'Unavailable' : overall.aggression_factor,
          wtsd: clubId && !availability.wtsd ? 'Unavailable' : overall.wtsd,
          hours_played: clubId && !availability.hours_played ? 'Unavailable' : overall.hours_played,
          tournament_entries: tournaments.entries,
          tournament_cashes: tournaments.cashes,
          tournament_wins: tournaments.wins,
          tournament_best_finish: tournaments.best_finish ?? '',
          tournament_total_buyins: tournaments.total_buyins,
          tournament_total_winnings: tournaments.total_winnings,
          tournament_total_prizes: tournaments.total_prizes,
          tournament_total_bounty_winnings: tournaments.total_bounty_winnings,
          tournament_total_bounties: tournaments.total_bounties,
          tournament_net_profit: tournaments.net_profit,
          itm_percent: tournaments.itm_percent,
          roi: tournaments.roi,
        },
        rateFields,
        exportMetadata(),
        `player_stats_overview_${clubId ?? 'all_clubs'}_${rangeKey}.csv`
      );
    } catch (error) {
      reportError(error, 'PlayerStatsPage.exportOverviewCSV');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {exactSessionPanel}
      {/* The coach first (phase 2, 2026-09-04). findLeaks was built, tested
              and exported on 2026-08-25 and then rendered nowhere. It is a pure
              function over the overall rates and the per-position counts this
              page already holds, declares a minimum sample per rule, ranks by
              cost, and says the consequence rather than the statistic. */}
      <PanelBoundary name="What To Work On" resetKey={panelResetKey}>
        <LeakPanel overall={overall} positions={full?.positions} still={printing} />
      </PanelBoundary>

      {/* Advanced Stats */}
      <div>
        <div className="stats-section-header">
          <h3>Advanced Stats</h3>
        </div>
        <PanelBoundary name="Advanced Stats" resetKey={panelResetKey}>
          <AdvancedStatsSummary initialData={advancedInitialData} rangeLabel={rangeLabel} />
        </PanelBoundary>
      </div>

      {/* Charts */}
      <PanelBoundary name="Charts" resetKey={panelResetKey}>
        <Suspense
          fallback={
            <div className="charts-section hand-loading">
              <div className="stats-section-header">
                <h3>Charts</h3>
              </div>
              <div className="hand-empty">Loading Charts...</div>
            </div>
          }
        >
          <StatsCharts
            dailySeries={dailySeries}
            positionPie={positionPie}
            profitChartSummary={profitChartSummary}
            dailyChartSummary={dailyChartSummary}
            positionChartSummary={positionChartSummary}
            rangeLabel={RANGES.find((r) => r.key === rangeKey)?.label ?? 'All Time'}
            // recharts animates its entrance over 1500ms and the print
            // fires at 1200ms, so without this all three charts were
            // caught mid-draw in the PDF. EVLuckChart already took
            // `still`; these three never did, despite the comment on
            // printDossier claiming otherwise.
            still={printing}
            sessionRows={sessionRows}
            onExportSessions={exportSessionsCSV}
            onExportOverview={exportOverviewCSV}
          />
        </Suspense>
      </PanelBoundary>

      {/* Notable hands - every stat above used to be a dead end. */}
      <PanelBoundary name="Notable Hands" resetKey={panelResetKey}>
        <div>
          {/* ALL TIME ON A RANGE-SCOPED PAGE (Stats contract truth, 2026-09-20).
              ca_player_hands_v2 takes no window argument, and the loader in
              PlayerStatsPage leaves rangeKey out of its dependencies on
              purpose. Every other heading here is read against the range
              selector, so an unmarked "Notable Hands" read as "the biggest
              pots of the last 7 days". It is the biggest pots ever, and the
              header now says so, in the page's existing caption style. */}
          <div className="stats-section-header">
            <h3>Notable Hands</h3>
            <span className="hero-stat-sub">All Time</span>
          </div>
          <div className="hand-mode-row">
            {(
              [
                ['biggest_won', 'Biggest Cash Wins'],
                ['biggest_lost', 'Worst Cash Losses'],
                ['recent', 'Most Recent'],
              ] as [HandMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                className={handMode === mode ? 'active' : ''}
                aria-pressed={handMode === mode}
                onClick={() => setHandMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {handsLoading && <div className="hand-empty hand-loading">Loading Hands...</div>}
          {!handsLoading && handsError && (
            <div className="hand-empty" role="alert">
              Could Not Load Notable Hands.{' '}
              <button className="hand-retry" onClick={() => setHandsReload((n) => n + 1)}>
                Try Again
              </button>
            </div>
          )}
          {/* "No hands" only when the read actually succeeded. This list is
              all-time: ca_player_hands takes no window argument, so saying
              "in this range" claimed a filter that does not exist. */}
          {!handsLoading && !handsError && hands && hands.length === 0 && (
            <div className="hand-empty">
              {handMode === 'recent'
                ? 'No Hands Recorded Yet.'
                : 'No Cash Hands Recorded Yet. Tournament Chips Are Not Ranked Here.'}
            </div>
          )}
          {!handsLoading && hands && hands.length > 0 && (
            <div className="hand-list">
              {hands.map((h) => (
                <div className="hand-row" key={h.id}>
                  <div className="hand-row-main">
                    <span className="hand-row-meta">
                      {handDate(h.played_at)}
                      {' · '}
                      {enumToTitleCase(h.variant)}
                      {h.position ? ` · ${h.position}` : ''}
                      {h.is_tournament ? ' · MTT' : ` · ${h.big_blind} BB`}
                      {` · ${h.players} Players`}
                    </span>
                    {Array.isArray(h.board) && h.board.length > 0 && (
                      <span className="hand-row-board">
                        {h.board.map((c) => formatCard(String(c))).join('  ')}
                      </span>
                    )}
                  </div>
                  <div className="hand-row-result">
                    <span className={`hand-row-profit ${h.profit >= 0 ? 'positive' : 'negative'}`}>
                      {h.profit >= 0 ? '+' : ''}
                      {compactChips(h.profit)}
                    </span>
                    <span className="hand-row-pot">Pot {compactChips(h.pot_size)}</span>
                    {h.id ? (
                      <StatsEvidenceLink
                        className="stats-evidence-action"
                        to={buildStatsHandEvidencePath(h.id, clubId)}
                        aria-label={`Open Hand From ${handDate(h.played_at)}`}
                      >
                        Open Hand
                      </StatsEvidenceLink>
                    ) : (
                      <span className="stats-evidence-unavailable">Evidence Unavailable</span>
                    )}
                  </div>
                </div>
              ))}
              <button className="view-hands-btn" onClick={() => openHandEvidence()}>
                Open Full Hand History
              </button>
            </div>
          )}
        </div>
      </PanelBoundary>

      {/* Sessions */}
      <div>
        <div className="stats-section-header">
          <h3>Cash Sessions</h3>
        </div>
        <PanelBoundary name="Session History" resetKey={panelResetKey}>
          {sessionsAvailable ? (
            <SessionHistory
              userId={targetUserId}
              initialSessions={sessionRows}
              rangeLabel={rangeLabel}
            />
          ) : (
            <div className="stats-notice" role="status">
              Session History Is Unavailable For This Club Because Historical Session Boundaries Are
              Not Captured In The Club Facts Yet.
              {sessionsReason ? ` Coverage Code: ${sessionsReason}.` : ''}
            </div>
          )}
        </PanelBoundary>
        {overall.tourney_hands > 0 && (
          <div className="stats-notice">
            Cash Tables Only - Tournament Results Are In The Tournaments Tab, Because A Tournament
            Result Is A Prize, Not Chips Won At A Table.
          </div>
        )}
      </div>

      {/* Bankroll */}
      <div>
        <div className="stats-section-header">
          <h3>Cumulative Session P/L</h3>
        </div>
        <PanelBoundary name="Bankroll" resetKey={panelResetKey}>
          {sessionsAvailable ? (
            <Suspense fallback={<div className="hand-empty hand-loading">Loading Chart...</div>}>
              <BankrollTracker
                userId={targetUserId}
                initialSessions={sessionRows}
                rangeLabel={rangeLabel}
                still={printing}
              />
            </Suspense>
          ) : (
            <div className="stats-notice" role="status">
              Cumulative Session P/L Is Unavailable Until Club Session Coverage Exists.
            </div>
          )}
        </PanelBoundary>
      </div>
    </div>
  );
}
