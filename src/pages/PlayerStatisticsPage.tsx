import { usePlayerPreference } from '../hooks/usePlayerPreference';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER STATISTICS - one member, one variant, one span of days
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23, requirement 7: "sortable by day, week, month or a custom
 * range". Day / 7 Days / Month are the last 1, 7 and 30 days inclusive of today -
 * the same lastDaysRange() the Member Management page uses, so "7 Days" means the
 * same thing on both screens (it read "Week", which suggested a calendar week).
 * Custom is two native date fields and a Confirm. Overall is all recorded
 * activity, the record's default.
 *
 * THE RANGE ARRIVES WITH THE LINK. The record opens this page with its own
 * window in the query string (utils/memberRangeLink); a missing or malformed
 * one opens on Overall, as the record does.
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

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';
import { useIsMounted } from '../hooks/useIsMounted';
import { useMasterBusBroadcastChannel } from '../hooks/useMasterBusBroadcastChannel';
import { reportError } from '../utils/errorReporter';
import { countFigure as count, feeFigure, winLossChips } from '../utils/format';
import {
  MEMBER_RANGE_DAYS as RANGE_DAYS,
  readMemberRangeSearch,
  type MemberRangeMode,
} from '../utils/memberRangeLink';
import { enumToTitleCase } from '../utils/titleCase';
import { isUUID } from '../utils/clubIdResolver';
import { ClubNotFoundError, resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import ClubRosterService, {
  RANGE_OVERALL,
  lastDaysRange,
  isoDate,
  type MemberRange,
  type MemberStatistics,
} from '../services/ClubRosterService';
import PageBar from '../components/help/PageBar';
import type { TutorialStep } from '../components/help/PageHelp';
import './PlayerStatisticsPage.css';

/* The hero's eyebrow, title, paragraph, felt art and range readouts are gone
   (Dan, 2026-10-17). The readouts repeated the Volume and Club Result cards.
   The words live behind the "?", and each step lights the control it names. */
const PERFORMANCE_TOUR: TutorialStep[] = [
  {
    title: 'Instrument Controls',
    body: 'Choose The Game And The Ledger Window. Every Card Below Is Measured Over Them.',
    target: '.ps-controls',
  },
  {
    title: 'Playing Style',
    body: 'VPIP, PFR, 3-Bet And Continuation Bets Show How This Player Plays Their Hands.',
    target: '.ps-cards',
  },
];

/* ═══════════════════════════════════════════════════════════════════════════════
   RANGE (requirement 7)
   ═══════════════════════════════════════════════════════════════════════════════ */

type StatsRange = MemberRangeMode;

const RANGE_LABEL: Record<StatsRange, string> = {
  overall: 'Overall',
  day: 'Day',
  week: '7 Days',
  month: 'Month',
  custom: 'Custom',
};

/** The relative windows: they advance with the UTC calendar. */
function relativeDays(mode: StatsRange): number | null {
  return mode === 'day' || mode === 'week' || mode === 'month' ? RANGE_DAYS[mode] : null;
}

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
  const { user } = useAuthUser();
  const isMountedRef = useIsMounted();

  const [stats, setStats] = useState<MemberStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  /* A failed read is not "not a member". They were the same screen. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [variant, setVariant] = useState<string | null>(null);
  // Opened from the record, the link carries the record's window.
  const [initialRange] = useState(() => readMemberRangeSearch(searchParams));
  const [savedRangeMode, saveRangeMode] = usePlayerPreference<StatsRange>(
    'PlayerStatisticsPage:rangeMode',
    initialRange.mode
  );
  const [savedRange, saveRange] = usePlayerPreference<MemberRange>(
    'PlayerStatisticsPage:range',
    initialRange.range
  );
  // A carried record window controls this visit, while plain navigation uses
  // the account preference. A late account read cannot replace the link.
  const [linkedWindow, setLinkedWindow] = useState(() =>
    searchParams.has('range') ? initialRange : null
  );
  const rangeMode = linkedWindow?.mode ?? savedRangeMode;
  const range = linkedWindow?.range ?? savedRange;
  const setRangeMode = useCallback(
    (mode: StatsRange) => {
      setLinkedWindow((current) => (current ? { ...current, mode } : null));
      saveRangeMode(mode);
    },
    [saveRangeMode]
  );
  const setRange = useCallback(
    (next: MemberRange) => {
      setLinkedWindow((current) => (current ? { ...current, range: next } : null));
      saveRange(next);
    },
    [saveRange]
  );
  const [savedCustomFrom, saveCustomFrom] = usePlayerPreference<string>(
    'PlayerStatisticsPage:customFrom',
    () => initialRange.range.from ?? isoDate(new Date())
  );
  const [savedCustomTo, saveCustomTo] = usePlayerPreference<string>(
    'PlayerStatisticsPage:customTo',
    () => initialRange.range.to ?? isoDate(new Date())
  );
  const [linkedCustom, setLinkedCustom] = useState(() =>
    searchParams.has('range') && initialRange.mode === 'custom'
      ? { from: initialRange.range.from!, to: initialRange.range.to! }
      : null
  );
  const customFrom = linkedCustom?.from ?? savedCustomFrom;
  const customTo = linkedCustom?.to ?? savedCustomTo;
  const setCustomFrom = (from: string) => {
    setLinkedCustom((current) => (current ? { ...current, from } : null));
    saveCustomFrom(from);
  };
  const setCustomTo = (to: string) => {
    setLinkedCustom((current) => (current ? { ...current, to } : null));
    saveCustomTo(to);
  };

  /**
   * The variant list only exists once a response has come back, and a response
   * for a filtered variant only lists that one. Remembering the widest list ever
   * seen keeps the dropdown from collapsing to a single option the moment a
   * variant is chosen.
   */
  const [knownVariants, setKnownVariants] = useState<string[]>([]);
  const statsAbortRef = useRef<AbortController | null>(null);
  const scopeKey = `${clubId ?? ''}:${userId ?? ''}:${user?.id ?? ''}`;
  const [resolvedScope, setResolvedScope] = useState<{ key: string; uuid: string } | null>(null);
  const resolvedClubId = resolvedScope?.key === scopeKey ? resolvedScope.uuid : null;
  const readingRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setStats(null);
    setResolvedScope(null);
    queuedRefreshRef.current = false;
    setKnownVariants([]);
    setVariant(null);
    setNotFound(false);
  }, [clubId, userId, user?.id]);

  const load = useCallback(
    async (
      activeVariant: string | null,
      activeRange: MemberRange,
      getIsMounted?: () => boolean,
      background = false
    ) => {
      statsAbortRef.current?.abort();
      const controller = new AbortController();
      statsAbortRef.current = controller;
      if (!clubId || !userId) {
        if ((!getIsMounted || getIsMounted()) && isMountedRef.current) {
          setNotFound(true);
          setStats(null);
          setLoading(false);
        }
        return;
      }
      readingRef.current = true;
      queuedRefreshRef.current = false;
      const live = () =>
        !controller.signal.aborted &&
        (getIsMounted ? getIsMounted() : true) &&
        isMountedRef.current;

      if (live() && !background) {
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
        setResolvedScope({ key: scopeKey, uuid: resolved });

        const result = await ClubRosterService.getMemberStatistics(
          resolved,
          userId,
          activeVariant,
          activeRange,
          controller.signal
        );
        if (!live()) return;
        setStats(result);
        setLoadFailed(false);
        setNotFound(!result.authorized && result.reason === 'not_member');
        if (!result.authorized) setKnownVariants([]);
        if (result.authorized && result.variants.length > 0) {
          setKnownVariants((prev) => {
            const merged = new Set([...prev, ...result.variants]);
            return Array.from(merged).sort();
          });
        }
      } catch (error) {
        if (live()) {
          reportError(error, 'PlayerStatisticsPage.load');
          setLoadFailed(true);
          // A background refresh that fails is named by the stale banner; a
          // toast on every focus or live event would only repeat it.
          if (!background) toast.error('Failed To Load Player Statistics');
        }
      } finally {
        if (live() && !background) setLoading(false);
        if (statsAbortRef.current === controller) {
          readingRef.current = false;
          if (live() && queuedRefreshRef.current) {
            queuedRefreshRef.current = false;
            refreshRef.current();
          }
        }
      }
    },
    [clubId, userId, user?.id, isMountedRef, toast, scopeKey]
  );

  useEffect(() => {
    let mounted = true;
    load(variant, range, () => mounted);
    return () => {
      mounted = false;
      statsAbortRef.current?.abort();
    };
  }, [load, variant, range, reloadKey]);

  // One current read plus one queued reconciliation: event bursts cannot keep
  // aborting the RPC, and current filters/drafts remain owned by the controls.
  refreshRef.current = () => {
    if (!isMountedRef.current || !clubId || !userId || !user?.id) return;
    const days = relativeDays(rangeMode);
    if (days !== null) {
      const current = lastDaysRange(days);
      if (current.from !== range.from || current.to !== range.to) {
        setRange(current);
        return;
      }
    }
    if (readingRef.current) {
      queuedRefreshRef.current = true;
      return;
    }
    void load(variant, range, undefined, true);
  };

  const sameMemberAndViewer = user?.id?.toLowerCase() === userId?.toLowerCase();
  const recordTopic =
    resolvedClubId && userId && isUUID(userId)
      ? `member-record:${resolvedClubId}:${userId.toLowerCase()}`
      : null;
  useMasterBusBroadcastChannel({
    channelName: recordTopic,
    event: 'record_changed',
    private: true,
    enabled: !!recordTopic && !!user?.id,
    onPayload: () => refreshRef.current(),
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') refreshRef.current();
    },
    onSubscriptionError: () => refreshRef.current(),
  });
  // A viewer's own role/removal can withdraw access before the target changes.
  useMasterBusBroadcastChannel({
    channelName:
      resolvedClubId && user?.id && !sameMemberAndViewer
        ? `member-record:${resolvedClubId}:${user.id.toLowerCase()}`
        : null,
    event: 'record_changed',
    private: true,
    enabled: !!resolvedClubId && !!user?.id && !sameMemberAndViewer,
    onPayload: () => refreshRef.current(),
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') refreshRef.current();
    },
    onSubscriptionError: () => refreshRef.current(),
  });

  useEffect(() => {
    const refresh = () => refreshRef.current();
    const visible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  // Relative windows advance on the UTC calendar boundary, even on idle pages.
  useEffect(() => {
    if (relativeDays(rangeMode) === null) return;
    const now = new Date();
    const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const timer = window.setTimeout(() => refreshRef.current(), nextDay - now.getTime() + 25);
    return () => window.clearTimeout(timer);
  }, [rangeMode, range.from, range.to]);

  /* ── Range ──────────────────────────────────────────────────────────────── */

  const chooseRange = useCallback(
    (mode: StatsRange) => {
      setRangeMode(mode);
      if (mode === 'overall') setRange(RANGE_OVERALL);
      const days = relativeDays(mode);
      if (days !== null) setRange(lastDaysRange(days));
      // 'custom' waits for Confirm: a date field fires onChange while the year is
      // still half typed, and each fire would be a round trip.
    },
    [setRangeMode, setRange]
  );

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
  }, [customFrom, customTo, toast, setRange]);

  const hasHands = !!stats && stats.hands > 0;

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="player-stats-page" aria-busy={loading}>
      <PageBar
        title="Player Performance"
        titleId="ps-page-title"
        summary="Read Playing Style, Volume, And Club Results Across Any Recorded Game Window. Every Figure Is Measured From Verified Hands."
        steps={PERFORMANCE_TOUR}
        className="ps-page-bar"
      >
        <button type="button" className="ps-back" onClick={() => navigate(-1)} aria-label="Go Back">
          ‹
        </button>
      </PageBar>

      <section className="ps-controls" aria-labelledby="ps-controls-title">
        <div className="ps-controls__heading">
          <h2 id="ps-controls-title">Instrument Controls</h2>
        </div>
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
        <p
          className="ps-range__caption"
          role="status"
          aria-label="Displayed Performance Scope"
          aria-live="polite"
        >
          {loading && stats
            ? 'Loading The Selected Range...'
            : stats?.is_overall
              ? 'Showing All Recorded Activity'
              : `Showing ${stats?.from ?? range.from ?? '?'} To ${stats?.to ?? range.to ?? '?'} UTC · ${variantLabel(stats ? stats.variant : variant)}`}
        </p>
        <p className="ps-range__caption">
          UTC Dates Include Both From And To. Custom Dates Need Confirm.
        </p>
        {rangeMode === 'custom' && (customFrom !== range.from || customTo !== range.to) && (
          <p className="ps-range__draft" role="status">
            Draft Dates Not Applied. Confirm To Update The Displayed Range.
          </p>
        )}
        {stats?.authorized && (
          <details className="ps-metric-guide" aria-label="Performance Metric Definitions">
            <summary>Metric Definitions</summary>
            <p>
              All Figures Use Recorded Hands For This Club, The Displayed UTC Dates And Game. Older
              Activity May No Longer Be Retained.
            </p>
            <p>
              VPIP Counts Hands With Voluntary Preflop Investment; PFR Counts Hands With A Preflop
              Raise. Both Rates Divide By Hands Dealt.
            </p>
            <p>
              3-Bet Per Hand Divides Three-Bet Hands By Hands Dealt, Not Three-Bet Opportunities.
              Fold To 3-Bet Divides Folds By Opens That Faced A Three-Bet. C-Bet Divides Flop
              Continuation Bets By Recorded Flop Continuation-Bet Opportunities.
            </p>
            <p>
              Hands Won Counts Hands With A Positive Net Result. Win Rate Divides Those Hands By
              Hands Dealt.
            </p>
            <p>
              Net Is The Cash Hand Result Plus Tournament Money (Prizes Paid Minus Buy-Ins) For The
              Selected Game, Matching The Win/Loss Card. Tournament Stack Chips Are Not Counted.
              Fees Sum Rake Paid. Neither Is A Wallet Balance.
            </p>
          </details>
        )}
      </section>

      {loadFailed && stats && (
        <div className="ps-stale" role="alert">
          <div>
            <span className="ps-empty__status">Statistics Connection Interrupted</span>
            <p className="ps-stale__body">
              Could Not Refresh Statistics. The Figures Below Are From The Previous Successful Read.
            </p>
          </div>
          <button
            type="button"
            className="ps-range__pill"
            onClick={() => setReloadKey((n) => n + 1)}
          >
            Try Again
          </button>
        </div>
      )}

      {loading && !stats ? (
        <PageSkeleton variant="stats" />
      ) : loadFailed && !stats ? (
        <div className="ps-empty" role="alert">
          <span className="ps-empty__status">Statistics Connection Interrupted</span>
          <p className="ps-empty__heading">Could Not Load Statistics</p>
          <p className="ps-empty__body">
            This Player's Statistics Are Still There. We Just Could Not Reach Them Right Now.
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
          body={`${variantLabel(stats.variant)} Has No Recorded Hands For The Dates You Chose. Widen The Range Or Choose Another Game.`}
        />
      ) : (
        <div className={loading ? 'ps-cards ps-cards--busy' : 'ps-cards'} aria-busy={loading}>
          <section className="ps-card">
            <h2 className="ps-card__title">Playing Style</h2>
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
            <h2 className="ps-card__title">Club Result</h2>
            <StatRow
              label="Net"
              value={stats.net === null ? 'Unavailable' : winLossChips(stats.net)}
              signed={stats.net}
            />
            <StatRow label="Fees" value={feeFigure(stats.fees)} />
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
function StatRow({
  label,
  value,
  signed,
}: {
  label: string;
  value: string;
  signed?: number | null;
}) {
  const tone = signed == null || signed === 0 ? '' : signed > 0 ? ' ps-stat--up' : ' ps-stat--down';

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
      <span className="ps-empty__status">Awaiting Hand Ledger</span>
      <p className="ps-empty__heading">{heading}</p>
      <p className="ps-empty__body">{body}</p>
    </div>
  );
}
