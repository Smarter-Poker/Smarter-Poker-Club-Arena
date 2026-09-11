/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE BEHAVIOR — Deterministic Per-Horse Personality Helpers (V8 — 2026-07-24)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pure functions (no imports, no I/O) that give each horse a stable identity
 * for HOW it shows up to play, shared by HorseFleetManager (joining) and
 * HorseSessionRotator (leaving):
 *  - buy-in profile: 15% short-stackers (40-60bb), 60% standard (80-120bb),
 *    25% deep (140-200bb), jittered per sitting
 *  - daily activity window: hash-derived start hour + 10-17h length, so the
 *    floor population rotates through the whole stable with a human-looking
 *    daily rhythm (~55% of horses active at any hour)
 *
 * Deliberately dependency-free so unit tests can import it without touching
 * the supabase client (which fatals without env credentials).
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

/** Deterministic 32-bit hash of a horse id (same scheme as the style hash). */
export function horseHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Buy-in in big blinds for this horse THIS sitting: profile from the id hash,
 * jittered per sitting. Caller clamps to the table's real min/max buy-in.
 *
 * ═══ THE JITTER IS SEEDED BY THE SITTING, NOT BY THE CALL (2026-09-06) ═══
 *
 * This used to draw `Math.random()` on every call. The seeding cycle asks the
 * sit verdict twice for the same horse at the same table - once to COUNT it
 * as a buyer for the ClusterController, once for the CHAIR - and the verdict
 * sizes the buy-in each time and feeds it to the aggregate-exposure ceiling
 * (`canOpenAnotherTable`: liveExposure + nextBuyIn <= roll x share x 3). A
 * standard horse rolls anywhere from 80 to 120 big blinds, a deep one 140 to
 * 200, so the count could pass on an 82bb roll and the chair refuse on a
 * 118bb one. HorseSitVerdict's header promised "a horse judged once for the
 * count and once for the chair is counted once"; with a die inside it that
 * was not true, and the opening-feeder diagnostics showed the result:
 * `selected 2, seated 0, skipped {aggregate_exposure=5}` - a feeder opened on
 * two buyers the chair then refused.
 *
 * `sitting` is whatever identifies THIS sitting to the caller (the fleet
 * passes the table id and the cycle's start time). Two calls with the same
 * sitting return the same number; a different cycle rolls again, which is
 * the per-sitting jitter this function was written for. No sitting = the old
 * behaviour, for callers that only want a plausible one-off number.
 */
export function buyInBBFor(horseId: string, sitting?: string): number {
  const h = horseHash(horseId);
  const bucket = h % 100;
  const r =
    sitting === undefined ? Math.random() : (horseHash(`${horseId}|${sitting}`) % 10_000) / 10_000;
  if (bucket < 15) return 40 + r * 20; // short-stacker: 40-60bb
  if (bucket < 75) return 80 + r * 40; // standard: 80-120bb
  return 140 + r * 60; // deep: 140-200bb
}

/**
 * Is this horse inside its daily activity window right now? Window start and
 * length (10-17h) derive from the id hash — stable day to day.
 */
export function isActiveNow(horseId: string, hourUTC: number): boolean {
  const h = horseHash(horseId);
  const start = h % 24;
  const len = 10 + ((h >>> 5) % 8);
  const rel = (hourUTC - start + 24) % 24;
  return rel < len;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE FLOOR IS FULL (Dan 2026-09-02, binding) — REPLACES THE 15% HELD-EMPTY RULE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Dan, verbatim: "HORSES CAN FILL ALL SEATS, AND ONLY 'GET UP' WHEN A REAL HUMAN
// IS ON THE WAITING LIST FOR 75% OF ALL GAMES. THE OTHER 25% OF GAMES SHOULD
// HAVE ANYWHERE FROM ONE, TO A FULL GAME. IT SHOULD BE SPARATIC, BUT HORSES NEED
// TO BE OCCUPYING AT LEAST 75% OF ALL SEATS IN THE CASH GAMES, AND THEY SHOULD
// BE PLAYING 4 TABLES AT ONCE!"
//
// This supersedes two of Dan's own earlier rules, and both are DELETED rather
// than left to argue with this one:
//
//   - 2026-08-26, "LEAVE 15% OF ALL CASH GAME TABLES EMPTY". A held-empty table
//     has ZERO seats filled, and the new rule's floor for the sparse quarter is
//     ONE. The two cannot both be true, and an empty table cannot contribute to
//     "at least 75% of all seats".
//   - 2026-08-23, the five-way vibe drift (hot / busy / steady / quiet / empty),
//     which put three quarters of the floor BELOW full by construction: steady
//     left 2-3 seats open and quiet left 3-5, so the room could not reach 75%
//     occupancy no matter how many horses were available.
//
// What replaces them is deliberately simpler, because the new rule is simpler.
// A table is one of two things for the length of a long bucket:
//
//   FULL      (75%) — every seat taken. Horses do not drift out of these. The
//                     ONLY thing that opens a seat is a real human joining the
//                     waiting list, and then exactly as many seats open as
//                     there are humans waiting.
//   SPORADIC  (25%) — anywhere from one seat to a full game, re-rolled on the
//                     bucket, so a quarter of the room is visibly uneven.
//
// The bucket is LONG (three hours). A table's character is meant to read as a
// game that is full today, not as a seat count that flickers: anything shorter
// and horses stand up and sit down for no reason a watching player can see,
// which is the thrash the original drift comment warned about.

/** Fraction of cash tables that sit FULL of horses. Dan 2026-09-02. */
export const CASH_FULL_FRACTION = 0.75;

/** How long a table keeps its full/sporadic character before re-rolling. */
export const FILL_BUCKET_MS = 3 * 60 * 60_000;

export type TableFill = 'full' | 'sporadic';

export function mix32(x: number): number {
  let h = x >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/**
 * Is this table one of the 75% that sits full?
 *
 * Deterministic in (tableId, bucket) so every engine instance agrees and the
 * answer holds still long enough to be worth acting on. The murmur3 finalizer
 * is not decoration: `horseHash` is a weak multiply-add, and folding a
 * consecutive bucket number into it advances the hash by about +1 per bucket,
 * so a table WALKS through the band one step at a time instead of re-rolling.
 * That bug held a whole variant's room dark for thirty hours when it was the
 * held-empty rule; it would hold a table sparse for just as long now.
 */
export function cashTableFill(tableId: string, nowMs: number = Date.now()): TableFill {
  const bucket = Math.floor(nowMs / FILL_BUCKET_MS);
  const seed = (horseHash(`${tableId}:fill`) ^ Math.imul(bucket, 0x9e3779b1)) >>> 0;
  return mix32(seed) % 100 < CASH_FULL_FRACTION * 100 ? 'full' : 'sporadic';
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAME LANES (Dan 2026-08-26, binding)
// ═══════════════════════════════════════════════════════════════════════════════
// "33% OF HORSES SHOULD BE PLAYING NOTHING BUT TOURNAMENTS, SPINS AND HEADS
//  UP. 33% PLAY NOTHING BUT CASH. 34% PLAY A MIX OF BOTH."
//
// A stable identity, derived from the id hash like every other trait, so the
// same horse is a cash grinder every day rather than re-rolling per cycle.

export type HorseGameLane = 'events' | 'cash' | 'both';

/**
 * ASSIGNED lanes, hydrated from profiles.horse_profile->>'lane' at boot.
 *
 * The hash below produced 32.0 / 39.0 / 28.9 measured over the real 584
 * horses - cash over-weighted by six points, and the fleet's tournament
 * capacity short by the same amount. The cause is the trap this codebase
 * already documented for horse tempo: `horseHash` is a weak multiply-add and
 * a LOW-BIT modulo of it clusters on structured ids, which UUIDs are. A
 * stronger mix reached 32.5 / 31.2 / 36.3 - honest sampling noise rather
 * than a fix, because no hash gives an exact split at this fleet size.
 *
 * So the split is ASSIGNED (fn_assign_horse_lanes, exact by construction and
 * visible in the database) and merely CACHED here. The hash remains the
 * fallback for a horse created after the last assignment run, so a brand-new
 * horse still has a lane the moment it is dealt in.
 */
const assignedLanes = new Map<string, HorseGameLane>();

export function setHorseLanes(rows: Array<{ id: string; lane: string | null }>): number {
  let n = 0;
  for (const r of rows) {
    if (!r?.id) continue;
    const lane = r.lane === 'events' || r.lane === 'cash' || r.lane === 'both' ? r.lane : null;
    if (!lane) continue;
    assignedLanes.set(r.id, lane);
    n++;
  }
  return n;
}

/** Test/ops hook: how many assigned lanes are loaded right now. */
export function assignedLaneCount(): number {
  return assignedLanes.size;
}

export function gameLaneFor(horseId: string): HorseGameLane {
  const assigned = assignedLanes.get(horseId);
  if (assigned) return assigned;
  // Fallback only - see the note above on why this is not the source of truth.
  const h = horseHash(`${horseId}:lane`);
  const roll = h % 100;
  if (roll < 33) return 'events'; // tournaments, spins, heads-up only
  if (roll < 66) return 'cash'; // cash only
  return 'both';
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAKE BANDS (Dan 2026-08-29, binding)
// ═══════════════════════════════════════════════════════════════════════════════
// "EACH HORSE SHOULD HAVE A SPECIFIC STAKES THEY'RE PLAYING. A HORSE PLAYING
//  5/10 OR 10/25 SHOULD NEVER BE SEEN ON A 50 CENT ONE DOLLAR GAME OR 1/2
//  DOLLAR GAME, THAT JUST LOOKS SUSPICIOUS."
//
// He is right, and it was measurable. Over 48 hours of cash play: 210 horses
// seated, and 64 of them - nearly a third - sat at more than one stake level.
// The worst were not marginal:
//
//     yankee            0.10/0.20  and  25.00/50.00      (250x)
//     mixedgame max     0.10/0.20, 1.00/2.00, 10.00/25.00 (125x)
//     ronald calabrese 2  0.10/0.20, 2.00/4.00, 10.00/25.00
//
// No human bankroll moves like that, and a regular who recognises a name from
// the 10/25 game sitting in their 0.10/0.20 game notices immediately.
//
// The cause was that stakes were never an input. HorseFleetManager picked from
// every enabled horse, weighted only by how many tables it already sat at; the
// blinds were read solely to compute a buy-in amount.
//
// A band is an IDENTITY, in exactly the sense a lane is: assigned once, stored
// in profiles.horse_profile, stable across days. Within its band a horse still
// moves freely - a mid-stakes regular playing both 2/4 and 3/6 is ordinary, and
// multi-tabling one's own stake is what real players actually do.

export type HorseStakeBand = 'micro' | 'low' | 'mid' | 'high';

/**
 * The boundaries are the real stake ladder, not round numbers picked in the
 * abstract. Every live cash table on 2026-08-29 fell inside one of these with
 * nothing straddling an edge:
 *
 *     micro   0.05/0.10, 0.10/0.20, 0.25/0.50
 *     low     0.50/1.00, 1.00/2.00          <- where the fleet's own configs live
 *     mid     2.00/4.00, 2.00/5.00, 3.00/6.00
 *     high    5.00/10.00, 10.00/25.00, 25.00/50.00
 *
 * THIS IS THE CANONICAL BAND FUNCTION (2026-09-05). StableHand used to carry
 * a second, three-band one (micro / low / top, and null above 2) that
 * disagreed with this one at every stake above 1/2. It is gone; StableHand
 * re-exports this as `stakeBandOf`, so a band means the same thing to the
 * seat gate, the tagger, the planner and `fn_assign_horse_stake_bands`.
 * Change a boundary here and you have changed it everywhere, which is the
 * point.
 */
export function stakeBandForBigBlind(bigBlind: number): HorseStakeBand {
  const bb = Number(bigBlind);
  if (!Number.isFinite(bb) || bb <= 0) return 'low';
  if (bb <= 0.5) return 'micro';
  if (bb <= 2) return 'low';
  if (bb <= 6) return 'mid';
  return 'high';
}

/**
 * ASSIGNED bands, hydrated from profiles.horse_profile->>'stakeBand' at boot,
 * for exactly the reason lanes are assigned rather than hashed: horseHash is a
 * weak multiply-add and a low-bit modulo of it clusters on UUIDs, so a hashed
 * split misses its targets by several points at this fleet size. A starved
 * band is not cosmetic here - it means a table nobody may sit at.
 */
const assignedStakeBands = new Map<string, HorseStakeBand>();

function isStakeBand(v: unknown): v is HorseStakeBand {
  return v === 'micro' || v === 'low' || v === 'mid' || v === 'high';
}

export function setHorseStakeBands(rows: Array<{ id: string; stakeBand: string | null }>): number {
  let n = 0;
  for (const r of rows) {
    if (!r?.id) continue;
    if (!isStakeBand(r.stakeBand)) continue;
    assignedStakeBands.set(r.id, r.stakeBand);
    n++;
  }
  return n;
}

/** Test/ops hook: how many assigned bands are loaded right now. */
export function assignedStakeBandCount(): number {
  return assignedStakeBands.size;
}

/**
 * Test hook: forget every assigned band. The loader MERGES (a horse missing
 * from one page keeps the band it had), so a test that wants to reason about
 * the whole fleet - how many horses a band shortage moves, say - has to start
 * from an empty map rather than from whatever an earlier case left behind.
 */
export function clearHorseStakeBands(): void {
  assignedStakeBands.clear();
}

/**
 * A BAND IS EARNED (Dan 2026-08-29): micro is the worst-performing horses, low
 * the second worst, mid the good winners, high the best. The ranking is done in
 * the database by `fn_assign_horse_stake_bands`, on bb/100 - winnings over the
 * big blinds actually faced, which is the only measure comparable across a
 * stake ladder, since 500 chips is a career at 0.05/0.10 and a rounding error
 * at 25/50. Measured after the first merit run: micro -35.6 bb/100, low -12.0,
 * mid +1.7, high +22.9.
 *
 * The proportions (22/52/15/11) still follow live seat demand, so merit decides
 * WHO is in a band and demand decides HOW MANY - no stake level ends up without
 * enough horses to fill it.
 */
export function stakeBandFor(horseId: string): HorseStakeBand {
  const assigned = assignedStakeBands.get(horseId);
  if (assigned) return assigned;
  /**
   * A HORSE WITH NO RECORD STARTS AT THE BOTTOM. There is no hash fallback here
   * and there must not be one: a band is a claim about results, and a brand-new
   * horse has none. Hashing it into 'high' would seat an unproven player in the
   * 25/50 game on the strength of its uuid, which is precisely the arbitrary
   * assignment this replaced. Starting in the smallest game and earning the way
   * up is both the realistic answer and the safe one - and it is temporary, the
   * loader re-ranks every 30 minutes.
   */
  return 'micro';
}

/**
 * THE LADDER, LOW TO HIGH. The fallback below walks it DOWNWARD only.
 */
export const STAKE_BAND_LADDER: readonly HorseStakeBand[] = ['micro', 'low', 'mid', 'high'];

/**
 * WHICH BANDS HAVE A GAME TO SIT IN, as the fleet's last cycle read the floor.
 * `null` means nobody has told us yet (boot, or a cycle that read no tables),
 * and that is deliberately indistinguishable from "every band is fine": an
 * unknown floor must never narrow anybody. See `applyStakeBandSupply`.
 */
let bandSupply: ReadonlySet<HorseStakeBand> | null = null;

/** Test/ops hook: the supply set the last cycle published, or null. */
export function stakeBandSupply(): ReadonlySet<HorseStakeBand> | null {
  return bandSupply;
}

/** Test hook: forget the supply, so the gate is the assigned band alone. */
export function clearStakeBandSupply(): void {
  bandSupply = null;
}

/**
 * THE BAND A HORSE CAN ACTUALLY SIT IN THIS CYCLE.
 *
 * A band is a merit record (see `stakeBandFor`) and it is not rewritten here.
 * But a record is not a seat: on 2026-09-05 an operator had closed every game
 * with bb > 6 - the six high games, 5/10 NLH Classic/Action/Madness, 5/10 PLO4
 * Classic, 10/20 NLH and 25/50 NLH, all switched off at 16:47 the previous day
 * - while `fn_assign_horse_stake_bands` went on assigning 'high' to the top
 * 11% of the fleet by bb/100, because it ranks horses and never asks which
 * games exist. 100 horses held a band with no game in it, and `stakeBandAllows`
 * is a hard gate, so those 100 could sit NOWHERE AT ALL.
 *
 * The fix is a SEATING fallback and nothing more: a horse whose band has no
 * game drops to the highest band BELOW it that does. Downward only - a micro
 * horse is never promoted into a game it has not earned, which is the whole
 * point of the ladder and the thing a player would notice. Its stored band is
 * untouched: the operator's switch is temporary and the merit record is not
 * ours to rewrite.
 *
 * THE SAME RULE RUNS IN SQL (2026-09-06). `fn_project_stake_band(band, avail)`
 * in migration 20260906093032 is this function, statement for statement, and
 * `fn_assign_horse_stake_bands` applies it so the ASSIGNMENT stops minting
 * horses into a band with no game in the first place. This one stays as the
 * belt to that braces: it covers the window between an operator switching a
 * game off and the next assignment run. Change one and change the other -
 * HorseStakeBandProjection.test.ts fails if they drift.
 */
export function projectStakeBandOnto(
  band: HorseStakeBand,
  available: ReadonlySet<HorseStakeBand> | null | undefined
): HorseStakeBand {
  // Nothing published, or a floor with no bands at all: fail OPEN. A cycle
  // that read no tables is not evidence that a band is empty.
  if (!available || available.size === 0) return band;
  if (available.has(band)) return band;
  for (let i = STAKE_BAND_LADDER.indexOf(band) - 1; i >= 0; i--) {
    const lower = STAKE_BAND_LADDER[i];
    if (available.has(lower)) return lower;
  }
  // Only bands ABOVE this horse have a game. It stays where it is rather than
  // being promoted; the floor simply has nothing for it this cycle.
  return band;
}

export function effectiveStakeBandFor(horseId: string): HorseStakeBand {
  return projectStakeBandOnto(stakeBandFor(horseId), bandSupply);
}

/**
 * Publish the bands that have at least one enabled game, once per fleet cycle,
 * and report what that costs: which bands with horses in them have no game,
 * and how many horses are therefore seating below their record.
 */
export function applyStakeBandSupply(bands: Iterable<HorseStakeBand>): {
  missing: HorseStakeBand[];
  fallbacks: number;
} {
  const next = new Set<HorseStakeBand>();
  for (const b of bands) if (isStakeBand(b)) next.add(b);
  bandSupply = next.size > 0 ? next : null;
  if (!bandSupply) return { missing: [], fallbacks: 0 };

  const missing = new Set<HorseStakeBand>();
  let fallbacks = 0;
  for (const [horseId, assigned] of assignedStakeBands) {
    if (bandSupply.has(assigned)) continue;
    missing.add(assigned);
    if (effectiveStakeBandFor(horseId) !== assigned) fallbacks++;
  }
  return {
    missing: STAKE_BAND_LADDER.filter((b) => missing.has(b)),
    fallbacks,
  };
}

/**
 * May this horse sit in this game?
 *
 * NO ESCAPE HATCH, DELIBERATELY. There is a temptation to break the band when
 * a table has a waiting human and no banded horse is free - but that is
 * precisely the moment a human is looking, which makes it the worst possible
 * time to seat a 10/25 name in a 0.50/1 game. A quiet high-stakes table is
 * ordinary; a nosebleed regular in a micro game is the tell.
 *
 * THE ONE MOVEMENT ALLOWED IS DOWNWARD, AND ONLY WHEN THE BAND IS EMPTY OF
 * GAMES (2026-09-05). That is `effectiveStakeBandFor`, and it is not an escape
 * hatch in the sense this comment forbids: it never lets a small horse into a
 * big game, which is the direction that looks wrong. A high-stakes regular
 * playing mid because the high games are switched off is an ordinary thing to
 * see; a hundred names that vanish from the floor entirely is not.
 */
export function stakeBandAllows(horseId: string, bigBlind: number): boolean {
  return effectiveStakeBandFor(horseId) === stakeBandForBigBlind(bigBlind);
}

/**
 * How many horses this table wants seated right now.
 *
 * THE ONLY THING THAT OPENS A SEAT ON A FULL TABLE IS A HUMAN IN THE QUEUE
 * (Dan 2026-09-02). `humansWaiting` is subtracted from the target, so the
 * fleet's ordinary "seat up to target" loop becomes the release mechanism:
 * three humans on the list means three fewer horse seats wanted, and the
 * rotator stands exactly that many horses up. No separate eviction path, and
 * nothing that can evict a horse for any other reason.
 *
 * `humanSeated` still pins a table to a playable game — a human's table never
 * goes short underneath them — and it outranks the sparse roll, because a
 * human sitting down is the one signal that a game is wanted.
 */
export function occupancyTargetFor(
  tableId: string,
  maxPlayers: number,
  humanSeated: boolean = false,
  nowMs: number = Date.now(),
  humansWaiting: number = 0
): { seatTarget: number; waitTarget: number; fill: TableFill } {
  const fill = cashTableFill(tableId, nowMs);
  let seatTarget: number;
  if (fill === 'full') {
    seatTarget = maxPlayers;
  } else {
    /* One seat to a full game, re-rolled on the long bucket. `1 +` is the
       floor Dan named: a sparse table still has SOMEBODY at it, which is what
       separates this from the empty tables this rule replaced. */
    const h = horseHash(`${tableId}:${Math.floor(nowMs / FILL_BUCKET_MS)}:seats`);
    seatTarget = 1 + (h % Math.max(1, maxPlayers));
  }
  if (humanSeated) seatTarget = Math.max(seatTarget, Math.min(maxPlayers, 4));

  /* Room for the queue. Only ever reduces the target, never below one seat —
     a table emptied of horses cannot deal the game the human queued for. */
  if (humansWaiting > 0) {
    seatTarget = Math.max(1, seatTarget - humansWaiting);
  }

  /* Horses do not queue any more (waitTarget is always 0, and the fleet
     prunes horse rows out of every waiting list). A queue used to be
     decoration on a full table; under this rule it is a signal that a real
     person wants in, and a horse standing in it would both delay that person
     and make "is a human waiting" unanswerable. */
  return { seatTarget: Math.max(1, Math.min(maxPlayers, seatTarget)), waitTarget: 0, fill };
}

/**
 * Should this horse pick up and move to a different game right now?
 *
 * Session-end departures are HorseSessionRotator's job and are about the
 * session ending. This is the other half of what a floor looks like: a player
 * who is still playing but does not like THIS game — the table went quiet, or
 * they just fancy a change — and walks to another one. Without it the only
 * movement on the floor is people arriving and people quitting, and the same
 * faces sit at the same table until they log off.
 *
 * Rare per horse per cycle, so the floor churns steadily rather than churning
 * all at once.
 */
export function wantsTableChange(
  horseId: string,
  tableId: string,
  seatedCount: number,
  minutesAtTable: number,
  nowMs: number = Date.now()
): boolean {
  // Nobody table-hops the moment they sit down.
  if (minutesAtTable < 12) return false;
  const h = horseHash(`${horseId}:${tableId}:${Math.floor(nowMs / 60_000)}`);
  const roll = (h % 10_000) / 10_000;
  // A short-handed game empties faster: the fewer players, the likelier the
  // remaining ones leave, which is exactly how a dying table dies.
  const base = seatedCount <= 3 ? 0.055 : seatedCount <= 5 ? 0.018 : 0.008;
  // Restlessness is a trait: some players never move, some are always moving.
  const restless = 0.5 + ((horseHash(horseId) >>> 9) % 1000) / 1000;
  return roll < base * restless;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SEAT CHANGE IS A BUTTON EVERY PLAYER HAS (CLAUDE.md 10.5, 2026-09-05)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The must-move lobby gave every player on a feeder table a SEAT CHANGE they
// may use once per stay in a game (`fn_cash_seat_change_request`). Horses got
// the button drawn for nobody: the door read `auth.uid()`, the engine has
// none, and so a feature a human gets was denied to a horse by construction.
// That is exactly what 10.5 forbids, and on a floor where the feeders are
// nearly all horses it is also visible - a lobby whose seat-change queue is
// permanently empty says which seats are which.
//
// This is the DECISION half: when would a player ask? The request itself goes
// through the same RPC the client calls (services/supabase/seatChange.ts), and
// the once-per-stay budget is the database's `cash_game_roster.seat_change_
// used_at` - the same row a human spends - so nothing here can hand a horse a
// second change.
//
// The shape follows `wantsTableChange` above, because it is the same instinct
// one step short of leaving: a player who does not like this table asks to be
// moved before they give up on the game entirely.

/**
 * Nobody asks for a seat change in the first half hour.
 *
 * `wantsTableChange` waits 12 minutes before a player walks out of a game, and
 * this waits longer on purpose: asking the floor to move you is a considered
 * request about THIS table, and a player who does it ten minutes after sitting
 * down reads as a script rather than as somebody who has watched a few orbits.
 * It is also past MIN_SESSION_MINUTES (20) in HorseSessionRotator, so a horse
 * that will not be around long enough to enjoy the new seat never asks.
 */
export const SEAT_CHANGE_MIN_MINUTES = 25;

/** Everything the decision needs. Pure data: no clients, no queries. */
export interface SeatChangeSituation {
  horseId: string;
  tableId: string;
  /** The must-move game this table belongs to; null when it is not in one. */
  gameId: string | null;
  /** `tables.role` - 'feeder' or 'main'. */
  role: string | null;
  /** `tables.main_index` - 1 is the main game, which has no seat change. */
  mainIndex: number | null;
  /** `tables.lifecycle` - a 'breaking' table is already moving everyone. */
  lifecycle: string | null;
  seatedCount: number;
  minutesAtTable: number;
  /** How many OTHER tables of this game a change could go to (never Main 1). */
  otherTables: number;
  /**
   * This horse is on its way out - leaving, on a short break, already being
   * moved, or sat at a table that is draining. A player halfway out of the
   * door does not ask the floor to reseat them.
   */
  leaving: boolean;
  /** The once-per-stay change is already spent, listed, or was refused once. */
  changeUsed: boolean;
  nowMs?: number;
}

export type SeatChangeVerdict =
  | 'ask'
  | 'not_in_game'
  | 'main_one'
  | 'table_closing'
  | 'no_other_table'
  | 'too_new'
  | 'leaving'
  | 'used'
  | 'not_this_cycle';

/**
 * Would this horse ask for a seat change right now, and if not, why not?
 *
 * A VERDICT rather than a boolean because every refusal below is one the
 * database would also give (`SEAT_CHANGE_NOT_FROM_MAIN`,
 * `SEAT_CHANGE_TABLE_CLOSING`, `SEAT_CHANGE_NO_OTHER_TABLE`,
 * `SEAT_CHANGE_USED`), and a caller that can name the reason can decline
 * BEFORE spending a round trip on a refusal it could have predicted. Horses
 * are refused for the same reasons humans are; they simply do not need to be
 * told twice.
 *
 * The order matters: the structural refusals come first, so a horse on Main 1
 * reads 'main_one' rather than 'too_new' and the caller's log says something
 * true.
 */
export function seatChangeVerdict(s: SeatChangeSituation): SeatChangeVerdict {
  if (!s.gameId) return 'not_in_game';
  if (s.role === 'main' && s.mainIndex === 1) return 'main_one';
  if (s.lifecycle === 'breaking' || s.lifecycle === 'closed') return 'table_closing';
  if (s.otherTables <= 0) return 'no_other_table';
  if (s.changeUsed) return 'used';
  if (s.leaving) return 'leaving';
  if (s.minutesAtTable < SEAT_CHANGE_MIN_MINUTES) return 'too_new';

  /* THE RATE LIMIT. Deterministic in (horse, table, minute) exactly like
     wantsTableChange, so two passes inside the same minute cannot roll twice
     and a restart cannot re-roll a horse into asking immediately.

     A short-handed feeder is where a real player asks to be moved - the game
     is dying and the other table is not - so the base rises as the table
     empties. At a full table it is rare, because a full table is the game
     they wanted.

     Per 90-second cycle, over the ~35 eligible cycles of an average session:
     roughly 6% of horses on a full feeder ask, 18% on a middling one, 33% on
     a short-handed one. A minority, which is what the human number looks
     like - most players never touch the button. */
  const base = s.seatedCount <= 3 ? 0.012 : s.seatedCount <= 5 ? 0.006 : 0.002;
  /* The same restlessness trait `wantsTableChange` reads, and deliberately
     the same one rather than an independent salt: a player who fancies a
     change of table is the player who asks for a change of seat. */
  const restless = 0.5 + ((horseHash(s.horseId) >>> 9) % 1000) / 1000;
  const minute = Math.floor((s.nowMs ?? Date.now()) / 60_000);
  const h = horseHash(`${s.horseId}:${s.tableId}:seatchange:${minute}`);
  const roll = (h % 10_000) / 10_000;
  return roll < base * restless ? 'ask' : 'not_this_cycle';
}

/** The boolean form, for a caller that does not care why not. */
export function wantsSeatChange(s: SeatChangeSituation): boolean {
  return seatChangeVerdict(s) === 'ask';
}

/**
 * THE MEMO DIES WITH THE STAY (2026-09-09).
 *
 * The rotator remembers every (game, horse) pair it has asked the door about
 * so a refused horse is not re-asked every ninety seconds, and it holds a
 * final refusal (SEAT_CHANGE_USED, NOT_FROM_MAIN, ...) for twelve hours. But
 * the budget the door spends is PER STAY: `cash_game_roster` opens a fresh row
 * with a fresh `seat_change_used_at` when a player leaves a game and comes
 * back, so a person who cashes out at lunch and sits again at dinner has a
 * seat change again. A memo keyed on the game alone outlived the stay - a
 * horse that left and rejoined inside the twelve hours was never asked
 * again, which is a horse denied a button a human has (CLAUDE.md 10.5).
 *
 * So the memo is pruned against the room every pass: an entry is kept only
 * while it has not expired AND the horse still holds a seat in that game.
 * `seated` is the set of `${gameId}:${horseId}` pairs seated right now.
 * Returns how many entries were dropped because the stay had ended.
 */
export function pruneSeatChangeMemo(
  memo: Map<string, number>,
  seated: ReadonlySet<string>,
  nowMs: number
): number {
  let ended = 0;
  for (const [key, until] of [...memo]) {
    if (until <= nowMs) {
      memo.delete(key);
      continue;
    }
    if (!seated.has(key)) {
      memo.delete(key);
      ended++;
    }
  }
  return ended;
}

/**
 * `tables.settings.retire_when_empty` - the row is being wound down: nobody is
 * seated there any more and every horse on it is walked out. Set by the
 * 2026-09-03 "close any tables over 2/5" migration on the running tables it
 * could not close outright; read here and in HorseFleetManager. Anything but
 * a literal true is false: a missing or malformed settings blob is an ordinary
 * table, never a retiring one.
 */
export function isRetiringTable(row: { settings?: unknown } | null | undefined): boolean {
  const settings = row?.settings;
  if (!settings || typeof settings !== 'object') return false;
  return (settings as { retire_when_empty?: unknown }).retire_when_empty === true;
}

/**
 * PARKED FOR THE NIGHT, not retired (Dan 2026-09-04: "fewer tables, more
 * players at each table. late night shouldn't have any 2-3 handed games").
 *
 * A parked table drains and closes exactly like a retiring one - no new
 * horses, nobody moved, closed only once genuinely empty - and differs in one
 * way that matters: it COMES BACK. The Stable Hand executor lifts the flag and
 * reopens it every cycle outside the night window, and the fleet reopens it at
 * boot for the same reason. Retirement is permanent by design; a night that
 * used the retirement flag would delete the floor.
 */
export function isNightParkedTable(row: { settings?: unknown } | null | undefined): boolean {
  const settings = row?.settings;
  if (!settings || typeof settings !== 'object') return false;
  return (settings as { night_parked?: unknown }).night_parked === true;
}
