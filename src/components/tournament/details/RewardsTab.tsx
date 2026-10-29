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
 * Dan asked Rewards for. The ladder itself is on the Bounties tab beside this
 * one (Dan 2026-10-25: "CREATE ANOTHER TAB, FOR 'BOUNTIES' ... INSTEAD OF
 * PLACING IT AT THE BOTTOM OF REWARDS"), see BountiesTab. One fetch feeds
 * both, because the page passes the hook result in through `mysteryBounty` on
 * the tab contract.
 *
 * ── THE TOTAL PRIZE POOL IS EVERYTHING THE FIELD PUT IN ────────────────────
 *
 * Dan 2026-10-24, verbatim: "REWARDS PAGE SHOULD HAVE THE TOTAL PRIZE POOL
 * INSIDE OF IT. THE TOTAL OF ALL THE BUY IN'S REBUYS AND ADD ON'S."
 *
 * The headline used to print `prize_pool` alone. On a bounty event that is only
 * the PLACE half: fn_ca_process_tournament_chip_purchase_money_v1 splits every
 * purchase, net of the fee, into `prize_pool` (places) and `bounty_pool`
 * (heads). Friday Fight Night PKO (827A1B52) read 10,050 while the field had
 * put 14,325 in: 276 buy-ins and 9 rebuys at 27, plus 221 add-ons at 30 (an
 * add-on carries no fee). 10,050 + 4,275 = 14,325 exactly.
 *
 * So the headline is now places + bounties, and a "Where It Comes From" strip
 * underneath shows the buy-ins, rebuys and add-ons that make it up and the split
 * between place prizes and the bounty pool. The per-line amounts are priced off
 * the event's own costs by the server's rule and are printed ONLY when they
 * reconcile with the server's pool to the chip; an event with free entries
 * (satellite seats, free buys) shows the counts without inventing amounts.
 *
 * ── ONE QUERY, AND ONLY WHEN IT IS NEEDED ──────────────────────────────────
 *
 * types.ts asks tabs to prefer props. The props carry the tournament row, so
 * the entire payout side of this tab is computed with no query at all. The two
 * bounty queries fire ONLY for a bounty event, are cancelled on unmount, and
 * tolerate an empty result: a bounty panel that never resolves is worse than
 * one that says the pool has not been funded yet.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import { subscribeTournamentStandings } from '../../../services/tournamentStandingsUpdates';
import type { TournamentTabProps, PayoutPlace, TournamentEntry } from './types';
import { isRecordedSatelliteQualifier } from '../../../utils/satelliteQualification';
import {
  chips,
  effectivePlaceLadderPool,
  effectivePrizePool,
  isPlayerLive,
  isPlayerOut,
  lastPaidPlace,
  ordinal,
  placePrize,
  resolvePayoutStructure,
  tournamentRowUnitCents,
} from './types';
import { formatPrizeAtUnit, moneySuffixAtUnit } from '../../../utils/format';
import {
  CHIP_UNIT_CENTS,
  normalizeUnitCents,
} from '../../../../server/src/tournament/tournamentUnit';
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
  tournamentId?: string;
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
async function fetchAllRows<T extends { id: string }>(
  page: (cursor: string | null) => PromiseLike<{ data: unknown; error: unknown }>,
  isCurrent: () => boolean
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (!isCurrent()) throw new Error('Bounty ledger read retired');
    const { data, error } = await page(cursor);
    if (!isCurrent()) throw new Error('Bounty ledger read retired');
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Bounty ledger response is not an array');
    const rows = data as T[];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id || (cursor !== null && row.id <= cursor))
        throw new Error('Bounty ledger cursor did not advance');
      cursor = row.id;
    }
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error('Bounty ledger exceeded the complete-read limit');
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
  payout_depth_percent?: number | string | null;
  payout_percent?: number | string | null;
  spin_multiplier?: number | null;
  is_bounty?: boolean | null;
  is_pko?: boolean | null;
  is_mystery_bounty?: boolean | null;
  mystery_bounty_regular_pool_percent?: number | string | null;
  bounty_amount?: number | null;
  bounty_pool?: number | null;
  bounty_pool_paid?: number | null;
  status?: string | null;
  current_players?: number | null;
  bubble_protection?: boolean | null;
  buy_in_amount?: number | null;
  buy_in_fee?: number | null;
  rebuy_cost?: number | null;
  addon_cost?: number | null;
  variant?: string | null;
  tournament_type?: string | null;
  satellite_target_id?: string | null;
  satellite_target?: string | null;
  satellite_seats?: number | null;
}

/* Still holding chips, by the lobby's ONE definition of "in". This tab used to
   define it as `registered | playing`, which excludes a winner, while Ranking
   counted anyone not out - so the money bubble here could be measured against a
   different field size than the "To The Money" line Ranking prints
   (2026-08-26 audit). */
const isStillIn = isPlayerLive;

export default function RewardsTab({ tournament, entries, currentUserId }: TournamentTabProps) {
  const t = (tournament || {}) as unknown as RewardColumns;
  const tournamentId = tournament?.id;

  const isPko = !!t.is_pko;
  const isMystery = !!t.is_mystery_bounty;
  const isBountyEvent = !!t.is_bounty || isPko || isMystery;

  /**
   * THE GRID THIS EVENT PAYS ON (2026-09-20). Read once, from the tournament's
   * own arena embed, by the same rule the place ladder below already uses.
   *
   * `unitMoney` is `chips` at a chip event - the same function, so every chip
   * figure on this tab is byte-identical by construction rather than by
   * inspection - and whole Diamonds at a Diamond event. `unitWord` is the noun
   * beside it: a Diamond bounty pool that reads "Chips" is the same defect as
   * one that reads in cents, one level up.
   */
  const unitCents = useMemo(() => tournamentRowUnitCents(tournament), [tournament]);
  const unitSuffix = moneySuffixAtUnit(unitCents);
  const unitMoney = useCallback(
    (n: number | null | undefined) =>
      normalizeUnitCents(unitCents) === CHIP_UNIT_CENTS
        ? chips(n)
        : formatPrizeAtUnit(n, unitCents),
    [unitCents]
  );

  const [ownedLedger, setLedger] = useState<BountyLedger>(EMPTY_LEDGER);
  const ledger = ownedLedger.tournamentId === tournamentId ? ownedLedger : EMPTY_LEDGER;

  /* Committed standings/lifecycle events invalidate the ledger even when the
     number of eliminated players stays unchanged (rebuy, bounty settlement,
     or reconnect). One in-flight read plus one trailing invalidation prevents
     concurrent responses from overwriting newer data. */
  useEffect(() => {
    if (!tournamentId || !isBountyEvent) {
      setLedger(EMPTY_LEDGER);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let requested = false;
    const load = async () => {
      if (cancelled) return;
      if (inFlight) {
        requested = true;
        return;
      }
      inFlight = true;
      try {
        const [live, claimed] = await Promise.all([
          fetchAllRows<{ id: string; current_bounty: unknown; status: string | null }>(
            (cursor) => {
              let query = supabase
                .from('tournament_players')
                .select('id, current_bounty, status')
                .eq('tournament_id', tournamentId)
                .gt('current_bounty', 0)
                .order('id', { ascending: true })
                .limit(PAGE);
              if (cursor !== null) query = query.gt('id', cursor);
              return query;
            },
            () => !cancelled
          ),
          fetchAllRows<{ id: string; bounty_amount: unknown }>(
            (cursor) => {
              let query = supabase
                .from('tournament_bounties')
                .select('id, bounty_amount')
                .eq('tournament_id', tournamentId)
                .order('id', { ascending: true })
                .limit(PAGE);
              if (cursor !== null) query = query.gt('id', cursor);
              return query;
            },
            () => !cancelled
          ),
        ]);
        if (cancelled) return;

        setLedger({
          tournamentId,
          /* A head belongs to a player still in (2026-10-26 audit). Before the
             money a mystery bust pays nothing and leaves its head on the row,
             so counting every row put 162 knocked-out players' heads back
             into "Still Available". */
          liveHeads: live
            .filter((r) => isStillIn({ status: r.status ?? '' } as Parameters<typeof isStillIn>[0]))
            .map((r) => cents(num(r.current_bounty))),
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
             fact, with no trace in error reporting. fetchAllRows throws on `error`, so
             this branch now actually runs, and `failed` keeps the panel from
             making that claim. */
          /* A refresh that fails keeps the last ledger that was read: a
             network wobble during a knockout must not swap real figures for
             "Could Not Be Read". Only a first read that fails says so. */
          setLedger((prev) =>
            prev.tournamentId === tournamentId && prev.loaded && !prev.failed
              ? prev
              : { tournamentId, liveHeads: [], claimedHeads: [], loaded: true, failed: true }
          );
          reportError(e, 'RewardsTab.bounty_ledger_load_failed');
        }
      } finally {
        inFlight = false;
        if (!cancelled && requested) {
          requested = false;
          void load();
        }
      }
    };
    const unsubscribe = subscribeTournamentStandings(tournamentId, () => void load());
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tournamentId, isBountyEvent]);

  /* ── FIELD STATE ──────────────────────────────────────────────────────── */

  const isRunning = String(t.status || '').toUpperCase() === 'RUNNING';
  const isComplete = String(t.status || '').toUpperCase() === 'COMPLETED';
  const isCancelled = String(t.status || '').toUpperCase() === 'CANCELLED';

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
  /**
   * WHO FINISHED IN EACH PAID PLACE (Dan 2026-10-24: "WHAT PLAYERS WON WHAT
   * PRIZES UNDER REWARDS").
   *
   * The ladder used to print place, percentage and amount and never the
   * player, even after the event ended: Friday Fight Night PKO (827A1B52)
   * finished with all 276 positions and 35 prizes recorded on
   * tournament_players, and Rewards still read "1st 17.32% 1,741" with no
   * name. A finishing position is written to the player's row when they bust,
   * and the champion's when the event ends, so the names fill in down the
   * ladder as the field plays into the money. A live player has no position
   * and claims no row.
   */
  const finisherByPlace = useMemo(() => {
    const byPlace = new Map<number, TournamentEntry>();
    for (const e of entries) {
      const place = Math.floor(num(e.position));
      if (place > 0 && (isPlayerOut(e) || e.status === 'winner')) byPlace.set(place, e);
    }
    return byPlace;
  }, [entries]);

  // A bounty can be earned while still playing or outside the place ladder.
  // The settled counter also includes PKO champion/residual awards, which a
  // knockout-only ledger would omit. Never count current_bounty as received.
  const bountyOnlyRecipients = useMemo(
    () =>
      entries
        .filter(
          (e) =>
            num(e.bounty_winnings) > 0 &&
            !parsedPlaces?.some((p) => finisherByPlace.get(p.place)?.id === e.id)
        )
        .sort(
          (a, b) =>
            (a.position || Infinity) - (b.position || Infinity) ||
            a.username.localeCompare(b.username)
        ),
    [entries, parsedPlaces, finisherByPlace]
  );

  /* A band of places sharing one percentage reads as "4-6" until somebody in
     it finishes; then it opens into its single places so every name sits on
     its own prize. */
  const bands = useMemo(() => {
    if (!parsedPlaces) return [];
    return toBands(parsedPlaces).flatMap((band) => {
      if (band.fromPlace === band.toPlace) return [band];
      let decided = false;
      for (let place = band.fromPlace; place <= band.toPlace; place++) {
        if (finisherByPlace.has(place)) decided = true;
      }
      if (!decided) return [band];
      return Array.from({ length: band.toPlace - band.fromPlace + 1 }, (_, k) => ({
        fromPlace: band.fromPlace + k,
        toPlace: band.fromPlace + k,
        percentage: band.percentage,
      }));
    });
  }, [parsedPlaces, finisherByPlace]);
  const paidPlaces = parsedPlaces ? parsedPlaces.length : 0;
  /* The MTT's paid depth, as the database applies it
     (fn_ca_effective_payout_depth: the stored depth, else the legacy percent). */
  const paidDepth = useMemo(() => {
    const isMtt =
      String(t.tournament_type ?? '').toUpperCase() === 'MTT' &&
      !['spin', 'sng', 'satellite'].includes(String(t.variant ?? '').toLowerCase());
    if (!isMtt) return null;
    const depth = Number(t.payout_depth_percent);
    const legacy = Number(t.payout_percent);
    const value = depth > 0 && depth <= 100 ? depth : legacy > 0 && legacy <= 100 ? legacy : NaN;
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }, [t.payout_depth_percent, t.payout_percent, t.tournament_type, t.variant]);

  const isSatellite =
    String(t.variant ?? '').toLowerCase() === 'satellite' ||
    String(t.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
    Boolean(t.satellite_target_id || t.satellite_target);

  /**
   * A SATELLITE PAYS SEATS, NOT THE PERCENTAGE LADDER (2026-10-04).
   *
   * `fn_ca_settle_satellite_cohort` never reads `payout_structure`. It awards
   * floor(prize_pool / (target buy-in + target fee)) seats, each worth one
   * target entry, and pays the remainder to the next finisher. This tab priced
   * the stored ladder anyway, so FE93D011 read "1st 63.52% 515, 2nd 36.48%
   * 295" when eight players had been awarded 100 each and a ninth 10.
   *
   * The target's price is not on this row and is not in the props, so the seat
   * count is NOT computed here: a finished satellite prints what was recorded
   * per player, and any other satellite says that it pays seats and stops. The
   * one figure quoted before the finish is `satellite_seats`, the advertised
   * count the settlement refuses to fall short of.
   */
  const satelliteAwards = useMemo(() => {
    if (!isSatellite || !isComplete) return null;
    const paid = entries.filter((e) => Number(e.prize) > 0);
    if (paid.length === 0) return null;
    const seatWinners = paid
      .filter((e) => isRecordedSatelliteQualifier(tournament, e))
      .sort((a, b) => a.username.localeCompare(b.username));
    const seatIds = new Set(seatWinners.map((e) => e.id));
    const finishers = paid
      .filter((e) => !seatIds.has(e.id))
      .sort((a, b) => (a.position || 99999) - (b.position || 99999));
    return { seatWinners, finishers, paidCount: paid.length };
  }, [isSatellite, isComplete, entries, tournament]);
  const advertisedSeats = isSatellite ? Math.floor(num(t.satellite_seats)) : 0;

  /**
   * PROVISIONAL means the figures can still move. Two independent reasons, and
   * both matter: an unfinalised pool moves with every late registration and
   * rebuy, and a missing structure means nobody has decided how many places
   * get paid. Neither is presented as settled fact. A satellite has no place
   * ladder to be missing, so only the moving pool applies to it.
   */
  const provisionalReason =
    !parsedPlaces && !isSatellite
      ? 'No Payout Structure Has Been Published For This Event Yet'
      : !isFinalised && !isComplete && !isCancelled
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
  /* No stone bubble on a satellite: its ladder is not what gets paid. */
  const stoneBubblePlace = !isSatellite && finalPaidPlace > 0 ? finalPaidPlace + 1 : 0;
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

  /* ── THE TOTAL PRIZE POOL: EVERY BUY-IN, REBUY AND ADD-ON ─────────────── */

  /* The bounty half of what the field paid in. Zero on a non-bounty event. */
  const bountyShare = bounty ? Math.max(0, bounty.total) : 0;
  /* Places (with any guarantee overlay the club funds) plus the bounty pool. */
  const totalPrizePool = effectivePool + bountyShare;

  const composition = useMemo(() => {
    let rebuyCount = 0;
    let addOnCount = 0;
    for (const e of entries) {
      rebuyCount += Math.max(0, Math.floor(num(e.rebuys)));
      if (num(e.add_ons) > 0) addOnCount += 1;
    }
    const buyInCount = entries.length;

    /* The server's own pricing rule
       (fn_ca_process_tournament_chip_purchase_money_v1): a rebuy costs
       `rebuy_cost` (or the buy-in when unset) and sheds the same fee RATIO as
       the buy-in; an add-on costs `addon_cost` (or the buy-in) and sheds no
       fee at all. What is left of each purchase is what reaches the pool. */
    const buyIn = num(t.buy_in_amount);
    const fee = num(t.buy_in_fee);
    const feeRatio = buyIn + fee > 0 ? fee / (buyIn + fee) : 0;
    const rebuyGross = num(t.rebuy_cost) > 0 ? num(t.rebuy_cost) : buyIn + fee;
    const perRebuy = cents(rebuyGross * (1 - feeRatio));
    const perAddOn = cents(num(t.addon_cost) > 0 ? num(t.addon_cost) : buyIn);

    const buyInTotal = cents(buyInCount * buyIn);
    const rebuyTotal = cents(rebuyCount * perRebuy);
    const addOnTotal = cents(addOnCount * perAddOn);
    const collected = num(t.prize_pool) + bountyShare;
    /* A cent of rounding per purchase is the most the server's fee rounding can
       move it; anything wider means entries this rule did not price (free
       seats, satellite winners) and the amounts are withheld, not guessed. */
    const purchases = buyInCount + rebuyCount + addOnCount;
    const tolerance = Math.max(1, purchases * 0.01);
    const reconciles =
      purchases > 0 && Math.abs(buyInTotal + rebuyTotal + addOnTotal - collected) <= tolerance;

    return {
      buyInCount,
      rebuyCount,
      addOnCount,
      buyIn,
      perRebuy,
      perAddOn,
      buyInTotal,
      rebuyTotal,
      addOnTotal,
      reconciles,
    };
  }, [
    entries,
    t.buy_in_amount,
    t.buy_in_fee,
    t.rebuy_cost,
    t.addon_cost,
    t.prize_pool,
    bountyShare,
  ]);

  const showRebuyLine = composition.rebuyCount > 0;
  const showAddOnLine = composition.addOnCount > 0;
  const showComposition =
    totalPrizePool > 0 && (composition.buyInCount > 0 || showRebuyLine || showAddOnLine);

  /* ═════════════════════════════════════════════════════════════════════════
     RENDER
     ═════════════════════════════════════════════════════════════════════════ */

  return (
    <div className="rw">
      {/* ── HEADLINE: the pool, the guarantee, the bubble ─────────────────── */}
      <section className="tl-panel rw-head">
        <div className="tl-section-head">
          <h3>Prizes</h3>
          {isSatellite ? (
            satelliteAwards ? (
              <span className="tl-section-note">
                {chips(satelliteAwards.paidCount)}{' '}
                {satelliteAwards.paidCount === 1 ? 'Player' : 'Players'} Awarded
              </span>
            ) : (
              <span className="tl-section-note">Seats Into The Target Event</span>
            )
          ) : (
            paidPlaces > 0 && (
              <span className="tl-section-note">
                {chips(paidPlaces)} Paid {paidPlaces === 1 ? 'Place' : 'Places'}
              </span>
            )
          )}
        </div>

        <div className="tl-stat-grid">
          <div className="tl-stat tl-stat--feature rw-pool">
            <span className="tl-stat__label">Total Prize Pool</span>
            <span className="tl-stat__value tl-stat__value--accent rw-pool__value">
              {totalPrizePool > 0 ? chips(totalPrizePool) : 'Set By Entries'}
            </span>
            <span className="tl-stat__sub">
              {/* A cancelled event's pool is not "Still Growing". */}
              {isCancelled
                ? 'Event Cancelled'
                : isFinalised || isComplete
                  ? 'Final'
                  : 'Still Growing'}
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

          {satelliteAwards && satelliteAwards.seatWinners.length > 0 && (
            <div className="tl-stat">
              <span className="tl-stat__label">Seat Winners</span>
              <span className="tl-stat__value">{chips(satelliteAwards.seatWinners.length)}</span>
              <span className="tl-stat__sub">Qualified For The Target Event</span>
            </div>
          )}

          {isSatellite && !satelliteAwards && advertisedSeats > 0 && (
            <div className="tl-stat">
              <span className="tl-stat__label">Seats Advertised</span>
              <span className="tl-stat__value">{chips(advertisedSeats)}</span>
              <span className="tl-stat__sub">Into The Target Event</span>
            </div>
          )}

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

        {showComposition && (
          <div className="rw-mix" aria-label="Where The Prize Pool Comes From">
            <div className="rw-mix__head">Where It Comes From</div>
            <ul className="rw-mix__list">
              <li className="rw-mix__row">
                <span className="rw-mix__label">
                  {chips(composition.buyInCount)}{' '}
                  {composition.buyInCount === 1 ? 'Buy-In' : 'Buy-Ins'}
                  {composition.reconciles && composition.buyIn > 0 && (
                    <span className="rw-mix__each"> × {chips(composition.buyIn)}</span>
                  )}
                </span>
                <span className="rw-mix__figure">
                  {composition.reconciles ? chips(composition.buyInTotal) : '-'}
                </span>
              </li>
              {showRebuyLine && (
                <li className="rw-mix__row">
                  <span className="rw-mix__label">
                    {chips(composition.rebuyCount)}{' '}
                    {composition.rebuyCount === 1 ? 'Rebuy' : 'Rebuys'}
                    {composition.reconciles && composition.perRebuy > 0 && (
                      <span className="rw-mix__each"> × {chips(composition.perRebuy)}</span>
                    )}
                  </span>
                  <span className="rw-mix__figure">
                    {composition.reconciles ? chips(composition.rebuyTotal) : '-'}
                  </span>
                </li>
              )}
              {showAddOnLine && (
                <li className="rw-mix__row">
                  <span className="rw-mix__label">
                    {chips(composition.addOnCount)}{' '}
                    {composition.addOnCount === 1 ? 'Add-On' : 'Add-Ons'}
                    {composition.reconciles && composition.perAddOn > 0 && (
                      <span className="rw-mix__each"> × {chips(composition.perAddOn)}</span>
                    )}
                  </span>
                  <span className="rw-mix__figure">
                    {composition.reconciles ? chips(composition.addOnTotal) : '-'}
                  </span>
                </li>
              )}
              {overlay > 0 && (
                <li className="rw-mix__row">
                  <span className="rw-mix__label">Club Overlay</span>
                  <span className="rw-mix__figure">{chips(overlay)}</span>
                </li>
              )}
            </ul>
            {bountyShare > 0 && (
              <div className="rw-mix__split">
                <span className="rw-mix__part">
                  <span className="rw-mix__part-label">Place Prizes</span>
                  <span className="rw-mix__part-value">{chips(effectivePool)}</span>
                </span>
                <span className="rw-mix__part">
                  <span className="rw-mix__part-label">Bounty Pool</span>
                  <span className="rw-mix__part-value">{chips(bountyShare)}</span>
                </span>
              </div>
            )}
          </div>
        )}

        {provisionalReason && <p className="rw-provisional">{provisionalReason}</p>}
      </section>

      {/* Place prizes and every recorded bounty award. */}
      <section className="tl-panel rw-payouts">
        <div className="tl-section-head">
          <h3>{isSatellite ? 'Seat Awards' : 'Payouts'}</h3>
          {/* ONLY ONCE THE FIELD IS AT LEAST AS BIG AS THE LADDER (2026-10-04
              review pass). The share is paid places over entries, and while an
              event is still filling the ladder is longer than the field: nine
              paid places against two early entries printed "450% Of The Field
              Paid", and against none, "900%". No field can be more than
              entirely paid; until it outgrows the ladder the line says nothing. */}
          {/* THE PAID DEPTH IS A RULE, NOT A RATIO (Dan 2026-10-21): "it should
              100% always display it as 12.5% payout". An MTT pays its stored
              depth of the field; places over entries rounds up a place and
              drifts with every registration, so the line states the depth. */}
          {!isSatellite && effectivePool > 0 && paidPlaces > 0 && paidDepth !== null && (
            <span className="tl-section-note">{paidDepth}% Of The Field Paid</span>
          )}
          {!isSatellite &&
            effectivePool > 0 &&
            paidPlaces > 0 &&
            paidDepth === null &&
            entryCount >= paidPlaces && (
              <span className="tl-section-note">
                {Math.round((paidPlaces / Math.max(1, entryCount)) * 1000) / 10}% Of The Field Paid
              </span>
            )}
        </div>

        {isSatellite ? (
          satelliteAwards ? (
            <ul className="tl-list rw-list">
              {[...satelliteAwards.seatWinners, ...satelliteAwards.finishers].map((e, i) => {
                const wonSeat = i < satelliteAwards.seatWinners.length;
                const isHeroRow = !!currentUserId && e.user_id === currentUserId;
                return (
                  <li
                    key={e.id}
                    className={['tl-row', 'rw-row', isHeroRow ? 'tl-row--hero' : '']
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className="tl-rank rw-rank">
                      {wonSeat ? 'Seat' : ordinal(e.position)}
                    </span>
                    <span className="rw-row__mid">
                      <span className="tl-name">{e.username}</span>
                      {wonSeat && <span className="tl-badge rw-tag">Seat Winner</span>}
                      {isHeroRow && (
                        <span className="tl-badge tl-badge--action rw-tag">Your Finish</span>
                      )}
                    </span>
                    <span className="tl-num tl-num--accent rw-prize">{unitMoney(e.prize)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="tl-empty">
              This Satellite Awards Seats Into The Target Event
              <span className="tl-empty__hint">
                {isComplete
                  ? 'No Award Was Recorded Per Player For This Event.'
                  : advertisedSeats > 0
                    ? `${chips(advertisedSeats)} ${
                        advertisedSeats === 1 ? 'Seat Is' : 'Seats Are'
                      } Advertised. The Final Number Is Set By The Prize Pool When The Event Ends.`
                    : 'The Number Of Seats Is Set By The Prize Pool When The Event Ends.'}
              </span>
            </div>
          )
        ) : bands.length === 0 ? (
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
                  ? placePrize(placeLadderPool, parsedPlaces, band.fromPlace, unitCents)
                  : 0;
              /* The player who took this place, and what they were actually
                 paid. The recorded prize wins over the projection: a final
                 table deal or the residual on the last paid place makes them
                 differ, and the player's wallet holds the recorded one. */
              const finisher =
                band.fromPlace === band.toPlace ? finisherByPlace.get(band.fromPlace) : undefined;
              const recordedPrize = finisher ? num(finisher.prize) : 0;

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
                    {finisher ? (
                      <span className="rw-who">
                        <span className="tl-name rw-who__name">{finisher.username}</span>
                        <span className="rw-pct">{pct(band.percentage)}</span>
                      </span>
                    ) : (
                      <span className="rw-pct">{pct(band.percentage)}</span>
                    )}
                    {isHeroRow && (
                      <span className="tl-badge tl-badge--action rw-tag">
                        {heroFinish ? 'Your Finish' : 'You If You Bust Now'}
                      </span>
                    )}
                    {isLastPaidRow && !isHeroRow && (
                      <span className="tl-badge tl-badge--mute rw-tag">Last Paid Place</span>
                    )}
                  </span>

                  {finisher && isBountyEvent ? (
                    <span className="rw-award" aria-label="Winnings Breakdown">
                      <span className="rw-pct">Place Prize {unitMoney(recordedPrize)}</span>
                      <span className="rw-pct">
                        Bounties {unitMoney(num(finisher.bounty_winnings))}
                      </span>
                      <span className="tl-num tl-num--accent rw-prize">
                        Total {unitMoney(cents(recordedPrize + num(finisher.bounty_winnings)))}
                      </span>
                    </span>
                  ) : (
                    <span className="tl-num tl-num--accent rw-prize">
                      {recordedPrize > 0
                        ? unitMoney(recordedPrize)
                        : prize > 0
                          ? chips(prize)
                          : '-'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {isBountyEvent && bountyOnlyRecipients.length > 0 && (
          <>
            <p className="rw-rule">Bounty Winnings Outside The Place Payouts</p>
            <ul className="tl-list rw-list">
              {bountyOnlyRecipients.map((e) => (
                <li
                  key={e.id}
                  className={`tl-row rw-row ${e.user_id === currentUserId ? 'tl-row--hero' : ''}`}
                >
                  <span className="tl-rank rw-rank">
                    {e.position ? ordinal(e.position) : 'In Play'}
                  </span>
                  <span className="rw-row__mid">
                    <span className="tl-name rw-who__name">{e.username}</span>
                  </span>
                  <span className="rw-award" aria-label="Winnings Breakdown">
                    <span className="rw-pct">Bounties {unitMoney(e.bounty_winnings)}</span>
                    <span className="tl-num tl-num--accent rw-prize">
                      Total {unitMoney(e.bounty_winnings)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
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
                  <span className="tl-stat__value">{unitMoney(bounty.total)}</span>
                </div>
                <div className="tl-stat">
                  <span className="tl-stat__label">Claimed</span>
                  <span className="tl-stat__value">{unitMoney(bounty.claimed)}</span>
                  <span className="tl-stat__sub">
                    {chips(bounty.knockoutsPaid)}{' '}
                    {bounty.knockoutsPaid === 1 ? 'Knockout' : 'Knockouts'}
                  </span>
                </div>
                <div className="tl-stat">
                  <span className="tl-stat__label">Still Available</span>
                  <span className="tl-stat__value tl-stat__value--accent">
                    {unitMoney(bounty.available)}
                  </span>
                </div>
                {bounty.perKnockout > 0 && !isMystery && (
                  <div className="tl-stat">
                    <span className="tl-stat__label">Per Knockout</span>
                    <span className="tl-stat__value">{unitMoney(bounty.perKnockout)}</span>
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
                    {unitMoney(bounty.available)} Of {unitMoney(bounty.total)}
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
                  Every Player Carries A Head Worth {unitMoney(bounty.perKnockout)}
                  {unitSuffix}. Knock Them Out And It Is Paid To You Immediately.
                </p>
              )}

              {isMystery && (
                <p className="rw-rule">
                  {/* Chests only (Dan 2026-10-22): an unknown split reads as
                      the older terms, never as chests only. */}
                  {t.mystery_bounty_regular_pool_percent != null &&
                  Number(t.mystery_bounty_regular_pool_percent) === 0
                    ? 'No Bounties Are Paid Before The Money. Once The Tournament Reaches The Money, Every Knockout Picks 1 Of 3 Sealed Chests. '
                    : ''}
                  Every Chest Is Sealed Until It Is Pulled. The Full Ladder, And Who Has Pulled
                  What, Is On The Bounties Tab.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {/* THE MYSTERY LADDER moved to its own Bounties tab (Dan 2026-10-25):
          see BountiesTab. Rewards keeps the pool totals above. */}
    </div>
  );
}
