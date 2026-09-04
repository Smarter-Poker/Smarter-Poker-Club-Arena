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
import { num, type FullStats, type OverallStats, type TournamentSummary } from './types';

export interface TournamentsTabProps {
  tourn: TournamentSummary;
  overall: OverallStats;
  full: FullStats | null;
}

export default function TournamentsTab({ tourn, overall, full }: TournamentsTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <div className="stats-section-header">
          <h3>Tournament Results</h3>
        </div>
        <div className="stats-grid">
          <StatRow label="Entries" value={tourn.entries.toLocaleString()} color="#00d4ff" />
          <StatRow label="Cashes" value={tourn.cashes.toLocaleString()} color="#22c55e" />
          <StatRow
            label="ITM %"
            value={`${(tourn.itm_percent * 100).toFixed(1)}%`}
            color="#10b981"
          />
          <StatRow label="Wins" value={tourn.wins.toLocaleString()} color="#f59e0b" />
          <StatRow
            label="Best Finish"
            value={tourn.best_finish ? `#${tourn.best_finish}` : '-'}
            color="#8b5cf6"
          />
          <StatRow
            label="Total Buy-Ins"
            value={tourn.total_buyins.toLocaleString()}
            color="#06b6d4"
          />
          <StatRow
            label="Total Winnings"
            value={tourn.total_winnings.toLocaleString()}
            color="#10b981"
          />
          <StatRow
            label="Net Profit"
            value={`${tourn.net_profit >= 0 ? '+' : ''}${tourn.net_profit.toLocaleString()}`}
            color={tourn.net_profit >= 0 ? '#22c55e' : '#ef4444'}
            highlight
          />
          <StatRow
            label="ROI"
            value={`${(tourn.roi * 100).toFixed(1)}%`}
            color={tourn.roi >= 0 ? '#22c55e' : '#ef4444'}
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
                  <span className="tournament-item-name">{t.name}</span>
                  <span className="tournament-item-date">
                    {t.start_time
                      ? new Date(t.start_time).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '-'}
                    {t.variant ? ` · ${t.variant.toUpperCase()}` : ''}
                    {t.is_mystery_bounty ? ' · MYSTERY BOUNTY' : ''}
                  </span>
                </div>
                <div className="tournament-item-result">
                  <span className="tournament-item-rank">
                    {t.finish_rank ? `#${t.finish_rank}` : t.status || '-'}
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
                    Prize {num(t.prize).toLocaleString()}
                    {num(t.bounty_winnings) > 0 && (
                      <>
                        {' '}
                        / {num(t.bounties).toLocaleString()} KO
                        {num(t.bounties) === 1 ? '' : 's'} {num(t.bounty_winnings).toLocaleString()}
                      </>
                    )}
                    {' / Total '}
                    {num(t.total_won).toLocaleString()}
                  </span>
                  <span
                    className={`tournament-item-net ${num(t.total_won) - num(t.buyin) >= 0 ? 'positive' : 'negative'}`}
                  >
                    {num(t.total_won) - num(t.buyin) >= 0 ? '+' : ''}
                    {(num(t.total_won) - num(t.buyin)).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="stats-empty-state">
          <span className="empty-title">No Tournaments Yet</span>
          <span className="empty-description">
            Register For A Tournament In The Lobby And Your Results Will Show Up Here.
          </span>
        </div>
      )}
    </div>
  );
}
