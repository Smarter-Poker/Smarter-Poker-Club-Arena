import { RANGES, type FullStats, type LifetimeStats, type OverallStats } from './types';
import { ratioOrUnmeasured } from './format';
import { HandsWonGauge, type StatCategory } from './playerStatsPageModel';

interface Props {
  statsEyebrow: string;
  refreshing: boolean;
  statsContract: FullStats['contract'];
  rangeKey: string;
  changeRange: (key: string) => void;
  lastUpdatedAt: number | null;
  statsDataSource: string;
  overall: OverallStats;
  lifetime: LifetimeStats;
  handsWonPct: number | null;
  privacyPresentationMode: boolean;
  category: StatCategory;
  hasData: boolean;
  selectedClubId: string | null;
  servingCache: boolean;
}

export default function StatsHeadlineDeck(props: Props) {
  const {
    statsEyebrow,
    refreshing,
    statsContract,
    rangeKey,
    changeRange,
    lastUpdatedAt,
    statsDataSource,
    overall,
    lifetime,
    handsWonPct,
    privacyPresentationMode,
    category,
    hasData,
    selectedClubId,
    servingCache,
  } = props;
  return (
    <>
      {/* ── COMMAND DECK ─────────────────────────────────────────────────────
      The artwork is deliberately data-free. All player figures remain live,
      selectable HTML so a new RPC response never requires a new image. */}
      <section className="stats-command-deck" aria-labelledby="stats-page-title">
        <img
          className="stats-hero-art"
          src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-dossier-v2.webp`}
          alt=""
          aria-hidden="true"
          fetchPriority="high"
          decoding="async"
        />

        <div className="stats-command-copy">
          <span className="stats-eyebrow">{statsEyebrow}</span>
          <h1 id="stats-page-title">Player Intelligence</h1>
          <p>
            Your Recorded Analysis Sample, Distilled Into Patterns You Can Use At The Next Table.
          </p>

          {/* Analysis range. Everything below the hero is computed over this window. */}
          <div className="stats-range-control">
            <span className="stats-range-label">
              Analysis Window
              <span
                className={`stats-range-status ${refreshing ? 'is-refreshing' : ''}`}
                role="status"
              >
                {refreshing
                  ? 'Updating'
                  : !statsContract.valid
                    ? 'Unavailable'
                    : statsContract.quality.live_tail_included
                      ? 'Live'
                      : 'Snapshot'}
              </span>
            </span>
            <div className="stats-range-row" role="group" aria-label="Analysis Range">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  className={rangeKey === r.key ? 'active' : ''}
                  aria-pressed={rangeKey === r.key}
                  onClick={() => changeRange(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {lastUpdatedAt && (
              <time className="stats-last-updated" dateTime={new Date(lastUpdatedAt).toISOString()}>
                Updated{' '}
                {new Date(lastUpdatedAt).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })}{' '}
                · {statsDataSource}
              </time>
            )}
          </div>
        </div>

        <div className="stats-hero" role="group" aria-label="Headline Performance">
          <HandsWonGauge handsWonPct={overall.total_hands > 0 ? handsWonPct : null} />
          <div className="hero-stats">
            <div className="hero-stat">
              {/* max() prints the ALL-TIME count when it is larger, on a range-scoped
              page: say so (2026-09-20). */}
              <span className="hero-stat-label">
                {lifetime.hands > overall.total_hands ? 'Lifetime Hands' : 'Total Hands'}
              </span>
              <span className="hero-stat-value cyan">
                {Math.max(lifetime.hands, overall.total_hands).toLocaleString()}
              </span>
              {lifetime.hands > overall.total_hands && (
                <span className="hero-stat-sub">
                  {overall.total_hands.toLocaleString()} Analysed
                </span>
              )}
            </div>
            <div className="hero-stat">
              <span className="hero-stat-label">
                {rangeKey === 'all' && !overall.hands_capped
                  ? 'Cash Profit'
                  : 'Analysis Cash Result'}
              </span>
              <span
                className={`hero-stat-value ${overall.total_profit >= 0 ? 'positive' : 'negative'}`}
              >
                {overall.total_profit >= 0 ? '+' : ''}
                {overall.total_profit.toLocaleString()}
              </span>
            </div>
            <div className="hero-stat">
              <span className="hero-stat-label">BB/100</span>
              <span
                className={
                  'hero-stat-value' +
                  (!overall.cash_hands ? '' : overall.bb_per_100 >= 0 ? ' positive' : ' negative')
                }
              >
                {ratioOrUnmeasured(overall.bb_per_100, overall.cash_hands, (v) => v.toFixed(2))}
              </span>
            </div>
          </div>
        </div>
      </section>

      {privacyPresentationMode && category !== 'workspace' && (
        <div className="stats-notice stats-notice-warn" role="status">
          Presentation Mode Is On. Private Stats Values And Artifacts Are Hidden.
        </div>
      )}

      {/* Analysis-window and staleness notices: never present a truncated or
      stale figure as though it were a current lifetime total. */}
      <div className="stats-notice-deck" aria-live="polite">
        {hasData && overall.hands_capped && (
          <div className="stats-notice">
            Based On Your Most Recent {overall.hand_cap.toLocaleString()} Hands
            {rangeKey !== 'all' ? ' In This Range' : ''}.
          </div>
        )}
        {hasData && !overall.hands_capped && rangeKey !== 'all' && (
          <div className="stats-notice">
            {overall.total_hands.toLocaleString()} Hands In The Last{' '}
            {RANGES.find((r) => r.key === rangeKey)?.label}.
          </div>
        )}
        {/* Small samples: bb/100 swings wildly over a few hundred hands, and a
      confident-looking number invites the wrong conclusion. */}
        {/* indexed_complete is parsed by normalizeFull and was read nowhere. A
      player whose backfill is incomplete saw a confident lifetime figure
      that would change tomorrow, on a page whose whole design rule is
      "never present a truncated figure as a lifetime total". */}
        {hasData && !lifetime.indexed_complete && (
          <div className="stats-notice">
            Older Hands Are Still Being Indexed. These Totals Will Grow.
          </div>
        )}
        {hasData && overall.cash_hands > 0 && overall.cash_hands < 1000 && (
          <div className="stats-notice">
            {overall.cash_hands.toLocaleString()} Cash Hands Is A Small Sample - Win Rate Is Not Yet
            Meaningful.
          </div>
        )}
        {/* The money source is measured per payload now (see the v2 RPC): the
        engine's own settlement row is used wherever one exists, and the
        action reconstruction only for the hands that predate it. Say which,
        with the count, rather than a blanket warning on every load. */}
        {hasData &&
          overall.cash_hands > 0 &&
          !statsContract.quality.cash_money_exact &&
          statsContract.quality.cash_money_source === 'mixed' && (
            <div className="stats-notice">
              {statsContract.quality.exact_cash_hands.toLocaleString()} Of{' '}
              {overall.cash_hands.toLocaleString()} Cash Hands Use The Engine's Exact Settlement.
              The Rest Are Reconstructed From Recorded Actions.
            </div>
          )}
        {hasData &&
          overall.cash_hands > 0 &&
          statsContract.quality.cash_money_source === 'reconstructed_actions' && (
            <div className="stats-notice stats-notice-warn">
              Cash Result And BB/100 Are Reconstructed From Recorded Actions For This Window. No
              Exact Settlement Rows Exist For These Hands Yet.
            </div>
          )}
        {hasData && selectedClubId && statsContract.quality.club_breakdown_starts_at && (
          <div className="stats-notice">
            This Club Ledger Begins{' '}
            {new Date(statsContract.quality.club_breakdown_starts_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
            . Older All-Clubs Rollup Hands Cannot Be Assigned To One Club.
          </div>
        )}
        {hasData &&
          !statsContract.quality.live_tail_included &&
          statsContract.coverage.rollup_covered_through && (
            <div className="stats-notice">
              Snapshot Includes Recorded Hands Through{' '}
              {new Date(statsContract.coverage.rollup_covered_through).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              . Newer Hands Appear After The Next Stats Rollup.
            </div>
          )}
        {servingCache && (
          <div className="stats-notice stats-notice-warn">
            Showing Your Last Loaded Stats - The Refresh Did Not Go Through.
          </div>
        )}
      </div>
    </>
  );
}
