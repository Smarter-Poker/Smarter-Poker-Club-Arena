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
 * ── THE CONSOLE (#ClubArenaConsole) ──────────────────────────────────────────
 *
 * This page used to be a chamfered hero with a clip-path frame, a cyan-railed
 * control slab and three rounded cards holding gradient pills and gold buttons -
 * a frame around a frame around a frame, every part of it drawn in CSS. It is
 * now printed on the spade master, like Club Rules and Club Announcements: the
 * felt photograph is a STANDALONE BANNER with nothing drawn around it, and every
 * section below is one console - identity, controls, and one console per figure
 * group, each figure a row on the black glass with its label in the master's lit
 * blue on the left and its value in silver on the right, separated by an
 * engraved rule rather than a drawn divider.
 *
 * NOT A GRID OF BOXES (Dan 2026-09-09: "I DON'T LIKE THE 4 BOXES, AND THE WAY IT
 * STICKS OUT ON THE SIDES"). The three figure groups were a three-column grid of
 * bordered cards; they are three consoles of rows now.
 *
 * TWO ACTIONS OR NONE. The foot art paints both plates, so a console with one
 * action would leave the other painted and empty. Confirm and Try Again are lit
 * words on the glass instead, and every console here closes on the flat cap.
 *
 * COLOUR IS THE MASTER'S. The page used to carry its own copy of the
 * ClubMembersPage tokens (arena cyan, vip gold) and a "no green" note that
 * belonged to that palette. The console's inks replace both: silver for values,
 * lit blue for labels, green for a positive club result and red for a negative
 * one, which is the ink §3.4 of the standard assigns to chips in and chips out.
 *
 * Mobile-first at 375px, verified at 393px. Everything sizes in cqw against the
 * console, so a 320px phone and a 430px one get the same picture.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { enumToTitleCase } from '../utils/titleCase';
import { compactChips } from '../utils/format';
import { isUUID } from '../utils/clubIdResolver';
import { ClubNotFoundError, resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import ClubRosterService, {
  lastDaysRange,
  isoDate,
  type MemberRange,
  type MemberStatistics,
} from '../services/ClubRosterService';
import './PlayerStatisticsPage.css';

const PLAYER_INSTRUMENT_ART = `${import.meta.env.BASE_URL}images/club-members/player-instrument-felt-v1.webp`;

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

/**
 * Chips off the felt are compact and never carry a decimal point (Dan: "NEVER
 * USE DECIMAL POINTS ON ANY FORWARD FACING PAGE ... once something hits over
 * 1,000 use 1K"). This used to print two decimals on every figure, so a club
 * result of 120 read "120.00". `compactChips` rounds DOWN and keeps the sign,
 * so a negative net stays negative and nothing is ever overstated.
 */
function money(value: number): string {
  return compactChips(value ?? 0);
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
      if (!clubId || !userId) {
        if ((!getIsMounted || getIsMounted()) && isMountedRef.current) {
          setNotFound(true);
          setStats(null);
          setLoading(false);
        }
        return;
      }
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
  const gameLabel = variantLabel(variant);

  /* The word in the header's painted pill slot: the window these figures belong
     to, or why there are none. Every value is one short word, because the slot
     is painted at a fixed width and a fitted label must never touch its rim. */
  const statePill =
    loadFailed && !stats
      ? 'Offline'
      : stats?.is_overall
        ? 'Lifetime'
        : hasHands
          ? RANGE_LABEL[rangeMode]
          : undefined;

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="player-stats-page" aria-busy={loading}>
      {/* The felt is a standalone picture with nothing drawn around it: no
          chamfer, no rail, no border, no gold tick. Dan: "THEY SHOULD JUST BE
          STAND ALONE IMAGES WITH FRAMES AROUND THEM." The frames below are the
          consoles; this is the establishing shot they open on. */}
      <header className="ps-hero">
        <img
          className="ps-hero__art"
          src={PLAYER_INSTRUMENT_ART}
          alt=""
          aria-hidden="true"
          width="1672"
          height="941"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
        <div className="ps-hero__shade" aria-hidden="true" />
        <div className="ps-header">
          <button
            type="button"
            className="ps-back"
            onClick={() => navigate(-1)}
            aria-label="Go Back"
          >
            ‹
          </button>
          <span className="ps-header__location">Players / Performance</span>
          <span className="ps-header__spacer" aria-hidden="true" />
        </div>
      </header>

      <StandardContentLayout className="ps-body">
        <SpadeConsole
          className="ps-console"
          eyebrow="Players"
          title="Player Performance"
          titleId="ps-page-title"
          subtitle="Measured From Verified Hands"
          pill={statePill}
          pillInk={loadFailed && !stats ? 'red' : 'blue'}
          foot="foot"
        >
          <p className="sc-copy">
            Read Playing Style, Volume, And Club Results Across Any Recorded Game Window.
          </p>
          {stats?.authorized && stats.hands > 0 && (
            <div className="ps-rows" role="group" aria-label="Selected Range Summary">
              <StatRow label="Hands" value={count(stats.hands)} />
              <StatRow label="Win Rate" value={pct(stats.win_rate)} />
              <StatRow label="Net" value={money(stats.net)} signed={stats.net} />
            </div>
          )}
        </SpadeConsole>

        <SpadeConsole
          className="ps-console"
          eyebrow="Player Performance"
          title="Instrument Controls"
          subtitle="Choose The Game And Ledger Window"
          foot="foot"
        >
          <label className="ps-variant">
            <span className="ps-variant__label sc-label sc-ink--blue">Game</span>
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

          {/* Four windows, four lit words on the glass. The master paints two
              plates and no segmented control, so this is not drawn as one:
              nothing here has a box, a rim or a fill. The chosen word is lit
              in the master's blue, the rest sit in muted ink. */}
          <div className="ps-range__tabs" role="group" aria-label="Statistics Date Range">
            {(Object.keys(RANGE_LABEL) as StatsRange[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={
                  rangeMode === mode
                    ? 'ps-range__word sc-ink--blue'
                    : 'ps-range__word sc-ink--muted'
                }
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
                <span className="sc-label sc-ink--blue">From</span>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </label>
              <label className="ps-date">
                <span className="sc-label sc-ink--blue">To</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </label>
              {/* One action, so it is a lit word on the glass and not a plate:
                  the foot art paints BOTH plates and a lone one reads broken. */}
              <button type="button" className="ps-word sc-ink--blue" onClick={confirmCustomRange}>
                Confirm
              </button>
            </div>
          )}

          {/* The caption names the range the figures on screen BELONG to. While
              a new range or variant loads the figures below are dimmed. */}
          <p className="ps-range__caption sc-label sc-ink--muted" aria-live="polite">
            {loading && stats
              ? 'Loading The Selected Range...'
              : stats?.is_overall
                ? 'Showing Lifetime Totals'
                : `Showing ${stats?.from ?? range.from ?? '?'} To ${stats?.to ?? range.to ?? '?'}`}
          </p>
        </SpadeConsole>

        {loading && !stats ? (
          <PageSkeleton variant="stats" />
        ) : loadFailed && !stats ? (
          <SpadeConsole
            className="ps-console"
            eyebrow={gameLabel}
            title="Could Not Load Statistics"
            foot="foot"
          >
            <div className="ps-empty" role="alert">
              <p className="sc-copy sc-copy--center">
                This Player's Statistics Are Still There. We Just Could Not Reach Them Right Now.
              </p>
              <button
                type="button"
                className="ps-word sc-ink--blue"
                onClick={() => setReloadKey((n) => n + 1)}
              >
                Try Again
              </button>
            </div>
          </SpadeConsole>
        ) : notFound || !stats ? (
          <EmptyStats
            game={gameLabel}
            heading="Member Not Found"
            body="This Player Is Not A Member Of This Club."
          />
        ) : !stats.authorized ? (
          <EmptyStats
            game={gameLabel}
            heading="Statistics Restricted"
            body="Your Club Role Does Not Permit Access To This Player's Private Performance Data."
          />
        ) : !hasHands ? (
          <EmptyStats
            game={gameLabel}
            heading="No Hands In This Range"
            body={`${gameLabel} Has No Recorded Hands For The Dates You Chose. Widen The Range Or Choose Another Game.`}
          />
        ) : (
          <>
            <SpadeConsole
              className={loading ? 'ps-console ps-console--busy' : 'ps-console'}
              aria-busy={loading || undefined}
              eyebrow={gameLabel}
              title="Playing Style"
              foot="foot"
            >
              <div className="ps-rows">
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
              </div>
            </SpadeConsole>

            <SpadeConsole
              className={loading ? 'ps-console ps-console--busy' : 'ps-console'}
              aria-busy={loading || undefined}
              eyebrow={gameLabel}
              title="Volume"
              foot="foot"
            >
              {/* total_games, total_hands and winner were three labels on two
                  numbers: hands twice, and hands won as "Winner". */}
              <div className="ps-rows">
                <StatRow label="Hands" value={count(stats.hands)} />
                <StatRow label="Hands Won" value={count(stats.hands_won)} />
                <StatRow label="Win Rate" value={pct(stats.win_rate)} />
              </div>
            </SpadeConsole>

            <SpadeConsole
              className={loading ? 'ps-console ps-console--busy' : 'ps-console'}
              aria-busy={loading || undefined}
              eyebrow={gameLabel}
              title="Club Result"
              foot="foot"
            >
              <div className="ps-rows">
                <StatRow label="Net" value={money(stats.net)} signed={stats.net} />
                <StatRow label="Fees" value={money(stats.fees)} />
              </div>
            </SpadeConsole>
          </>
        )}
      </StandardContentLayout>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SMALL PARTS
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * One figure on the glass: the label in the master's lit blue on the left, the
 * value in engraved silver on the right, an engraved rule cut between rows.
 * Nothing is drawn - no card, no tile, no divider.
 *
 * `signed` is the raw number behind `value`, supplied only where the figure can
 * legitimately go below zero. It picks the console's own ink for chips in and
 * chips out (§3.4 of the standard): green up, red down.
 */
function StatRow({ label, value, signed }: { label: string; value: string; signed?: number }) {
  const ink = signed === undefined || signed === 0 ? 'silver' : signed > 0 ? 'green' : 'red';

  return (
    <div className="ps-row">
      <span className="ps-row__label sc-label sc-ink--blue">{label}</span>
      <span className={`ps-row__value sc-ink--${ink}`}>{value}</span>
    </div>
  );
}

function EmptyStats({ game, heading, body }: { game: string; heading: string; body: string }) {
  return (
    <SpadeConsole className="ps-console" eyebrow={game} title={heading} foot="foot">
      <div className="ps-empty">
        <p className="sc-copy sc-copy--center">{body}</p>
      </div>
    </SpadeConsole>
  );
}
