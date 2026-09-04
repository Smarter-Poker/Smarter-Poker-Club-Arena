/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER STATISTICS - one member, one variant, one span of days
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23, requirement 7: "sortable by day, week, month or a custom
 * range". Day / Week / Month are the last 1, 7 and 30 days inclusive of today -
 * the same lastDaysRange() the Member Management page uses, so "7 Days" means the
 * same thing on both screens. Custom is two native date fields and a Confirm.
 *
 * WHERE THE NUMBERS COME FROM. `ca_club_member_statistics`, through
 * services/ClubRosterService. VPIP, PFR, 3-Bet and C-Bet are computed in Postgres
 * against hand_history, because the denominators differ per figure (VPIP is over
 * hands dealt, C-Bet is over flops seen as the preflop aggressor) and nothing on
 * the client holds the hands to divide by. They arrive as percentages already.
 *
 * THE VARIANT LIST IS DATA, NOT A CONSTANT. `stats.variants` is what this player
 * has actually played in this club, so a club that never spread PLO never offers
 * PLO. "All Variants" is the null variant, which is also the default.
 *
 * AN EMPTY RANGE SAYS SO. Zero hands renders "No Hands In This Range" rather than
 * nine rows of 0.0% - a wall of zeroes reads as a real player who never raises,
 * which is a worse lie than admitting there is no data.
 *
 * Palette and tokens are ClubMembersPage's. No green, no purple.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { enumToTitleCase } from '../utils/titleCase';
import { isUUID } from '../utils/clubIdResolver';
import { ClubNotFoundError, resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import ClubRosterService, {
  lastDaysRange,
  isoDate,
  type MemberRange,
  type MemberStatistics,
} from '../services/ClubRosterService';
import './PlayerStatisticsPage.css';

/* ═══════════════════════════════════════════════════════════════════════════════
   RANGE (requirement 7)
   ═══════════════════════════════════════════════════════════════════════════════ */

type StatsRange = 'day' | 'week' | 'month' | 'custom';

const RANGE_LABEL: Record<StatsRange, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  custom: 'Custom',
};

const RANGE_DAYS: Record<Exclude<StatsRange, 'custom'>, number> = {
  day: 1,
  week: 7,
  month: 30,
};

/* ═══════════════════════════════════════════════════════════════════════════════
   FORMATTING
   ═══════════════════════════════════════════════════════════════════════════════ */

/** Percentages, one decimal, suffixed. */
function pct(value: number): string {
  return `${(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function count(value: number): string {
  return (value ?? 0).toLocaleString();
}

function money(value: number): string {
  return (value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 'no_limit_holdem' is not a label. 'All Variants' is the null variant. */
function variantLabel(variant: string | null): string {
  if (!variant || variant === 'all') return 'All Variants';
  return enumToTitleCase(variant);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════════════ */

export default function PlayerStatisticsPage() {
  const { clubId: routeClubId, userId: routeUserId } = useParams();
  const [searchParams] = useSearchParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const userId = routeUserId || undefined;

  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [stats, setStats] = useState<MemberStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  /* A failed read is not "not a member". They were the same screen. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [variant, setVariant] = useState<string | null>(null);
  const [rangeMode, setRangeMode] = useState<StatsRange>('month');
  const [customFrom, setCustomFrom] = useState<string>(() => isoDate(new Date()));
  const [customTo, setCustomTo] = useState<string>(() => isoDate(new Date()));
  const [range, setRange] = useState<MemberRange>(() => lastDaysRange(RANGE_DAYS.month));

  /**
   * The variant list only exists once a response has come back, and a response
   * for a filtered variant only lists that one. Remembering the widest list ever
   * seen keeps the dropdown from collapsing to a single option the moment a
   * variant is chosen.
   */
  const [knownVariants, setKnownVariants] = useState<string[]>([]);

  const load = useCallback(
    async (
      activeVariant: string | null,
      activeRange: MemberRange,
      getIsMounted?: () => boolean
    ) => {
      if (!clubId || !userId) return;
      const live = () => (getIsMounted ? getIsMounted() : true) && isMountedRef.current;

      if (live()) {
        setLoading(true);
        setLoadFailed(false);
      }
      try {
        // resolveClubUUID never returned falsy (it hands back the slug), so
        // the old `!resolved` guard was dead and a bad slug reached the uuid
        // RPC as 22P02, shown as an outage. Strict resolution names not-found.
        if (!isUUID(userId)) {
          if (live()) {
            setNotFound(true);
            setStats(null);
          }
          return;
        }
        let resolved: string;
        try {
          resolved = await resolveClubUUIDStrict(clubId);
        } catch (e) {
          if (e instanceof ClubNotFoundError) {
            if (live()) {
              setNotFound(true);
              setStats(null);
            }
            return;
          }
          throw e;
        }
        if (!live()) return;

        const result = await ClubRosterService.getMemberStatistics(
          resolved,
          userId,
          activeVariant,
          activeRange
        );
        if (!live()) return;
        setStats(result);
        setNotFound(!result.authorized && result.reason === 'not_member');
        if (result.variants.length > 0) {
          setKnownVariants((prev) => {
            const merged = new Set([...prev, ...result.variants]);
            return Array.from(merged).sort();
          });
        }
      } catch (error) {
        reportError(error, 'PlayerStatisticsPage.load');
        if (live()) {
          setLoadFailed(true);
          toast.error('Failed To Load Player Statistics');
        }
      } finally {
        if (live()) setLoading(false);
      }
    },
    [clubId, userId, isMountedRef, toast]
  );

  useEffect(() => {
    let mounted = true;
    load(variant, range, () => mounted);
    return () => {
      mounted = false;
    };
  }, [load, variant, range, reloadKey]);

  /* ── Range ──────────────────────────────────────────────────────────────── */

  const chooseRange = useCallback((mode: StatsRange) => {
    setRangeMode(mode);
    if (mode !== 'custom') setRange(lastDaysRange(RANGE_DAYS[mode]));
    // 'custom' waits for Confirm: a date field fires onChange while the year is
    // still half typed, and each fire would be a round trip.
  }, []);

  const confirmCustomRange = useCallback(() => {
    if (!customFrom || !customTo) {
      toast.error('Choose Both A Start And An End Date');
      return;
    }
    if (customFrom > customTo) {
      toast.error('The Start Date Must Come Before The End Date');
      return;
    }
    setRange({ from: customFrom, to: customTo });
  }, [customFrom, customTo, toast]);

  const hasHands = !!stats && stats.hands > 0;

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="player-stats-page">
      <header className="ps-header">
        <button type="button" className="ps-back" onClick={() => navigate(-1)} aria-label="Go Back">
          ‹
        </button>
        <h1 className="ps-title">Player Statistics</h1>
        <span className="ps-header__spacer" aria-hidden="true" />
      </header>

      <div className="ps-controls">
        <label className="ps-variant">
          <span className="ps-variant__label">Game</span>
          <select
            value={variant ?? ''}
            onChange={(e) => setVariant(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">All Variants</option>
            {knownVariants.map((v) => (
              <option key={v} value={v}>
                {variantLabel(v)}
              </option>
            ))}
          </select>
        </label>

        <div className="ps-range__tabs" role="group" aria-label="Statistics Date Range">
          {(Object.keys(RANGE_LABEL) as StatsRange[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={rangeMode === mode ? 'active' : ''}
              aria-pressed={rangeMode === mode}
              onClick={() => chooseRange(mode)}
            >
              {RANGE_LABEL[mode]}
            </button>
          ))}
        </div>

        {rangeMode === 'custom' && (
          <div className="ps-range__custom">
            <label className="ps-date">
              <span>From</span>
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label className="ps-date">
              <span>To</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
            <button type="button" className="ps-range__confirm" onClick={confirmCustomRange}>
              Confirm
            </button>
          </div>
        )}

        {/* The caption names the range the figures on screen BELONG to. While
            a new range or variant loads the figures below are dimmed. */}
        <p className="ps-range__caption" aria-live="polite">
          {loading && stats
            ? 'Loading The Selected Range...'
            : stats?.is_overall
              ? 'Showing Lifetime Totals'
              : `Showing ${stats?.from ?? range.from ?? '?'} To ${stats?.to ?? range.to ?? '?'}`}
        </p>
      </div>

      {loading && !stats ? (
        <PageSkeleton variant="stats" />
      ) : loadFailed && !stats ? (
        <div className="ps-empty" role="alert">
          <span className="ps-empty__mark" aria-hidden="true">
            !
          </span>
          <p className="ps-empty__heading">Could Not Load Statistics</p>
          <p className="ps-empty__body">
            This Player's Statistics Are Still There - We Just Could Not Reach Them Right Now.
          </p>
          <button
            type="button"
            className="ps-range__pill"
            onClick={() => setReloadKey((n) => n + 1)}
          >
            Try Again
          </button>
        </div>
      ) : notFound || !stats ? (
        <EmptyStats heading="Member Not Found" body="This Player Is Not A Member Of This Club." />
      ) : !stats.authorized ? (
        <EmptyStats
          heading="Statistics Restricted"
          body="Your Club Role Does Not Permit Access To This Player's Private Performance Data."
        />
      ) : !hasHands ? (
        <EmptyStats
          heading="No Hands In This Range"
          body={`${variantLabel(variant)} Has No Recorded Hands For The Dates You Chose. Widen The Range Or Choose Another Game.`}
        />
      ) : (
        <div className={loading ? 'ps-cards ps-cards--busy' : 'ps-cards'} aria-busy={loading}>
          <section className="ps-card">
            <h2 className="ps-card__title">Style</h2>
            <StatRow label="VPIP" value={pct(stats.vpip)} />
            <StatRow label="PFR" value={pct(stats.pfr)} />
            {/* Per hand dealt, and labelled so. The old figure divided 3-bets
                by the hands this player was 3-bet in after opening, and read
                316.7% for one of the club's most active players. */}
            <StatRow
              label="3-Bet Per Hand"
              value={`${pct(stats.three_bet)} (${count(stats.three_bets)})`}
            />
            <StatRow
              label="Fold To 3-Bet"
              value={
                stats.faced_three_bets > 0
                  ? `${pct(stats.fold_to_three_bet)} Of ${count(stats.faced_three_bets)}`
                  : 'Never 3-Bet After Opening'
              }
            />
            <StatRow
              label="C-Bet"
              value={
                stats.cbet_opportunities > 0
                  ? `${pct(stats.cbet)} Of ${count(stats.cbet_opportunities)}`
                  : 'No Flop Led As Aggressor'
              }
            />
          </section>

          <section className="ps-card">
            <h2 className="ps-card__title">Volume</h2>
            {/* total_games, total_hands and winner were three labels on two
                numbers: hands twice, and hands won as "Winner". */}
            <StatRow label="Hands" value={count(stats.hands)} />
            <StatRow label="Hands Won" value={count(stats.hands_won)} />
            <StatRow label="Win Rate" value={pct(stats.win_rate)} />
          </section>

          <section className="ps-card">
            <h2 className="ps-card__title">Result</h2>
            <StatRow label="Net" value={money(stats.net)} signed={stats.net} />
            <StatRow label="Fees" value={money(stats.fees)} />
          </section>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SMALL PARTS
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * `signed` is the raw number behind `value`, supplied only where the figure can
 * legitimately go below zero. Positive is arena cyan, negative is --danger-red.
 * There is no green in this product.
 */
function StatRow({ label, value, signed }: { label: string; value: string; signed?: number }) {
  const tone =
    signed === undefined || signed === 0 ? '' : signed > 0 ? ' ps-stat--up' : ' ps-stat--down';

  return (
    <div className={`ps-stat${tone}`}>
      <span className="ps-stat__label">{label}</span>
      <span className="ps-stat__value">{value}</span>
    </div>
  );
}

function EmptyStats({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="ps-empty">
      <span className="ps-empty__mark" aria-hidden="true">
        ○
      </span>
      <p className="ps-empty__heading">{heading}</p>
      <p className="ps-empty__body">{body}</p>
    </div>
  );
}
