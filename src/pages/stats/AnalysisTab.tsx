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
import { Suspense, lazy } from 'react';
import PanelBoundary from '../../components/stats/PanelBoundary';
import LeakPanel from '../../components/stats/LeakPanel';
import type { AdvancedStatsInput } from '../../components/stats/AdvancedStatsSummary';
import { formatCard, handDate } from './format';
import {
  RANGES,
  type FullStats,
  type HandEvidenceFilter,
  type HandMode,
  type HandRow,
  type OverallStats,
  type SessionRow,
} from './types';

const StatsCharts = lazy(() => import('../../components/stats/StatsCharts'));
const BankrollTracker = lazy(() => import('../../components/stats/BankrollTracker'));
const SessionHistory = lazy(() => import('../../components/stats/SessionHistory'));
const AdvancedStatsSummary = lazy(() => import('../../components/stats/AdvancedStatsSummary'));

export interface DailySeriesPoint {
  date: string;
  profit: number;
  hands: number;
  cumulative: number;
}

export interface AnalysisTabProps {
  overall: OverallStats;
  full: FullStats | null;
  panelResetKey: string;
  targetUserId: string | undefined;
  rangeKey: string;
  rangeLabel: string;
  printing: boolean;
  advancedInitialData: AdvancedStatsInput;
  dailySeries: DailySeriesPoint[];
  positionPie: { name: string; value: number }[];
  profitChartSummary: string;
  dailyChartSummary: string;
  positionChartSummary: string;
  sessionRows: SessionRow[];
  exportSessionsCSV: () => void;
  exportOverviewCSV: () => void;
  handMode: HandMode;
  setHandMode: (mode: HandMode) => void;
  hands: HandRow[] | null;
  handsLoading: boolean;
  handsError: boolean;
  setHandsReload: (fn: (n: number) => number) => void;
  openHandEvidence: (filter?: HandEvidenceFilter) => void;
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
  dailySeries,
  positionPie,
  profitChartSummary,
  dailyChartSummary,
  positionChartSummary,
  sessionRows,
  exportSessionsCSV,
  exportOverviewCSV,
  handMode,
  setHandMode,
  hands,
  handsLoading,
  handsError,
  setHandsReload,
  openHandEvidence,
}: AnalysisTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
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

      {/* Notable hands — every stat above used to be a dead end. */}
      <PanelBoundary name="Notable Hands" resetKey={panelResetKey}>
        <div>
          <div className="stats-section-header">
            <h3>Notable Hands</h3>
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
                      {String(h.variant || '').toUpperCase()}
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
                      {h.profit.toLocaleString()}
                    </span>
                    <span className="hand-row-pot">Pot {h.pot_size.toLocaleString()}</span>
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
          <SessionHistory
            userId={targetUserId}
            initialSessions={sessionRows}
            rangeLabel={rangeLabel}
          />
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
          <h3>Cash Bankroll</h3>
        </div>
        <PanelBoundary name="Bankroll" resetKey={panelResetKey}>
          <Suspense fallback={<div className="hand-empty hand-loading">Loading Chart...</div>}>
            <BankrollTracker
              userId={targetUserId}
              initialSessions={sessionRows}
              rangeLabel={rangeLabel}
              still={printing}
            />
          </Suspense>
        </PanelBoundary>
      </div>
    </div>
  );
}
