/**
 * The Tournaments tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('tournaments')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { StatRow } from './StatRow';
import { ratioOrUnmeasured } from './format';
import { num, type FullStats, type OverallStats, type TournamentSummary } from './types';
import StatsEvidenceLink from '../../components/stats/StatsEvidenceLink';
import { buildStatsTournamentEvidencePath } from '../../lib/statsEvidenceNavigation';
import { compactChips } from '../../utils/format';
import { enumToTitleCase, titleCase } from '../../utils/titleCase';
import type { ReactNode } from 'react';

export interface TournamentsTabProps {
  tourn: TournamentSummary;
  overall: OverallStats;
  full: FullStats | null;
  financialPanel?: ReactNode;
}

export default function TournamentsTab({
  tourn,
  overall,
  full,
  financialPanel,
}: TournamentsTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {financialPanel}
      <div>
        <div className="stats-section-header">
          <h3>Tournament Results</h3>
        </div>
        <div className="stats-notice" role="status">
          Accounting Coverage: Reconstructed From Tournament Records. Registration, Rebuy, Add-On,
          Refund, Ticket, Prize, And Bounty Ledgers Are Not Yet Reconciled Into This Readout.
        </div>
        <div className="stats-grid">
          <StatRow label="Entries" value={tourn.entries.toLocaleString()} color="#00d4ff" />
          <StatRow label="Cashes" value={tourn.cashes.toLocaleString()} color="#22c55e" />
          {/* STATS CONTRACT TRUTH (2026-09-20). ITM is cashes over ENTRIES and
              ROI is net over BUY-INS; the SQL writes 0 for both when the
              denominator is empty, and "0.0%" read as a run of bad results
              rather than an empty record. */}
          <StatRow
            label="ITM %"
            value={ratioOrUnmeasured(
              tourn.itm_percent * 100,
              tourn.entries,
              (v) => `${v.toFixed(1)}%`
            )}
            color="#10b981"
          />
          <StatRow label="Wins" value={tourn.wins.toLocaleString()} color="#f59e0b" />
          <StatRow
            label="Best Finish"
            value={tourn.best_finish ? `#${tourn.best_finish}` : '-'}
            color="#8b5cf6"
          />
          <StatRow
            label="Estimated Entry Costs"
            value={compactChips(tourn.total_buyins)}
            color="#06b6d4"
          />
          <StatRow
            label="Recorded Prize And Bounty Amounts"
            value={compactChips(tourn.total_winnings)}
            color="#10b981"
          />
          <StatRow
            label="Reconstructed Net"
            value={`${tourn.net_profit >= 0 ? '+' : ''}${compactChips(tourn.net_profit)}`}
            color={tourn.net_profit >= 0 ? '#22c55e' : '#ef4444'}
            highlight
          />
          <StatRow
            label="ROI"
            value={ratioOrUnmeasured(
              tourn.roi * 100,
              tourn.total_buyins,
              (v) => `${v.toFixed(1)}%`
            )}
            // An unmeasured return has no sign, so it gets no win or loss colour.
            color={tourn.total_buyins > 0 ? (tourn.roi >= 0 ? '#22c55e' : '#ef4444') : '#94a3b8'}
            evidence="Reconstructed From Tournament Records"
          />
          <StatRow
            label="Tournament Hands"
            value={overall.tourney_hands.toLocaleString()}
            color="#8b5cf6"
          />
        </div>
      </div>

      {(full?.recent_tournaments?.length ?? 0) > 0 ? (
        <div>
          <div className="stats-section-header">
            <h3>Recent Tournaments</h3>
          </div>
          <div className="tournament-list">
            {(full?.recent_tournaments || []).map((t, i) => (
              <div className="tournament-item" key={i}>
                <div className="tournament-item-main">
                  <span className="tournament-item-name">{titleCase(t.name)}</span>
                  <span className="tournament-item-date">
                    {t.ended_at
                      ? `Finalized ${new Date(t.ended_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}`
                      : t.start_time
                        ? `Started ${new Date(t.start_time).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })} · Result May Be Provisional`
                        : 'Finalization Date Unavailable'}
                    {t.variant ? ` · ${enumToTitleCase(t.variant)}` : ''}
                    {t.is_mystery_bounty && enumToTitleCase(t.variant) !== 'Mystery Bounty'
                      ? ' · Mystery Bounty'
                      : ''}
                  </span>
                </div>
                <div className="tournament-item-result">
                  <span className="tournament-item-rank">
                    {t.finish_rank ? `#${t.finish_rank}` : enumToTitleCase(t.status) || '-'}
                  </span>
                  {/* Dan section 45: Finish / Prize / Bounties / Bounty
                        Earnings / Total Won. The net below is
                        total_won - buyin, which is the same number this
                        line always showed - the old `prize` field WAS
                        prize + bounty. What changed is that the two
                        halves are now visible instead of merged. */}
                  <span
                    style={{
                      fontSize: 10,
                      color: '#94a3b8',
                      display: 'block',
                      marginTop: 2,
                    }}
                  >
                    Prize {compactChips(num(t.prize))}
                    {num(t.bounty_winnings) > 0 && (
                      <>
                        {' '}
                        / {num(t.bounties).toLocaleString()} KO
                        {num(t.bounties) === 1 ? '' : 's'} {compactChips(num(t.bounty_winnings))}
                      </>
                    )}
                    {' / Total '}
                    {compactChips(num(t.total_won))}
                  </span>
                  <span
                    className={`tournament-item-net ${num(t.total_won) - num(t.buyin) >= 0 ? 'positive' : 'negative'}`}
                  >
                    {num(t.total_won) - num(t.buyin) >= 0 ? '+' : ''}
                    {compactChips(num(t.total_won) - num(t.buyin))}
                  </span>
                  {t.tournament_id ? (
                    <StatsEvidenceLink
                      className="stats-evidence-action"
                      to={buildStatsTournamentEvidencePath(t.tournament_id)}
                      aria-label={`Open ${titleCase(t.name)} Tournament Evidence`}
                    >
                      Open Tournament
                    </StatsEvidenceLink>
                  ) : (
                    <span className="stats-evidence-unavailable">Evidence Unavailable</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="stats-empty-state">
          <span className="empty-title">No Tournament Results Available</span>
          <span className="empty-description">
            No Tournament Records Were Returned For This Analysis Window.
          </span>
        </div>
      )}
    </div>
  );
}
