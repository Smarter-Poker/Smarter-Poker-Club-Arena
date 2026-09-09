/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REWARDS — what this event pays, and what is left to be pulled out of it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "REWARDS PAGE SHOULD SHOW ALL THE PAYOUTS IN ORDER
 * ONLY. IF ITS A BOUNTY SHOW THE BOUNTY POOL. IF ITS A MYSTERY BOUNTY SHOW THE
 * TOTAL BOUNTY POOL AND WHATS LEFT OR 'STILL AVAILABLE' IN THE MYSTERY BOUNTY
 * POOL."
 *
 * The block this replaces (TournamentDetails.tsx:1628-1827) printed the payout
 * list and then printed THE FIRST TEN LEVELS OF THE BLIND STRUCTURE underneath
 * it. The Blinds tab already owns that table in full, so the lobby showed the
 * same levels twice, disagreeing on how many. There is no blind structure in
 * this file and there must never be one again: a tab that answers two questions
 * answers neither, and the duplicate is what Dan actually complained about.
 *
 * ── WHERE EVERY NUMBER COMES FROM (checked against production, not assumed) ──
 *
 *   prize pool          tournaments.prize_pool          (numeric, server owns
 *                       it: recalculated on every registration / rebuy / add-on
 *                       with the fee stripped and horses excluded)
 *   guarantee           tournaments.guaranteed_prize    (numeric)
 *   settled or not      tournaments.prize_pool_finalized (boolean, 20,880 rows
 *                       set) - the ONLY honest way to know whether these
 *                       figures are final or still moving
 *   payout structure    tournaments.payout_structure    (TEXT holding JSON)
 *   bounty flags        tournaments.is_bounty / is_pko / is_mystery_bounty
 *   funded bounty pool  tournaments.bounty_pool / bounty_pool_paid (numeric,
 *                       457 / 449 rows populated - these are real money columns
 *                       maintained by fn_collect_bounty)
 *   base head value     tournaments.bounty_amount
 *   live heads          tournament_players.current_bounty (9,011 rows > 0)
 *   claimed heads       tournament_bounties.bounty_amount (6,790 rows)
 *
 * ── THE MYSTERY LADDER LIVES IN MysteryBountyPanel, NOT IN THIS FILE ────────
 *
 * CORRECTED 2026-08-25. An earlier draft of this file built its own "top
 * prizes" ladder by grouping tournament_players.current_bounty, and printed
 * the advertised mystery_bounty_min / mystery_bounty_max range above it. That
 * was right for the world it was written against, in which every head was drawn
 * AT REGISTRATION and the chest inventory
 * (tournament_bounty_chests + fn_mystery_bounty_inventory) held zero rows with
 * nothing calling it.
 *
 * The chest inventory shipped the same day. The draw now happens ONCE, when the
 * mystery phase opens, and produces a real tiered ladder;
 * `services/MysteryBountyService` reads it, `hooks/useMysteryBounty` keeps it
 * live, and `components/tournament/MysteryBountyPanel` renders it with the
 * awards feed and the leaderboard beside it. The engine does not read
 * mystery_bounty_min / mystery_bounty_max at all any more, so advertising them
 * would quote a player a number nothing will ever pay.
 *
 * So this tab keeps what the panel does NOT carry - the funded pool, what has
 * been claimed out of it, and what is still available, which is exactly what
 * Dan asked Rewards for - and renders the panel underneath for the ladder
 * itself. One fetch feeds both, because the page passes the hook result in
 * through `mysteryBounty` on the tab contract.
 *
 * ── ONE QUERY, AND ONLY WHEN IT IS NEEDED ──────────────────────────────────
 *
 * types.ts asks tabs to prefer props. The props carry the tournament row, so
 * the entire payout side of this tab is computed with no query at all. The two
 * bounty queries fire ONLY for a bounty event, are cancelled on unmount, and
 * tolerate an empty result: a bounty panel that never resolves is worse than
 * one that says the pool has not been funded yet.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import type { TournamentTabProps, PayoutPlace } from './types';
import {
  chips,
  effectivePlaceLadderPool,
  effectivePrizePool,
  isPlayerLive,
  lastPaidPlace,
  ordinal,
  placePrize,
  resolvePayoutStructure,
} from './types';
import MysteryBountyPanel from '../MysteryBountyPanel';
import '../../../styles/tournament-lobby-3d.css';
import './RewardsTab.css';

/* ═══════════════════════════════════════════════════════════════════════════
   PAYOUT STRUCTURE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A run of consecutive places paying the same percentage: 1st, 2nd, 3rd, then
 * 4-6, 7-9. Dan asked for the ranges "exactly as the structure defines", so a
 * band is only formed where the STORED structure gives neighbouring places an
 * identical percentage. Nothing is merged for tidiness.
 */
interface PayoutBand {
  fromPlace: number;
  toPlace: number;
  percentage: number;
}

/** Coerce anything the column might hold into a finite number. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* The parser that used to live here now lives in `types.ts` and is shared with
   Detail (podium prizes, the hand-for-hand bubble count) and Ranking (distance
   to the money). Three copies of it disagreed about how many places a range row
   pays; see the note above `parsePayoutStructure` in types.ts. */

/** Collapse consecutive places paying the same percentage into one band. */
function toBands(places: PayoutPlace[]): PayoutBand[] {
  const bands: PayoutBand[] = [];
  for (const p of places) {
    const last = bands[bands.length - 1];
    if (last && last.percentage === p.percentage && last.toPlace === p.place - 1) {
      last.toPlace = p.place;
    } else {
      bands.push({ fromPlace: p.place, toPlace: p.place, percentage: p.percentage });
    }
  }
  return bands;
}

/** "1st" for a single place, "4-6" for a band. A hyphen, never a dash. */
function bandLabel(band: PayoutBand): string {
  return band.fromPlace === band.toPlace
    ? ordinal(band.fromPlace)
    : `${band.fromPlace}-${band.toPlace}`;
}

/** Percentages print without a trailing ".0" but keep a real decimal. */
function pct(n: number): string {
  return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOUNTY POOL
   ═══════════════════════════════════════════════════════════════════════════ */

interface BountyLedger {
  /** Heads still sitting on live players, i.e. prizes nobody has pulled. */
  liveHeads: number[];
  /** Every head already claimed, from the tournament_bounties ledger. */
  claimedHeads: number[];
  loaded: boolean;
  /**
   * The read FAILED, as distinct from returning nothing.
   *
   * Without this the two are the same state and the panel renders "The Bounty
   * Pool Is Not Funded Yet" -- a confident factual claim about a funded pool --
   * whenever RLS, a network error or a bad column stopped the query. See the
   * loader for why the failure was invisible.
   */
  failed: boolean;
}

const EMPTY_LEDGER: BountyLedger = {
  liveHeads: [],
  claimedHeads: [],
  loaded: false,
  failed: false,
};

/** Round money to cents so 20.000000001 and 20 are the same rung. */
function cents(n: number): number {
  return Math.round(num(n) * 100) / 100;
}

/** PostgREST's default ceiling. A request without `.range()` stops here. */
const PAGE = 1000;
/** 100k heads is far past any real field; the cap stops a runaway loop. */
const MAX_PAGES = 100;

/**
 * Read every row, not the first thousand.
 *
 * Both bounty queries were unbounded, which does not mean unlimited: PostgREST
 * caps a request with no range at 1,000 rows and says nothing about it. This
 * tab's own header cites 9,011 rows in `tournament_players.current_bounty` and
 * 6,790 in `tournament_bounties`, and the branch these arrays exist to serve is
 * exactly the one where `bounty_pool` is 0 and the totals are derived from the
 * heads themselves. On a large mystery bounty the pool was silently understated
 * and "Still Available" was simply wrong.
 *
 * Throwing on `error` is the other half of the fix, and the more important one:
 * a query builder resolves with `{data: null, error}` rather than rejecting, so
 * a caller that destructures only `.data` turns every failure into an empty
 * result. See the catch in the loader.
 */
async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, (i + 1) * PAGE - 1);
    if (error) throw error;
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  return out;
}

/**
 * Tournament columns this tab reads that `Tournament` does not declare by name.
 * The interface carries an index signature so these resolve, but naming them
 * here is what makes the tab readable.
 */
interface RewardColumns {
  prize_pool?: number | null;
  guaranteed_prize?: number | null;
  prize_pool_finalized?: boolean | null;
  payout_structure?: unknown;
  spin_multiplier?: number | null;
  is_bounty?: boolean | null;
  is_pko?: boolean | null;
  is_mystery_bounty?: boolean | null;
  bounty_amount?: number | null;
  bounty_pool?: number | null;
  bounty_pool_paid?: number | null;
  status?: string | null;
  current_players?: number | null;
  bubble_protection?: boolean | null;
  buy_in_amount?: number | null;
  variant?: string | null;
  tournament_type?: string | null;
  satellite_target_id?: string | null;
  satellite_target?: string | null;
}

/* Still holding chips, by the lobby's ONE definition of "in". This tab used to
   define it as `registered | playing`, which excludes a winner, while Ranking
   counted anyone not out - so the money bubble here could be measured against a
   different field size than the "To The Money" line Ranking prints
   (2026-08-26 audit). */
const isStillIn = isPlayerLive;

export default function RewardsTab({
  tournament,
  entries,
  currentUserId,
  mysteryBounty,
}: TournamentTabProps) {
  const t = (tournament || {}) as unknown as RewardColumns;
  const tournamentId = tournament?.id;

  const isPko = !!t.is_pko;
  const isMystery = !!t.is_mystery_bounty;
  const isBountyEvent = !!t.is_bounty || isPko || isMystery;

  const [ledger, setLedger] = useState<BountyLedger>(EMPTY_LEDGER);

  /* Two queries, bounty events only, cancelled on unmount. */
  useEffect(() => {
    if (!tournamentId || !isBountyEvent) {
      setLedger(EMPTY_LEDGER);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const [live, claimed] = await Promise.all([
          fetchAllRows<{ current_bounty: unknown }>((from, to) =>
            supabase
              .from('tournament_players')
              .select('current_bounty')
              .eq('tournament_id', tournamentId)
              .gt('current_bounty', 0)
              .range(from, to)
          ),
          fetchAllRows<{ bounty_amount: unknown }>((from, to) =>
            supabase
              .from('tournament_bounties')
              .select('bounty_amount')
              .eq('tournament_id', tournamentId)
              .range(from, to)
          ),
        ]);
        if (cancelled) return;

        setLedger({
          liveHeads: live.map((r) => cents(num(r.current_bounty))),
          claimedHeads: claimed.map((r) => cents(num(r.bounty_amount))),
          loaded: true,
          failed: false,
        });
      } catch (e) {
        if (!cancelled) {
          /* THE CATCH USED TO BE UNREACHABLE FOR A QUERY ERROR. A Supabase
             query builder RESOLVES with `{data: null, error}`; it does not
             reject. The old code destructured only `.data`, coalesced null to
             `[]`, set `loaded: true` and reported nothing -- so an RLS denial
             on a funded pool rendered "The Bounty Pool Is Not Funded Yet" as
             fact, with no trace in Sentry. fetchAllRows throws on `error`, so
             this branch now actually runs, and `failed` keeps the panel from
             making that claim. */
          setLedger({ liveHeads: [], claimedHeads: [], loaded: true, failed: true });
          reportError(e, 'RewardsTab.bounty_ledger_load_failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tournamentId, isBountyEvent]);

  /* ── FIELD STATE ──────────────────────────────────────────────────────── */

  const isRunning = String(t.status || '').toUpperCase() === 'RUNNING';
  const isComplete = String(t.status || '').toUpperCase() === 'COMPLETED';

  const entryCount = entries.length || num(t.current_players);
  const playersRemaining = useMemo(() => {
    const live = entries.filter(isStillIn).length;
    return live > 0 ? live : isRunning ? num(t.current_players) : entryCount;
  }, [entries, isRunning, t.current_players, entryCount]);

  /* ── THE POOL ─────────────────────────────────────────────────────────── */

  const dbPool = num(t.prize_pool);
  const guarantee = num(t.guaranteed_prize);
  const hasGuarantee = guarantee > 0;
  /* The advertised pool is whichever is larger. The DB pool is authoritative
     for what was actually collected; the guarantee is what the club promised,
     and the difference is the overlay the club funds itself. Shared with
     Detail's podium via `effectivePrizePool` so the two cannot disagree. */
  const effectivePool = effectivePrizePool(t.prize_pool, t.guaranteed_prize);
  const overlay = hasGuarantee ? Math.max(0, guarantee - dbPool) : 0;
  const guaranteeMet = hasGuarantee && overlay <= 0;

  const isFinalised = !!t.prize_pool_finalized;

  /* ── THE LADDER OF PLACES ─────────────────────────────────────────────── */

  const parsedPlaces = useMemo(() => resolvePayoutStructure(tournament), [tournament]);
  const bands = useMemo(() => (parsedPlaces ? toBands(parsedPlaces) : []), [parsedPlaces]);
  const paidPlaces = parsedPlaces ? parsedPlaces.length : 0;

  /**
   * PROVISIONAL means the figures can still move. Two independent reasons, and
   * both matter: an unfinalised pool moves with every late registration and
   * rebuy, and a missing structure means nobody has decided how many places
   * get paid. Neither is presented as settled fact.
   */
  const provisionalReason = !parsedPlaces
    ? 'No Payout Structure Has Been Published For This Event Yet'
    : !isFinalised && !isComplete
      ? 'Provisional. The Prize Pool Is Still Moving With Entries, Rebuys And Add Ons'
      : null;

  /* ── THE BUBBLE ───────────────────────────────────────────────────────── */

  /* The stone bubble is one place AFTER the deepest paid place. Players still
     to bust before the money is still measured against the final paid place. */
  /**
   * A COUNT AND A PLACE NUMBER ARE NOT THE SAME THING.
   *
   * This was `paidPlaces`, the LENGTH of the parsed ladder. `parsePayoutStructure`
   * de-duplicates and sorts but does not require the places to run contiguously
   * from 1, so a structure paying 1, 2, 3 and 5 has length 4 -- a place that is
   * not paid at all. Three things then went wrong at once on such a structure:
   * the "Money Bubble" tile printed 4th, the highlighted row matched the wrong
   * band or none, and `toTheMoney` counted down to the wrong number.
   *
   * `paidPlaces` is still the right value for "N Paid Places" and for the
   * percentage-of-field figure. The final paid place comes from the deepest
   * structure position, and the stone bubble is exactly one place after it.
   */
  const finalPaidPlace = useMemo(() => lastPaidPlace(parsedPlaces), [parsedPlaces]);
  const stoneBubblePlace = finalPaidPlace > 0 ? finalPaidPlace + 1 : 0;
  const isSatellite =
    String(t.variant ?? '').toLowerCase() === 'satellite' ||
    String(t.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
    Boolean(t.satellite_target_id || t.satellite_target);
  const placeLadderPool = effectivePlaceLadderPool(
    t.prize_pool,
    t.guaranteed_prize,
    parsedPlaces,
    entryCount,
    t.bubble_protection === true,
    num(t.buy_in_amount),
    isSatellite
  );
  const bubbleProtectionReserve =
    placeLadderPool === null ? 0 : Math.max(0, effectivePool - placeLadderPool);
  const toTheMoney = finalPaidPlace > 0 ? Math.max(0, playersRemaining - finalPaidPlace) : 0;
  const inTheMoney = finalPaidPlace > 0 && playersRemaining <= finalPaidPlace;
  const onTheBubble = stoneBubblePlace > 0 && playersRemaining === stoneBubblePlace;

  /* ── THE HERO ─────────────────────────────────────────────────────────── */

  const hero = useMemo(
    () => (currentUserId ? entries.find((e) => e.user_id === currentUserId) : undefined),
    [entries, currentUserId]
  );
  const heroStillIn = !!hero && isStillIn(hero);
  const heroFinish = hero?.position && hero.position > 0 ? hero.position : null;

  /**
   * Which line belongs to the hero.
   *
   * Settled once they have a finishing position. While they are still playing
   * the only defensible projection is the place they would take if they busted
   * on the very next hand, which is exactly `playersRemaining` - and it is
   * labelled as that, not as a prediction of where they will finish.
   */
  const heroPlace = heroFinish ?? (heroStillIn && isRunning ? playersRemaining : null);
  const heroBandIndex = useMemo(() => {
    if (!heroPlace) return -1;
    return bands.findIndex((b) => heroPlace >= b.fromPlace && heroPlace <= b.toPlace);
  }, [bands, heroPlace]);

  /* ── BOUNTY MONEY ─────────────────────────────────────────────────────── */

  const bounty = useMemo(() => {
    if (!isBountyEvent) return null;

    const perKnockout = num(t.bounty_amount);
    const fundedPool = num(t.bounty_pool);
    const fundedPaid = num(t.bounty_pool_paid);

    const liveTotal = ledger.liveHeads.reduce((s, v) => s + v, 0);
    const claimedTotal = ledger.claimedHeads.reduce((s, v) => s + v, 0);

    /* The funded columns are money the server maintains inside the same
       transaction that pays a bounty, so they win when they exist. The head
       ledger is the fallback for an event whose pool was never funded as a
       lump (bounty_pool = 0), where the heads themselves ARE the pool. */
    const total = fundedPool > 0 ? fundedPool : claimedTotal + liveTotal;
    const claimed = fundedPool > 0 ? fundedPaid : claimedTotal;
    const available = Math.max(0, total - claimed);
    /* What is LEFT, as a percentage, so the meter empties as heads are pulled.
       It was called `drained`, which is the opposite of what it measures. */
    const remainingPct = total > 0 ? Math.min(100, Math.max(0, (available / total) * 100)) : 0;

    /* A "top rungs" ladder, derived by grouping `current_bounty` values, used
       to be built here. It is gone, and so is the advertised
       `mystery_bounty_min` / `mystery_bounty_max` range that sat above it: both
       described the pre-2026-08-25 world in which every head was drawn at
       REGISTRATION. The chest inventory shipped that day, the draw now happens
       once when the mystery phase opens, and `MysteryBountyPanel` renders the
       real ladder off `fn_mystery_bounty_inventory` - tiers, what is left, who
       pulled what. Two ladders on one tab, disagreeing, is worse than either.
       This memo keeps the FUNDED POOL figures, which the panel does not carry
       and which are what Dan asked this tab for. */

    return {
      perKnockout,
      total,
      claimed,
      available,
      remainingPct,
      knockoutsPaid: ledger.claimedHeads.length,
    };
  }, [isBountyEvent, t.bounty_amount, t.bounty_pool, t.bounty_pool_paid, ledger]);

  const bountyKind = isMystery ? 'Mystery Bounty' : isPko ? 'Progressive Knockout' : 'Bounty';

  /* ═════════════════════════════════════════════════════════════════════════
     RENDER
     ═════════════════════════════════════════════════════════════════════════ */

  return (
    <div className="rw">
      {/* ── HEADLINE: the pool, the guarantee, the bubble ─────────────────── */}
      <section className="tl-panel rw-head">
        <div className="tl-section-head">
          <h3>Prizes</h3>
          {paidPlaces > 0 && (
            <span className="tl-section-note">
              {paidPlaces} Paid {paidPlaces === 1 ? 'Place' : 'Places'}
            </span>
          )}
        </div>

        <div className="tl-stat-grid">
          <div className="tl-stat tl-stat--feature rw-pool">
            <span className="tl-stat__label">Total Prize Pool</span>
            <span className="tl-stat__value tl-stat__value--accent rw-pool__value">
              {effectivePool > 0 ? chips(effectivePool) : 'Set By Entries'}
            </span>
            <span className="tl-stat__sub">
              {isFinalised || isComplete ? 'Final' : 'Still Growing'}
            </span>
          </div>

          {hasGuarantee && (
            <div className="tl-stat">
              <span className="tl-stat__label">Guaranteed</span>
              <span className="tl-stat__value">{chips(guarantee)}</span>
              <span className={`tl-stat__sub ${guaranteeMet ? 'rw-sub--good' : 'rw-sub--warn'}`}>
                {guaranteeMet ? 'Guarantee Met' : `${chips(overlay)} Overlay`}
              </span>
            </div>
          )}

          <div className="tl-stat">
            <span className="tl-stat__label">Entries</span>
            <span className="tl-stat__value">{chips(entryCount)}</span>
            {isRunning && <span className="tl-stat__sub">{chips(playersRemaining)} Left</span>}
          </div>

          {stoneBubblePlace > 0 && (
            <div className="tl-stat">
              <span className="tl-stat__label">Money Bubble</span>
              <span className="tl-stat__value">{ordinal(stoneBubblePlace)}</span>
              <span className="tl-stat__sub">
                {!isRunning
                  ? 'First Place Outside The Money'
                  : inTheMoney
                    ? 'Field Is In The Money'
                    : onTheBubble
                      ? 'One Player To Go'
                      : `${chips(toTheMoney)} To Bust`}
              </span>
            </div>
          )}

          {bubbleProtectionReserve > 0 && (
            <div className="tl-stat">
              <span className="tl-stat__label">Bubble Protection</span>
              <span className="tl-stat__value">{chips(bubbleProtectionReserve)}</span>
              <span className="tl-stat__sub">
                From Prize Pool For {ordinal(stoneBubblePlace)} Place
              </span>
            </div>
          )}
        </div>

        {hasGuarantee && !guaranteeMet && effectivePool > 0 && (
          <div className="rw-gtd">
            <div className="rw-gtd__row">
              <span className="rw-gtd__label">Collected Against The Guarantee</span>
              <span className="rw-gtd__figure">
                {chips(dbPool)} Of {chips(guarantee)}
              </span>
            </div>
            <div className="tl-meter" aria-hidden="true">
              <div
                className="tl-meter__fill tl-meter__fill--under"
                style={{ width: `${Math.min(100, (dbPool / guarantee) * 100)}%` }}
              />
            </div>
            <p className="rw-gtd__note">
              The Club Covers The {chips(overlay)} Overlay If The Field Does Not Close It
            </p>
          </div>
        )}

        {provisionalReason && <p className="rw-provisional">{provisionalReason}</p>}
      </section>

      {/* ── THE PAYOUTS, IN FINISHING ORDER, AND NOTHING ELSE ─────────────── */}
      <section className="tl-panel rw-payouts">
        <div className="tl-section-head">
          <h3>Payouts</h3>
          {effectivePool > 0 && paidPlaces > 0 && (
            <span className="tl-section-note">
              {Math.round((paidPlaces / Math.max(1, entryCount)) * 1000) / 10}% Of The Field Paid
            </span>
          )}
        </div>

        {bands.length === 0 ? (
          <div className="tl-empty">
            No Payout Structure Yet
            <span className="tl-empty__hint">
              The Places Are Set When The Field Closes. Check Back At The Start.
            </span>
          </div>
        ) : (
          <ul className="tl-list rw-list">
            {bands.map((band, i) => {
              const isPodium = band.fromPlace <= 3 && band.fromPlace === band.toPlace;
              const isLastPaidRow = band.toPlace === finalPaidPlace;
              const isHeroRow = i === heroBandIndex;
              // Priced from the WHOLE structure: the last paid place absorbs the
              // residual so the places sum to the pool, which a single
              // percentage cannot express. A band shares one percentage, so its
              // first place is representative of the band.
              const prize =
                placeLadderPool !== null && placeLadderPool > 0 && parsedPlaces
                  ? placePrize(placeLadderPool, parsedPlaces, band.fromPlace)
                  : 0;

              return (
                <li
                  key={`${band.fromPlace}-${band.toPlace}`}
                  className={[
                    'tl-row',
                    'rw-row',
                    isPodium ? `rw-row--podium rw-row--p${band.fromPlace}` : '',
                    isHeroRow ? 'tl-row--hero' : '',
                    isLastPaidRow ? 'rw-row--bubble' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={`tl-rank rw-rank ${isPodium ? 'tl-rank--podium' : ''}`}>
                    {bandLabel(band)}
                  </span>

                  <span className="rw-row__mid">
                    <span className="rw-pct">{pct(band.percentage)}</span>
                    {isHeroRow && (
                      <span className="tl-badge tl-badge--action rw-tag">
                        {heroFinish ? 'Your Finish' : 'You If You Bust Now'}
                      </span>
                    )}
                    {isLastPaidRow && !isHeroRow && (
                      <span className="tl-badge tl-badge--mute rw-tag">Last Paid Place</span>
                    )}
                  </span>

                  <span className="tl-num tl-num--accent rw-prize">
                    {prize > 0 ? chips(prize) : '-'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── BOUNTY POOL ──────────────────────────────────────────────────── */}
      {isBountyEvent && bounty && (
        <section className="tl-panel rw-bounty">
          <div className="tl-section-head">
            <h3>{bountyKind} Pool</h3>
            <span className="tl-badge">{isMystery ? 'Mystery' : isPko ? 'PKO' : 'Knockout'}</span>
          </div>

          {bounty.total <= 0 && !ledger.loaded ? (
            <div className="tl-empty" role="status" aria-live="polite">
              Loading The Bounty Pool
            </div>
          ) : bounty.total <= 0 && ledger.failed ? (
            /* A FAILED READ IS NOT AN EMPTY POOL. Without this branch the tab
               told the player their bounty pool was unfunded whenever the query
               was refused. Say what is actually known. */
            <div className="tl-empty" role="alert">
              The Bounty Pool Could Not Be Read
              <span className="tl-empty__hint">
                This Is A Display Problem, Not A Missing Pool. Try Again Shortly.
              </span>
            </div>
          ) : bounty.total <= 0 ? (
            <div className="tl-empty">
              The Bounty Pool Is Not Funded Yet
              <span className="tl-empty__hint">
                Heads Are Set When Players Register. The Pool Fills As The Field Does.
              </span>
            </div>
          ) : (
            <>
              <div className="tl-stat-grid rw-bounty__stats">
                <div className="tl-stat">
                  <span className="tl-stat__label">Total Pool</span>
                  <span className="tl-stat__value">{chips(bounty.total)}</span>
                </div>
                <div className="tl-stat">
                  <span className="tl-stat__label">Claimed</span>
                  <span className="tl-stat__value">{chips(bounty.claimed)}</span>
                  <span className="tl-stat__sub">
                    {chips(bounty.knockoutsPaid)}{' '}
                    {bounty.knockoutsPaid === 1 ? 'Knockout' : 'Knockouts'}
                  </span>
                </div>
                <div className="tl-stat">
                  <span className="tl-stat__label">Still Available</span>
                  <span className="tl-stat__value tl-stat__value--accent">
                    {chips(bounty.available)}
                  </span>
                </div>
                {bounty.perKnockout > 0 && !isMystery && (
                  <div className="tl-stat">
                    <span className="tl-stat__label">Per Knockout</span>
                    <span className="tl-stat__value">{chips(bounty.perKnockout)}</span>
                  </div>
                )}
              </div>

              {/* The meter DRAINS: it shows what is left, not what has gone. */}
              <div className="rw-drain">
                <div className="rw-drain__row">
                  <span className="rw-drain__label">
                    {isMystery ? 'Still Available In The Mystery Pool' : 'Still In The Pool'}
                  </span>
                  <span className="rw-drain__figure">
                    {chips(bounty.available)} Of {chips(bounty.total)}
                  </span>
                </div>
                <div className="tl-meter" aria-hidden="true">
                  <div className="tl-meter__fill" style={{ width: `${bounty.remainingPct}%` }} />
                </div>
              </div>

              {isPko && (
                <p className="rw-rule">
                  Progressive Knockout. Half Of Every Head You Win Is Paid To You In Cash. The Other
                  Half Is Added To Your Own Head, So Every Knockout Makes You Worth More.
                </p>
              )}

              {!isPko && !isMystery && bounty.perKnockout > 0 && (
                <p className="rw-rule">
                  Every Player Carries A Head Worth {chips(bounty.perKnockout)}. Knock Them Out And
                  It Is Paid To You Immediately.
                </p>
              )}

              {isMystery && (
                <p className="rw-rule">
                  Every Chest Is Sealed Until It Is Pulled. The Full Ladder, And Who Has Pulled
                  What, Is Below.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {/* ── THE MYSTERY LADDER ────────────────────────────────────────────
          Dan 2026-08-25 asked Rewards for "the total bounty pool and whats
          left or 'still available' in the mystery bounty pool". The pool
          figures are the section above; the ladder is this panel.

          It is `MysteryBountyPanel`, fed by the page's single
          `useMysteryBounty` fetch (`mysteryBounty` in the tab contract), so
          the top chest the Detail tab advertises and the ladder here read the
          same three RPC calls and cannot disagree. It renders null for any
          event that is not a mystery bounty. */}
      {isMystery && mysteryBounty && tournamentId && (
        <MysteryBountyPanel
          tournamentId={tournamentId}
          isMysteryBounty
          data={mysteryBounty}
          currentUserId={currentUserId ?? null}
          isCompleted={String(t.status || '').toUpperCase() === 'COMPLETED'}
        />
      )}
    </div>
  );
}
