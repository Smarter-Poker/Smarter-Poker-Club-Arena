/**
 * The Overview tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('overview')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { lazy } from 'react';
import PanelBoundary from '../../components/stats/PanelBoundary';
import { playerDisplayName } from '../../utils/playerDisplayName';
import type { playerStyleFromStats } from '../../components/stats/playerStyleFromStats';
import { StatRow } from './StatRow';
import { SCOPE_ALL_GAMES, SCOPE_CASH, ratioOrUnmeasured } from './format';
import { RANGES, type FullStats, type OverallStats, type HandEvidenceFilter } from './types';

const NemesisPanel = lazy(() => import('../../components/stats/NemesisPanel'));
const BenchmarkPanel = lazy(() => import('../../components/stats/BenchmarkPanel'));
const StatsShareCard = lazy(() => import('../../components/stats/StatsShareCard'));

export interface OverviewTabProps {
  overall: OverallStats;
  full: FullStats | null;
  rangeKey: string;
  rangeLabel: string;
  /** Display-ready, including the `%`, or Not Yet Measured (the page formats it). */
  showdownWinRate: string;
  handsWonPct: number;
  isOwnProfile: boolean;
  panelResetKey: string;
  targetUserId: string | undefined;
  windowDays: number | null;
  user: Parameters<typeof playerDisplayName>[0];
  shareStyle: ReturnType<typeof playerStyleFromStats>;
  printing: boolean;
  printDossier: () => void;
  openHandEvidence: (filter?: HandEvidenceFilter) => void;
}

export default function OverviewTab({
  overall,
  full,
  rangeKey,
  rangeLabel,
  showdownWinRate,
  handsWonPct,
  isOwnProfile,
  panelResetKey,
  targetUserId,
  windowDays,
  user,
  shareStyle,
  printing,
  printDossier,
  openHandEvidence,
}: OverviewTabProps) {
  return (
    <>
      <div className="stats-section-lead">
        <div>
          <span className="stats-section-kicker">Live Readout</span>
          <h2>Core Tendencies</h2>
        </div>
        <span>{RANGES.find((r) => r.key === rangeKey)?.label ?? 'All'} Window</span>
      </div>
      {/* STATS CONTRACT TRUTH (2026-09-20). One grid, two populations: the
          scope tag says which hands each row counts (see StatRow `scope`),
          and a rate over an empty sample says Not Yet Measured instead of a
          confident zero (see ratioOrUnmeasured). Rows whose label already
          names the population ("Cash Hands") are not tagged twice. */}
      <div className="stats-grid stats-overview-grid">
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
        {/* Aggressive actions over CALL actions. The payload does not carry
            call_actions, and with none the SQL returns the raw aggressive
            count, which is not a ratio; the empty sample the client can prove
            is "no hands scored", so that is the one that stops printing a
            number here. */}
        <StatRow
          label="Aggression Factor"
          value={ratioOrUnmeasured(overall.aggression_factor, overall.total_hands, (v) =>
            v.toFixed(2)
          )}
          color="#f59e0b"
          scope={SCOPE_ALL_GAMES}
        />
        <StatRow
          label="Hours Played"
          value={`${overall.hours_played.toFixed(1)}h`}
          color="#06b6d4"
          scope={SCOPE_ALL_GAMES}
        />
        <StatRow
          label="Showdown Win %"
          value={showdownWinRate}
          color="#22c55e"
          scope={SCOPE_ALL_GAMES}
        />
        <StatRow
          label="BB/100"
          value={ratioOrUnmeasured(overall.bb_per_100, overall.cash_hands, (v) => v.toFixed(2))}
          color="#4169E1"
          highlight
          scope={SCOPE_CASH}
        />
        <StatRow label="Cash Hands" value={overall.cash_hands.toLocaleString()} color="#00d4ff" />
        <StatRow
          label="Tournament Hands"
          value={overall.tourney_hands.toLocaleString()}
          color="#8b5cf6"
        />
      </div>

      <div className="stats-ledger-grid">
        {/* Per-variant breakdown */}
        {(full?.variants?.length ?? 0) > 0 && (
          <div className="variant-table" role="region" aria-label="Performance By Game">
            <h3 className="variant-title">Game Mix</h3>
            <div className="variant-row variant-head">
              <span>Game</span>
              <span>Hands</span>
              <span>Won</span>
              <span>Profit</span>
              <span>BB/100</span>
            </div>
            {(full?.variants || []).map((v) => (
              <button
                type="button"
                className="variant-row stats-evidence-row"
                key={v.variant}
                onClick={() => openHandEvidence({ variant: v.variant })}
                aria-label={`Review ${String(v.variant).toUpperCase()} Hands`}
              >
                <span className="variant-name">{String(v.variant).toUpperCase()}</span>
                <span>{v.hands.toLocaleString()}</span>
                <span>{v.hands_won.toLocaleString()}</span>
                <span className={v.profit >= 0 ? 'positive' : 'negative'}>
                  {v.profit >= 0 ? '+' : ''}
                  {v.profit.toLocaleString()}
                </span>
                <span className={v.bb100 >= 0 ? 'positive' : 'negative'}>{v.bb100.toFixed(1)}</span>
              </button>
            ))}
          </div>
        )}

        {/* Per-stake breakdown: which game size is actually carrying (or
            bleeding) the results, instead of one blended number. */}
        {(full?.stakes?.length ?? 0) > 1 && (
          <div className="variant-table" role="region" aria-label="Performance By Stake">
            <h3 className="variant-title">Stake Ledger</h3>
            <div className="variant-row variant-head">
              <span>Stake</span>
              <span>Hands</span>
              <span>Won</span>
              <span>Profit</span>
              <span>BB/100</span>
            </div>
            {(full?.stakes || []).map((st) => (
              <button
                type="button"
                className="variant-row stats-evidence-row"
                key={`stake-${st.big_blind}`}
                onClick={() => openHandEvidence({ bigBlind: st.big_blind })}
                aria-label={`Review Hands At ${st.big_blind} Big Blind`}
              >
                <span className="variant-name">{st.big_blind} BB</span>
                <span>{st.hands.toLocaleString()}</span>
                <span>{st.hands_won.toLocaleString()}</span>
                <span className={st.profit >= 0 ? 'positive' : 'negative'}>
                  {st.profit >= 0 ? '+' : ''}
                  {st.profit.toLocaleString()}
                </span>
                <span className={st.bb100 >= 0 ? 'positive' : 'negative'}>
                  {st.bb100.toFixed(1)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Coaching is intentionally absent until the persisted Personal
          Assistant workflow is real. Phase 1 removed the demo solver path
          rather than presenting fabricated analysis as player evidence. */}

      {/* Rivals: the most socially engaging stat on the page, so it sits
          where a player looks first. Owner only - head-to-head chip flow
          is private, and ca_player_nemesis refuses a cross-user read. */}
      {isOwnProfile && (
        <PanelBoundary name="Rivals" resetKey={panelResetKey}>
          <NemesisPanel userId={targetUserId} days={windowDays} />
        </PanelBoundary>
      )}

      {/* Where the player stands against the field. Rates arrive from the
          RPC as FRACTIONS and the distribution is stored in PERCENT, so
          they are converted exactly once, here, at the boundary. */}
      <PanelBoundary name="Benchmarks" resetKey={panelResetKey}>
        <BenchmarkPanel
          // The metric being benchmarked hardest here is bb/100, which the
          // RPC computes over CASH hands only. Passing total_hands let a
          // player with 400 cash + 900 tournament hands clear the 500-hand
          // confidence gate on a 400-hand sample.
          handsPlayed={overall.cash_hands || overall.total_hands}
          days={windowDays}
          values={{
            bb100: overall.bb_per_100,
            // The same memo the gauge uses. Matches the field definition:
            // hands won over hands dealt.
            win_rate: overall.total_hands > 0 ? handsWonPct : undefined,
            vpip: overall.vpip * 100,
            pfr: overall.pfr * 100,
            three_bet: overall.three_bet_percent * 100,
          }}
        />
      </PanelBoundary>

      {/* The export people actually use: a card for the club chat after
          a good session, built on canvas so it costs no bundle weight. */}
      {isOwnProfile && (
        <PanelBoundary name="Share Card" resetKey={panelResetKey}>
          <StatsShareCard
            displayName={playerDisplayName(user)}
            styleLabel={shareStyle?.label ?? null}
            styleColor={shareStyle?.color ?? null}
            stats={{
              hands: overall.total_hands,
              bb100: overall.bb_per_100,
              profit: overall.total_profit,
              vpip: overall.vpip * 100,
              pfr: overall.pfr * 100,
              hoursPlayed: overall.hours_played,
            }}
            rangeLabel={rangeLabel === 'All' ? 'All Time' : `Last ${rangeLabel}`}
          />
        </PanelBoundary>
      )}

      <div className="stats-action-row">
        <button className="view-hands-btn" onClick={() => openHandEvidence()}>
          View Hand Histories
        </button>
        <button className="view-hands-btn" onClick={printDossier} disabled={printing}>
          {printing ? 'Preparing Dossier...' : 'Print Or Save Dossier'}
        </button>
      </div>
    </>
  );
}
