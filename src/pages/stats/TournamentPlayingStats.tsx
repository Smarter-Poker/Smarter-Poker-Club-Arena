import { StatRow } from './StatRow';
import { ratioOrUnmeasured } from './format';
import type { FullStats, OverallStats } from './types';

export default function TournamentPlayingStats({
  overall,
  full,
  onOpenHands,
}: {
  overall: OverallStats;
  full: FullStats | null;
  onOpenHands?: () => void;
}) {
  return (
    <>
      <section aria-label="Tournament Playing Statistics">
        <div className="stats-section-header">
          <h3>Tournament Playing Statistics</h3>
        </div>
        {onOpenHands && (
          <div className="stats-club-actions">
            <button type="button" onClick={onOpenHands}>
              Review Tournament Hands
            </button>
          </div>
        )}
        <div className="stats-grid">
          <StatRow label="Recorded Hands" value={overall.tourney_hands.toLocaleString()} />
          <StatRow
            label="VPIP"
            value={ratioOrUnmeasured(
              overall.vpip * 100,
              overall.tourney_hands,
              (v) => `${v.toFixed(1)}%`
            )}
          />
          <StatRow
            label="PFR"
            value={ratioOrUnmeasured(
              overall.pfr * 100,
              overall.tourney_hands,
              (v) => `${v.toFixed(1)}%`
            )}
          />
          <StatRow label="Hands Won" value={overall.hands_won.toLocaleString()} />
          <StatRow label="Showdowns" value={overall.showdowns_total.toLocaleString()} />
          <StatRow
            label="3-Bet"
            value={ratioOrUnmeasured(
              overall.three_bet_percent * 100,
              full?.contract.quality.metric_availability.three_bet_opportunities ?? 0,
              (v) => `${v.toFixed(1)}%`
            )}
          />
          <StatRow
            label="Flop C-Bet"
            value={ratioOrUnmeasured(
              overall.cbet_flop * 100,
              full?.contract.quality.metric_availability.cbet_flop_opportunities ?? 0,
              (v) => `${v.toFixed(1)}%`
            )}
          />
          <StatRow
            label="WTSD"
            value={ratioOrUnmeasured(
              overall.wtsd * 100,
              full?.contract.quality.metric_availability.wtsd_opportunities ?? 0,
              (v) => `${v.toFixed(1)}%`
            )}
          />
          <StatRow
            label="Showdown Win %"
            value={ratioOrUnmeasured(
              (overall.showdowns_won / overall.showdowns_total) * 100,
              overall.showdowns_total,
              (v) => `${v.toFixed(1)}%`
            )}
          />
          <StatRow
            label="Aggression Factor"
            value={ratioOrUnmeasured(
              overall.aggression_factor,
              full?.contract.quality.metric_availability.aggression_factor_denominator ?? 0,
              (v) => v.toFixed(2)
            )}
          />
        </div>
      </section>
      {(full?.positions.length ?? 0) > 0 && (
        <section aria-label="Tournament Position Statistics">
          <div className="stats-section-header">
            <h3>Tournament Positions</h3>
          </div>
          <div className="stats-club-table-wrap">
            <table className="stats-club-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Hands</th>
                  <th>VPIP</th>
                  <th>PFR</th>
                </tr>
              </thead>
              <tbody>
                {full?.positions.map((row) => (
                  <tr key={row.position}>
                    <th scope="row">{row.position}</th>
                    <td>{row.hands_played.toLocaleString()}</td>
                    <td>
                      {ratioOrUnmeasured(
                        (row.vpip_count / row.hands_played) * 100,
                        row.hands_played,
                        (v) => `${v.toFixed(1)}%`
                      )}
                    </td>
                    <td>
                      {ratioOrUnmeasured(
                        (row.pfr_count / row.hands_played) * 100,
                        row.hands_played,
                        (v) => `${v.toFixed(1)}%`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {full?.contract.coverage.analysis_hands_capped && (
            <p className="stats-notice">
              Position Analysis Uses The Most Recent{' '}
              {full.contract.coverage.analysis_hand_cap.toLocaleString()} Tournament Hands In This
              Range.
            </p>
          )}
        </section>
      )}
    </>
  );
}
