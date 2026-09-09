/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOURNAMENT BRAIN CONTEXT — Real ICM Inputs for the Horses (V12 — 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 * V11 gave the horse brain an explicit cash/tournament switch; the ICM layer
 * was still a flat premium because the brain could not see the tournament.
 * This service feeds it the real thing: players left, spots paid, bubble
 * distance, average stack, format (MTT / spin / HU SNG), and the PKO bounty
 * share — everything icmRiskV2 needs to price survival correctly.
 *
 * Access pattern is SYNCHRONOUS from the decision path (horse decisions are
 * sync and budgeted in ms): `get()` returns the cached context immediately
 * (or null before the first fetch lands) and kicks a background refresh when
 * the entry is stale. A missing/failed context degrades to V11's flat
 * premium — never worse than before this service existed.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { resolvePayoutStructure, type PayoutSubject } from '../tournament/payoutStructure.js';

export type TournamentFormat = 'mtt' | 'spin' | 'hu_sng';

export interface TournamentBrainContext {
  format: TournamentFormat;
  entrants: number;
  playersLeft: number;
  spotsPaid: number;
  inMoney: boolean;
  /** stone bubble / approaching-bubble flag (playersLeft within 15% of paid) */
  nearBubble: boolean;
  /** average live stack in CHIPS (0 = unknown) */
  avgStackChips: number;
  /** PKO: share of the prize pool sitting in bounties (0 = not a bounty) */
  bountyFactor: number;
  /** V16 ICM: live stacks in chips, descending, capped at 200 entries. */
  stacks: number[];
  /** V16 ICM: payout percentages by place (1st first), capped at 9 places. */
  payoutPct: number[];
  // ═══ V26 THE PRIZE LANDSCAPE (Dan 2026-08-28) ═══════════════════════════
  // "Horses should be able to see and have access to the prizes, and which
  //  bounties are left still, if top prizes are gone, or still there - that
  //  changes play."
  //
  // It does, and it is the sharpest read in a mystery bounty. Busting someone
  // draws a CHEST from a shrinking inventory: while the big ones are still in
  // there every elimination is a lottery ticket worth far more than its
  // average, and once they are claimed the same bust pays scraps and the
  // event collapses back toward a freezeout. A horse that cannot see the
  // inventory is playing the wrong tournament for half the night.
  /** mystery bounty: chests still unclaimed ('available') */
  mysteryChestsLeft: number;
  /** mystery bounty: MEAN value of an unclaimed chest, in cents — the honest
   *  EV of one elimination right now */
  mysteryMeanCents: number;
  /** mystery bounty: the largest chest still unclaimed, in cents */
  mysteryTopCents: number;
  /** mystery bounty: is the tournament's single biggest chest STILL LIVE?
   *  The difference between a lottery and a grind. */
  mysteryTopLive: boolean;
  /** PKO/mystery: mean live bounty per remaining player, in cents (0 = none) */
  meanBountyCents: number;
  /** V23: at the final table (MTT, nine or fewer left, in or at the money) */
  finalTable: boolean;
  /** V23 BLIND CLOCK: minutes until the next level (null = unknown/last level) */
  nextBlindInMin: number | null;
  /** V23 BLIND CLOCK: next level's bb as a multiple of the current bb (1 = flat) */
  nextBlindMult: number;
  // ═══ V37 SATELLITES (Dan 2026-09-02) ══════════════════════════════════════
  // "THE PLAY DIFFERENCE BETWEEN A SATELLITE WHERE ALL WINNERS GET THE SAME
  //  PRIZE AND A MTT WITH PRIZES PROGRESSIVELY PAYING MORE."
  //
  // A satellite's stored payout_structure is the ordinary MTT curve (40/25/
  // 18/10/7) — settlement ignores it and hands out `seats` identical tickets
  // in equal immutable ticket lines. So the brain was reading every satellite as an MTT
  // with a top-heavy ladder, and an MTT ladder says "chips up top are worth
  // more": the exact opposite of a satellite, where the K-th seat is worth
  // the first and every chip past a locked seat is worth NOTHING. payoutPct
  // below is REBUILT flat for a satellite; these fields say so.
  /** V37 BOUNTIES: live bounty per player, in cents, keyed by user id.
   *  "THIS PLAYS DIFFERENT WHEN A PLAYER HAS A LARGE BOUNTY ON THEIR HEAD."
   *  The mean alone cannot say whose head is worth the pot. */
  bountyByUser: Record<string, number>;
  /** this event awards identical tickets to the top `satelliteSeats` */
  satellite: boolean;
  /** seats (tickets) awarded — the real number of equal prizes */
  satelliteSeats: number;
}

interface TournamentRowLite {
  /** V37: satellite columns (either target column may carry the link). */
  satellite_seats?: number | null;
  satellite_target_id?: string | null;
  satellite_target?: string | null;
  tournament_type: string | null;
  variant: string | null;
  max_players: number | null;
  table_size: number | null;
  payout_structure: unknown;
  prize_pool: number | null;
  bounty_pool: number | null;
  is_pko: boolean | null;
  is_bounty: boolean | null;
  /** V23 blind clock inputs (all optional — absent means clock unknown). */
  blind_structure?: unknown;
  current_level?: number | null;
  level_started_at?: string | null;
}

/** V23: one level of a blind structure, as stored (two duration spellings). */
interface BlindLevelRow {
  level?: number;
  smallBlind?: number;
  bigBlind?: number;
  ante?: number;
  duration?: number; // seconds in one historical shape
  durationMinutes?: number; // minutes in the other
}

/** V23 pure: minutes until the next level and its bb multiple. Exported for
 *  tests. Returns nulls/1 whenever any input is missing or malformed —
 *  the blind clock degrades to "unknown", never to a guess. */
export function deriveBlindClock(
  structure: unknown,
  currentLevel: number | null | undefined,
  levelStartedAt: string | null | undefined,
  nowMs: number
): { nextBlindInMin: number | null; nextBlindMult: number } {
  const none = { nextBlindInMin: null, nextBlindMult: 1 };
  try {
    if (!Array.isArray(structure) || structure.length === 0) return none;
    const lvl = typeof currentLevel === 'number' && currentLevel >= 1 ? currentLevel : null;
    if (lvl == null || !levelStartedAt) return none;
    const levels = structure as BlindLevelRow[];
    const cur = levels.find((l) => l?.level === lvl);
    const next = levels.find((l) => l?.level === lvl + 1);
    if (!cur || !next) return none; // last level: the clock stops mattering
    const curBB = Number(cur.bigBlind) || 0;
    const nextBB = Number(next.bigBlind) || 0;
    // duration: `durationMinutes` is minutes; `duration` >= 45 is seconds
    // (no real level is shorter), below that it is minutes.
    const rawDur = cur.durationMinutes ?? cur.duration ?? 0;
    const durMin =
      cur.durationMinutes != null
        ? Number(rawDur)
        : Number(rawDur) >= 45
          ? Number(rawDur) / 60
          : Number(rawDur);
    if (!(durMin > 0)) return none;
    const startedMs = Date.parse(levelStartedAt);
    if (!isFinite(startedMs)) return none;
    const elapsedMin = (nowMs - startedMs) / 60_000;
    // STALE-CLOCK GUARD (2026-08-28 polish sweep): if the level has been
    // "about to end" for three whole level-lengths, the writer stopped
    // advancing current_level (a paused event, or a stalled manager). A
    // clock that reads zero forever would keep the M-zones on a permanently
    // shrunken M — unknown is the honest answer.
    if (elapsedMin > durMin * 3) return none;
    const left = Math.max(0, durMin - elapsedMin);
    return {
      nextBlindInMin: Math.round(left * 10) / 10,
      nextBlindMult: curBB > 0 && nextBB > 0 ? nextBB / curBB : 1,
    };
  } catch {
    return none;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOW MANY PLAYERS ARE ACTUALLY AT THE TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This used to read `row.table_size ?? row.max_players ?? 9`, and that one
 * expression made every Heads-Up duel on the platform play MTT strategy.
 *
 * `tournaments.table_size` is `NOT NULL DEFAULT 9`, and no creation path wrote
 * it (fixed for the two that matter on 2026-08-27). `??` falls through on NULL
 * only — never on a DEFAULTED 9 — so the second operand was UNREACHABLE and
 * `max_players = 2` could not be seen. 10,315 heads-up rows sit at
 * `table_size = 9`, every one of them resolving to 'mtt', so HorseLogic applied
 * ICM pressure and bubble ranges to a two-handed game where one spot pays and
 * there is no bubble to be on.
 *
 * The fix is not to swap the operand order — that would have the same shape of
 * failure the other way round the moment a real MTT arrives with a bad
 * max_players. It is to stop treating either column as authoritative and take
 * the SMALLEST seat count the row actually asserts:
 *
 *   - a duel is a duel if EITHER column says two, so a legacy row whose
 *     table_size was defaulted to 9 is still read correctly from max_players.
 *     That is what makes this robust rather than merely correct going forward —
 *     the 10,315 existing rows are read right without a data migration;
 *   - a 100-player MTT with table_size 9 still yields 9, and 9 is not <= 2;
 *   - non-positive, NaN and NULL values are DISCARDED rather than winning, so a
 *     zero or a junk value cannot pull a full field down to a duel.
 *
 * Only when the row asserts nothing usable does it fall back to 9.
 */
export function seatsAtOneTable(row: {
  table_size?: number | null;
  max_players?: number | null;
}): number {
  const asserted = [row?.table_size, row?.max_players]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  return asserted.length > 0 ? Math.min(...asserted) : 9;
}

/** V26: one chest row as the inventory query returns it. */
export interface ChestRow {
  status?: string | null;
  amount_cents?: number | null;
}

/**
 * V26 pure: what the mystery-bounty inventory looks like RIGHT NOW.
 * Exported for tests. Everything degrades to zeros when there is no chest
 * system, which reads as "not a mystery bounty" downstream rather than as a
 * jackpot that happens to be empty.
 */
export function deriveBountyLandscape(chests: ChestRow[] | null | undefined): {
  mysteryChestsLeft: number;
  mysteryMeanCents: number;
  mysteryTopCents: number;
  mysteryTopLive: boolean;
} {
  const none = {
    mysteryChestsLeft: 0,
    mysteryMeanCents: 0,
    mysteryTopCents: 0,
    mysteryTopLive: false,
  };
  if (!Array.isArray(chests) || chests.length === 0) return none;
  let left = 0;
  let sum = 0;
  let top = 0;
  let topEver = 0;
  for (const c of chests) {
    const amt = Number(c?.amount_cents) || 0;
    if (amt <= 0) continue;
    // 'void' chests were never in play (the event ended early, or the
    // inventory was trimmed) - they are not part of any landscape.
    if (c?.status === 'void') continue;
    if (amt > topEver) topEver = amt;
    if (c?.status === 'available') {
      left++;
      sum += amt;
      if (amt > top) top = amt;
    }
  }
  if (left === 0) return { ...none, mysteryTopLive: false };
  return {
    mysteryChestsLeft: left,
    mysteryMeanCents: Math.round(sum / left),
    mysteryTopCents: top,
    // The single biggest chest the tournament ever held is still unclaimed.
    mysteryTopLive: topEver > 0 && top >= topEver,
  };
}

/** Pure derivation — unit-tested. */
export function deriveContext(
  row: TournamentRowLite,
  playersLeft: number,
  entrants: number,
  chipSum: number,
  /** V16 ICM: live stack list (any order; stored sorted desc, capped). */
  liveStacks: number[] = [],
  /** V26: the mystery-bounty chest inventory, if this event has one. */
  chests: ChestRow[] = [],
  /** V26: live per-player bounties in cents (PKO), any order. */
  liveBounties: number[] = [],
  /** V37: what one target seat costs (buy-in + fee), 0 when unknown/none. */
  satelliteTicketCost: number = 0,
  /** V37: live bounty per user id, cents. */
  bountyByUser: Record<string, number> = {}
): TournamentBrainContext {
  const type = (row.tournament_type || '').toUpperCase();
  const variant = (row.variant || '').toLowerCase();
  const format: TournamentFormat =
    type === 'SPIN' || variant === 'spin' ? 'spin' : seatsAtOneTable(row) <= 2 ? 'hu_sng' : 'mtt';

  // V13: use the CANONICAL parser instead of a local JSON.parse. The old code
  // only understood the array shape [{place, percentage}] and silently scored
  // 0 paid spots for the object shape {"1": 100} that other services in this
  // repo write and read — which made inMoney and nearBubble permanently false
  // and left the whole bubble model inert for that tournament, degrading
  // quietly so nobody would ever notice. It also counted [null, null] as two
  // paid places. parsePayoutStructure rejects a structure with no place 1, a
  // negative percentage, or percentages summing to zero, and for a Spin with a
  // missing structure resolvePayoutStructure rebuilds it from the multiplier
  // rather than assuming winner-take-all.
  let places = resolvePayoutStructure(row as PayoutSubject);

  // ═══ V37 SATELLITE: the prize curve is FLAT, whatever the row says ═══
  // Once the guarantee-funding rail finalizes the pool, the atomic database
  // settlement awards floor(pool / ticket) equal tickets. Before finalization,
  // the advertised guarantee remains the minimum expected count. A cash
  // remainder goes to the single next finisher and is carried as one small
  // extra place so the model does not pretend the bubble pays nothing at all.
  const configuredSeats = Math.max(0, Math.floor(Number(row.satellite_seats) || 0));
  const hasTarget = !!(row.satellite_target_id || row.satellite_target);
  const isSatellite = format !== 'spin' && (configuredSeats > 0 || hasTarget);
  let satelliteSeats = 0;
  if (isSatellite) {
    const pool = Math.max(0, Number(row.prize_pool) || 0);
    const affordable = satelliteTicketCost > 0 ? Math.floor(pool / satelliteTicketCost) : 0;
    satelliteSeats = Math.max(configuredSeats, affordable);
    if (satelliteSeats > 0) {
      const ticketTotal = satelliteSeats * (satelliteTicketCost > 0 ? satelliteTicketCost : 0);
      const remainder = satelliteTicketCost > 0 ? Math.max(0, pool - ticketTotal) : 0;
      const flat: Array<{ place: number; percentage: number }> = [];
      const seatPct =
        remainder > 0 && pool > 0
          ? (100 * (pool - remainder)) / pool / satelliteSeats
          : 100 / satelliteSeats;
      for (let i = 1; i <= satelliteSeats; i++) flat.push({ place: i, percentage: seatPct });
      if (remainder > 0 && pool > 0) {
        flat.push({ place: satelliteSeats + 1, percentage: (100 * remainder) / pool });
      }
      places = flat;
    }
  }

  const spotsPaid =
    isSatellite && satelliteSeats > 0
      ? satelliteSeats
      : places && places.length > 0
        ? places.length
        : format === 'spin'
          ? 1
          : 0;

  const inMoney = spotsPaid > 0 && playersLeft > 0 && playersLeft <= spotsPaid;
  const nearBubble =
    spotsPaid > 0 &&
    !inMoney &&
    playersLeft <= Math.max(spotsPaid + 1, Math.ceil(spotsPaid * 1.15));

  const prizePool = Number(row.prize_pool) || 0;
  const bountyPool = Number(row.bounty_pool) || 0;
  const bountyFactor =
    (row.is_pko || row.is_bounty) && prizePool + bountyPool > 0
      ? bountyPool / (prizePool + bountyPool)
      : 0;

  // V16 ICM inputs: the payout CURVE and the live stack DISTRIBUTION are
  // what a real Malmuth-Harville pressure model needs; counts alone were why
  // the old premium had to be a flat guess.
  // V29 AUDIT FIX (H3, 2026-08-29): the curve used to be sliced to the top 9
  // places and the REST OF THE PAID MASS DISCARDED — a 1,200-runner event
  // paying 150 was modelled as a 9-paid tournament, so the survival premium
  // in deep fields was derived from a fiction (and telemetry reported the
  // path as 'real', so it looked healthy). The model still takes at most 9
  // buckets, but the 9th now CARRIES the sum of every remaining paid place:
  // total paid mass is preserved, and the tail the model prices reflects the
  // actual money below the top table.
  const sortedPlaces = (places ?? [])
    .slice()
    .sort((a, b) => a.place - b.place)
    .map((p) => p.percentage)
    .filter((p) => p > 0);
  // V37: a satellite keeps its whole flat curve (up to 200 seats) — the
  // flat-payout survival model in IcmModel needs the real seat count, and the
  // 9-bucket collapse would turn "40 equal seats" into "8 seats and a lump".
  const payoutPct =
    isSatellite && satelliteSeats > 0
      ? sortedPlaces.slice(0, 200)
      : sortedPlaces.length <= 9
        ? sortedPlaces
        : [...sortedPlaces.slice(0, 8), sortedPlaces.slice(8).reduce((a, b) => a + b, 0)];
  // Same defect on the stack side: it took the TOP 200 stacks, discarding the
  // bottom of the field entirely — in any event past 200 players the model saw
  // only big stacks, hero's chip share was computed against an inflated
  // average, and a below-median hero was substituted over a real big stack.
  // The 200-stack cap stays (the model needs bounded work), but the sample is
  // now a QUANTILE sample of the whole sorted field: every 200th-ile stack
  // from chip leader to shortest. The distribution's shape, mean and hero's
  // relative standing all survive; only resolution is lost.
  const allLive = liveStacks.filter((s) => isFinite(s) && s > 0).sort((a, b) => b - a);
  let stacks: number[];
  if (allLive.length <= 200) {
    stacks = allLive;
  } else {
    stacks = [];
    for (let i = 0; i < 200; i++) {
      const idx = Math.min(allLive.length - 1, Math.round((i * (allLive.length - 1)) / 199));
      stacks.push(allLive[idx]);
    }
  }

  // V23: the blind clock and the final-table flag ride the same derivation.
  const clock = deriveBlindClock(
    row.blind_structure,
    row.current_level,
    row.level_started_at,
    Date.now()
  );
  return {
    format,
    entrants: Math.max(entrants, playersLeft),
    playersLeft,
    spotsPaid,
    inMoney,
    nearBubble,
    avgStackChips: playersLeft > 0 ? chipSum / playersLeft : 0,
    bountyFactor: Math.max(0, Math.min(1, bountyFactor)),
    stacks,
    payoutPct,
    ...deriveBountyLandscape(chests),
    meanBountyCents:
      liveBounties.length > 0
        ? Math.round(liveBounties.reduce((a, b) => a + (Number(b) || 0), 0) / liveBounties.length)
        : 0,
    finalTable: format === 'mtt' && playersLeft >= 2 && playersLeft <= 9,
    nextBlindInMin: clock.nextBlindInMin,
    nextBlindMult: clock.nextBlindMult,
    satellite: isSatellite && satelliteSeats > 0,
    satelliteSeats,
    bountyByUser,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_TIMEOUT_MS = 5000;
const STUCK_MS = 60_000;
const TTL_MS = 20_000;
const MAX_CACHED = 500;

interface CacheEntry {
  ctx: TournamentBrainContext | null;
  fetchedAt: number;
  inFlight: boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * Synchronous read for the decision path. Returns the last known context (or
 * null before the first fetch resolves) and refreshes in the background when
 * stale.
 */
export function getTournamentBrainContext(tournamentId: string): TournamentBrainContext | null {
  const now = Date.now();
  let e = cache.get(tournamentId);
  if (!e) {
    // V29 AUDIT FIX (was LOW in the wire audit): .clear() dropped EVERY live
    // tournament's context at once — every horse in every event fell back to
    // the flat premium simultaneously until refreshes landed. Evict the
    // stalest quarter instead.
    if (cache.size > MAX_CACHED) {
      const entries = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
      for (let i = 0; i < Math.ceil(entries.length / 4); i++) cache.delete(entries[i][0]);
    }
    e = { ctx: null, fetchedAt: 0, inFlight: false };
    cache.set(tournamentId, e);
  }
  // V13: `inFlight` is only cleared in refresh()'s finally, which never runs
  // if the promise never settles. One hung Supabase fetch used to pin the flag
  // for the process lifetime and freeze that tournament's ICM context — or
  // leave it null forever if the hang was on the first attempt, so the horses
  // played the whole event, bubble included, on the flat premium with no
  // signal. The stuck-guard lets a later call retry regardless.
  const stuck = e.inFlight && now - e.fetchedAt > STUCK_MS;
  if ((!e.inFlight || stuck) && now - e.fetchedAt > TTL_MS) {
    e.inFlight = true;
    void refresh(tournamentId, e);
  }
  return e.ctx;
}

/** Test hook. */
export function __clearTournamentBrainCache(): void {
  cache.clear();
}

async function refresh(tournamentId: string, e: CacheEntry): Promise<void> {
  try {
    // V13: bound the whole refresh. Neither query carries an AbortSignal, and
    // a decision never waits on this — a timeout simply keeps the last known
    // context, which is exactly the documented fail-safe.
    const deadline = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error('tournament context refresh timed out')),
        REFRESH_TIMEOUT_MS
      ).unref?.()
    );
    const [tRes, pRes, cRes] = await Promise.race([
      deadline,
      Promise.all([
        supabase
          .from('tournaments')
          .select(
            'tournament_type, variant, max_players, table_size, payout_structure, spin_multiplier, prize_pool, bounty_pool, is_pko, is_bounty, is_mystery_bounty, blind_structure, current_level, level_started_at, satellite_seats, satellite_target_id, satellite_target'
          )
          .eq('id', tournamentId)
          .maybeSingle(),
        supabase
          .from('tournament_players')
          .select('user_id, chips, status, current_bounty')
          .eq('tournament_id', tournamentId)
          .order('id', { ascending: true })
          .limit(5000),
        // V26: the mystery-bounty chest inventory. Cheap (a few hundred rows
        // at most) and only meaningful for mystery events, but asked
        // unconditionally so a mid-event activation cannot be missed - the
        // aggregate is empty for every other tournament, which reads as
        // "no chest system" rather than "an empty jackpot".
        supabase
          .from('tournament_bounty_chests')
          .select('status, amount_cents')
          .eq('tournament_id', tournamentId)
          .limit(2000),
      ]),
    ]);
    if (tRes.error) throw new Error(tRes.error.message);
    if (pRes.error) throw new Error(pRes.error.message);
    // V26: a failed CHEST read must not sink the whole context - the ICM and
    // blind-clock halves are still good. Treat it as "no inventory known",
    // which degrades to the pre-V26 flat bounty handling.
    const chestRows = cRes?.error ? [] : ((cRes?.data ?? []) as ChestRow[]);
    if (cRes?.error) {
      reportError(
        new Error(`chest inventory read failed: ${cRes.error.message}`),
        'TournamentBrainContext.chests_unavailable'
      );
    }
    if (!tRes.data) {
      // V13: maybeSingle() returns null for zero rows, which includes a
      // read-replica blip or an RLS hiccup — not only a genuinely absent
      // tournament. This used to discard a good context mid-event, dropping
      // the horses back to the flat premium at the worst possible moment (the
      // bubble is exactly when query volume peaks). The catch below already
      // treats stale as better than nothing; this now agrees with it.
      if (e.ctx)
        reportError(
          new Error(`tournament ${tournamentId} read returned no row`),
          'TournamentBrainContext.missing'
        );
      return;
    }
    const rows = (pRes.data ?? []) as Array<{
      user_id?: string | null;
      chips: number | null;
      status: string | null;
      current_bounty: number | null;
    }>;
    const liveBounties: number[] = [];
    const bountyByUser: Record<string, number> = {};
    const entrants = rows.length;
    let playersLeft = 0;
    let chipSum = 0;
    const liveStacks: number[] = [];
    for (const r of rows) {
      const st = (r.status || '').toLowerCase();
      if (st === 'eliminated' || st === 'busted' || st === 'unregistered') continue;
      playersLeft++;
      const chips = Number(r.chips) || 0;
      chipSum += chips;
      if (chips > 0) liveStacks.push(chips);
      const b = Number(r.current_bounty) || 0;
      if (b > 0) {
        liveBounties.push(b);
        if (typeof r.user_id === 'string' && r.user_id) bountyByUser[r.user_id] = b;
      }
    }
    // V37: a satellite's ticket is the target's buy-in + fee. One extra
    // small read, only for satellites, and only a hint: without it the
    // guaranteed seat count still builds the flat curve.
    let ticketCost = 0;
    const tRow = tRes.data as TournamentRowLite;
    const targetId = tRow.satellite_target_id || tRow.satellite_target;
    if (targetId) {
      try {
        const { data: target } = await supabase
          .from('tournaments')
          .select('buy_in_amount, buy_in_fee')
          .eq('id', targetId)
          .maybeSingle();
        if (target) {
          ticketCost = Math.max(
            0,
            Number((target as { buy_in_amount?: number }).buy_in_amount || 0) +
              Number((target as { buy_in_fee?: number }).buy_in_fee || 0)
          );
        }
      } catch {
        /* the seat count still comes from satellite_seats */
      }
    }
    e.ctx = deriveContext(
      tRow,
      playersLeft,
      entrants,
      chipSum,
      liveStacks,
      chestRows,
      liveBounties,
      ticketCost,
      bountyByUser
    );
  } catch (err) {
    reportError(err, 'TournamentBrainContext.refresh');
    // keep the last known ctx — stale beats nothing
  } finally {
    e.fetchedAt = Date.now();
    e.inFlight = false;
  }
}
