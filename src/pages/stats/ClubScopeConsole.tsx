import { CHIP_STATS } from '../../services/statsScope';
import { NOT_YET_MEASURED } from './format';
import {
  CLUB_SORTS,
  type ClubComparisonRow,
  type ClubComparisonSort,
  type StatsClubOption,
} from './playerStatsPageModel';

interface Props {
  statsScope: string;
  clubLabel: string;
  selectedClub?: StatsClubOption | null;
  selectedClubId: string | null;
  changeClub: (clubId: string | null) => void;
  clubs: StatsClubOption[];
  clubsLoading: boolean;
  clubsError: boolean;
  comparisonOpen: boolean;
  setComparisonOpen: (open: boolean) => void;
  loadClubComparison: () => Promise<void>;
  comparisonSort: ClubComparisonSort;
  changeComparisonSort: (sort: ClubComparisonSort) => void;
  comparisonLoading: boolean;
  comparisonError: boolean;
  sortedComparisonRows: ClubComparisonRow[];
}

export default function ClubScopeConsole(props: Props) {
  const {
    statsScope,
    clubLabel,
    selectedClub,
    selectedClubId,
    changeClub,
    clubs,
    clubsLoading,
    clubsError,
    comparisonOpen,
    setComparisonOpen,
    loadClubComparison,
    comparisonSort,
    changeComparisonSort,
    comparisonLoading,
    comparisonError,
    sortedComparisonRows,
  } = props;
  return (
    <>
      {statsScope === CHIP_STATS && (
        <section className="stats-club-command" aria-labelledby="stats-club-scope-title">
          <img
            src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-console-v1.webp`}
            alt=""
            aria-hidden="true"
            loading="eager"
          />
          <div className="stats-club-command-copy">
            <span className="stats-section-kicker">Authorized Club Ledger</span>
            <h2 id="stats-club-scope-title">{clubLabel}</h2>
            <p>
              {selectedClub
                ? 'Every Readout Below Is Restricted To This Club.'
                : 'All Clubs Preserves Your Complete Existing Stats Contract.'}
            </p>
            <div className="stats-club-selector" role="group" aria-label="Statistics Club">
              <button
                type="button"
                aria-pressed={!selectedClubId}
                className={!selectedClubId ? 'active' : ''}
                onClick={() => changeClub(null)}
              >
                All Clubs
              </button>
              {clubs.map((club) => (
                <button
                  type="button"
                  key={club.id}
                  aria-pressed={selectedClubId === club.id}
                  className={selectedClubId === club.id ? 'active' : ''}
                  onClick={() => changeClub(club.id)}
                >
                  {club.name}
                </button>
              ))}
            </div>
            <div className="stats-club-actions">
              {clubsLoading && <span role="status">Loading Club Access...</span>}
              {clubsError && <span role="alert">Club Access Could Not Be Loaded.</span>}
              {clubs.length > 1 && (
                <button
                  type="button"
                  aria-expanded={comparisonOpen}
                  aria-controls="stats-club-comparison"
                  onClick={() => {
                    const next = !comparisonOpen;
                    setComparisonOpen(next);
                    if (next) void loadClubComparison();
                  }}
                >
                  {comparisonOpen ? 'Close Club Comparison' : 'Compare Clubs'}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {comparisonOpen && (
        <section
          className="stats-club-comparison"
          id="stats-club-comparison"
          aria-labelledby="stats-club-comparison-title"
        >
          <div className="stats-club-comparison-head">
            <div>
              <span className="stats-section-kicker">One Read // Every Authorized Club</span>
              <h2 id="stats-club-comparison-title">Club Comparison</h2>
            </div>
            <div className="stats-club-sort" role="group" aria-label="Sort Club Comparison">
              {CLUB_SORTS.map((sort) => (
                <button
                  type="button"
                  key={sort.key}
                  aria-pressed={comparisonSort === sort.key}
                  className={comparisonSort === sort.key ? 'active' : ''}
                  onClick={() => changeComparisonSort(sort.key)}
                >
                  {sort.label}
                </button>
              ))}
            </div>
          </div>
          {comparisonLoading && (
            <div className="stats-section-loading">Loading Club Ledgers...</div>
          )}
          {comparisonError && (
            <div className="stats-notice stats-notice-warn" role="alert">
              Club Comparison Could Not Be Loaded.{' '}
              <button
                type="button"
                className="hand-retry"
                onClick={() => void loadClubComparison()}
              >
                Try Again
              </button>
            </div>
          )}
          {!comparisonLoading && !comparisonError && sortedComparisonRows.length > 0 && (
            <div className="stats-club-table-wrap">
              <table className="stats-club-table">
                <thead>
                  <tr>
                    <th scope="col">Club</th>
                    <th scope="col">Hands</th>
                    <th scope="col">Profit</th>
                    <th scope="col">BB/100</th>
                    <th scope="col">VPIP</th>
                    <th scope="col">PFR</th>
                    <th scope="col">Hours</th>
                    <th scope="col">Rake</th>
                    <th scope="col">Tournament Results</th>
                    <th scope="col">Last Play</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedComparisonRows.map((row) => (
                    <tr key={row.club.id}>
                      <th scope="row">
                        <button type="button" onClick={() => changeClub(row.club.id)}>
                          {row.club.name}
                        </button>
                      </th>
                      <td>{row.hands.toLocaleString()}</td>
                      <td className={row.profit >= 0 ? 'positive' : 'negative'}>
                        {row.profit >= 0 ? '+' : ''}
                        {row.profit.toLocaleString()}
                      </td>
                      <td>{row.hands ? row.bb100.toFixed(2) : NOT_YET_MEASURED}</td>
                      <td>{row.hands ? `${(row.vpip * 100).toFixed(1)}%` : NOT_YET_MEASURED}</td>
                      <td>{row.hands ? `${(row.pfr * 100).toFixed(1)}%` : NOT_YET_MEASURED}</td>
                      <td>{row.hours === null ? 'Unavailable' : row.hours.toFixed(1)}</td>
                      <td>{row.rake.toLocaleString()}</td>
                      <td>
                        {row.tournamentEntries.toLocaleString()} Entries //{' '}
                        {row.tournamentCashes.toLocaleString()} Cashes //{' '}
                        {row.tournamentWins.toLocaleString()} Wins //{' '}
                        {row.tournamentWinnings.toLocaleString()} Won
                      </td>
                      <td>
                        {row.lastPlayedAt
                          ? new Date(row.lastPlayedAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })
                          : NOT_YET_MEASURED}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="stats-club-comparison-footnote">
            Club Hours Are Unavailable Because The Per-Club Facts Contract Does Not Retain Session
            Duration. Club History Begins At The First Preserved Club Fact.
          </p>
        </section>
      )}
    </>
  );
}
