/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE FLEET MANAGER — Server-Side Cash Table Seeding
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the fleet of horses across ALL cash game tables:
 * - Creates cash tables from predefined configs if they don't exist
 * - Seats available horses at tables to maintain target occupancy
 * - Manages horse departures/arrivals to simulate real traffic
 * - Tracks fleet health (available, seated, stuck)
 * - Runs as part of the server — ZERO browser dependency
 *
 * NOTE: "Horses" — NEVER call them anything else.
 */

import { supabase } from './supabase.js';
import { isChipFleetTable } from './HorseFleetFundingBoundary.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import {
  bodiesOnHostFrom,
  chicagoNow,
  hostAllowsNewBody,
  stableHandHostCaps,
} from './StableHandController.js';
import {
  WALLETS_FOR_HOST,
  controllerEnabled,
  isNightWindow,
  killed as stableHandKilled,
  type SitRejection,
} from './StableHand.js';
import {
  tagBook,
  tagKey,
  chicagoCounterDay,
  tagAllowsCash,
  tagAllowsVariant,
  tagAllowsStake,
  tagMaxTables,
  isRestDayFor,
  dailyCapReached,
} from './StableHandTags.js';
import {
  foldMutations,
  writeStateRows,
  MINUTES_ACCRUAL_MS,
  type StateMutation,
} from './StableHandState.js';
import { beatVerdict, lastBeatAt } from './StableHandBeats.js';
import { seatBoosts, takeOpenOrders } from './StableHandPlanBus.js';
import { stakeForBand } from './StableHandController.js';
import { fetchAllRows } from './supabase/pagination.js';
import {
  allocateBuyers,
  FEEDER_BUYERS_TO_GO_LIVE,
  FULL_TABLE_BUYER_PROBE,
  type BuyerPool,
} from './HorseBuyerAllocation.js';
import {
  buildBookingLoad,
  mayEnterAnotherGame,
  refusalReason,
  remainingGameCapacity,
} from './HorseGameLoad.js';
import { classifyBuyInRefusal, formatRefusals, type BuyInRefusal } from './HorseBuyInRefusal.js';
import {
  doorsFromRows,
  isStillSeatable,
  staleSnapshotLine,
  unknownDoors,
  type DoorSnapshot,
} from './HorseStaleTable.js';
import {
  applyRejoinFloor,
  buildRejoinConstraints,
  EMPTY_REJOIN_CONSTRAINTS,
  rejoinPlayerKey,
  rejoinTableKey,
  type RejoinConstraints,
} from './HorseRejoinConstraints.js';
import { buildDisabledGameIds, isTableOfDisabledGame } from './HorseDisabledGames.js';
import { reportError } from './errorReporter.js';
import { clampSeatsForVariant, maxSeatsForVariant } from '../config/tableSeating.js';
import { bankrollBuyIn, bankrollPolicyFor, canSit, referenceBuyIn } from './HorseBankroll.js';
import {
  bankrollCounters,
  bankrollEvent,
  bankrollSummaryLine,
  type BankrollEvent,
} from './HorseBankrollTelemetry.js';
import {
  formatSkipCounts,
  gameKeyForTable,
  isMutexRejection,
  sitVerdictFor,
  type SitSkipReason,
  type SitVerdict,
  type SitVerdictContext,
} from './HorseSitVerdict.js';
import {
  applyStakeBandSupply,
  buyInBBFor,
  gameLaneFor,
  horseHash,
  isActiveNow,
  isNightParkedTable,
  isRetiringTable,
  occupancyTargetFor,
  stakeBandAllows,
  stakeBandFor,
  stakeBandForBigBlind,
  type HorseStakeBand,
} from './HorseBehavior.js';
import {
  applyBias,
  capBySeatedCount,
  FLEET_POLICY_DEFAULTS,
  getFleetPolicy,
  withheldReason,
  type FleetPolicy,
} from './HorseFleetPolicy.js';
import { DEALABLE_MINIMUM, refusesLoneSeat, seatsToDealable } from './HorseLoneTable.js';

/**
 * Everything `resolveSeatClub` needs to answer "which wallet pays for this
 * horse at this table", built once per seeding cycle. See the note on the
 * `union_clubs` read in seedAllTables for why it exists.
 */
interface SeatClubContext {
  /** The clubs whose wallets may pay for a seat at this table (the DB rule). */
  eligibleClubsFor: (t: { club_id?: string | null; union_id?: string | null }) => string[];
  /** The scope a "one club at a time" seat is held in: the union, else the club. */
  tableScope: (t: { club_id?: string | null; union_id?: string | null }) => string;
  /** horse id -> scope -> the club its EARLIEST open seat in that scope draws from. */
  seatClubInScope: Map<string, Map<string, string>>;
  /** horse id -> the clubs it holds an active/approved membership in. */
  memberships: Map<string, Set<string>>;
  /** false when the membership read was incomplete this cycle: unknown, not empty. */
  known: boolean;
}

/**
 * One row of `ca_horse_fleet_state`, built from what the cycle already read.
 *
 * A field the cycle does not genuinely know is NULL, never a plausible guess.
 * `last_action_at` and `hands_this_session` belong to the dealing loop, and
 * `session_started_at` belongs to HorseSessionRotator - the seeding cycle has
 * read none of them, and a seat's `joined_at` is when this horse sat at THIS
 * table, not when its session began, so sending it as a session start would
 * be a number the console would then reason with. See the Phase 3 contract:
 * "if a field is genuinely unknown this cycle, send null, never a guess".
 */
interface FleetStateRow {
  horse_id: string;
  state: 'idle' | 'seated' | 'suspended';
  club_id: string | null;
  table_id: string | null;
  seat_index: number | null;
  stack: number | null;
  lane: string | null;
  stake_band: string | null;
  bankroll: number | null;
}

/**
 * What THIS cycle knows, carried out to the heartbeat in `finally`.
 *
 * Declared outside the try because every early return in seedAllTables is
 * still a cycle the console has to be able to see: a fleet that seeds nothing
 * because the seat map came back truncated must not look the same from the
 * outside as a fleet an operator switched off.
 */
interface CycleBeat {
  reason: string | null;
  degraded: boolean;
  policyVersion: string | null;
  horsesTotal: number | null;
  horsesSeated: number | null;
  tablesSeen: number | null;
  tablesSeeded: number | null;
  seatsFilled: number;
  withheldTables: number;
  /** Cluster tables skipped this cycle because their game is switched off (18.4). */
  disabledGameTables: number;
  /** 1 when the disabled-games read failed or came back short; the cycle then
   *  treated NO game as disabled (fail open), and the beat has to say so. */
  disabledGamesReadFailed: number;
  /** Cluster tables this cycle refused to seat into because the door re-read
   *  (see HorseStaleTable) found them no longer seatable - closed or breaking
   *  since the open-table list was read at the top of the cycle. */
  staleTablesSkipped: number;
  /** 1 when the door re-read failed or came back short; the cycle then seated
   *  on the top-of-cycle snapshot exactly as before (fail open). */
  staleDoorReadFailed: number;
  /** 1 when the tournament-booking read failed or came back short; the cycle
   *  then counted NO bookings (fail open), which is the position the fleet was
   *  in before 2026-09-06 - so the beat has to say so. See HorseGameLoad. */
  bookingsReadFailed: number;
  /** Horse/table pairs the four-game limit refused this cycle BEFORE a buy-in
   *  was attempted: the horse is committed to four games already, counting its
   *  tournament bookings the way the database counts them. */
  bookedOut: number;
  /** One entry per opening feeder this cycle reached: what the fleet counted,
   *  what it selected, what it seated and why it skipped the rest. */
  openingFeeders: OpeningFeederDiag[];
  /** Horses holding a seat on the open CASH floor this cycle. `horsesSeated`
   *  counts every open seat on the platform, tournament chairs included, so
   *  on a day the tournaments are stuck it reads 654 while the cash floor
   *  holds 172 (measured 2026-09-09). The console needs both numbers. */
  horsesSeatedCash: number | null;
  /** WHY THE FLOOR IS THE SIZE IT IS, by gate, horse/table pairs per cycle.
   *  Until 2026-09-09 every one of these reached the console log and none of
   *  them reached the heartbeat, so the operator console could see
   *  `seats_filled 0, reason nothing_to_seat` and nothing else. Null until
   *  the cycle reaches the seeding loop. */
  gates: CycleGateCounts | null;
  rows: FleetStateRow[];
}

/**
 * The per-cycle refusal counters, exactly the ones the cycle line prints, in
 * one object the heartbeat carries as `detail.gates`. Every value is a count
 * of horse/table PAIRS refused at that gate this cycle (the same pair is
 * refused at most once, by the first gate that says no), except `asleep`,
 * which is counted per table from the sittable pool. `fn_ca_fleet_state_upsert`
 * stores `detail` as the jsonb object it is handed, so nothing here needs a
 * migration.
 */
interface CycleGateCounts {
  no_membership: number;
  barred: number;
  tag: number;
  stranded_tag_fallthrough: number;
  rest_day: number;
  daily_cap: number;
  floor_unaffordable: number;
  host_cap: number;
  booked_out: number;
  /** The horse's OWN cash-table ceiling (its tag), the rule that was never
   *  counted: `mayEnterAnotherGame` refused for `own_ceiling` in silence. */
  own_ceiling: number;
  /** Sittable horses left out of a table's pool because the hour is outside
   *  their activity window. This is the number "No available horses" hid. */
  asleep: number;
  /** Tables whose awake pool could not reach the dealable minimum and were
   *  filled from the whole sittable pool instead (the widened hour). */
  hour_widened: number;
  lone_seat_refused: number;
  lone_seat_left: number;
  stale_tables_skipped: number;
  unsittable: Record<string, number>;
  seat_stage_skipped: Record<string, number>;
  mutex_refused: Record<string, number>;
  buy_in_refused: Record<string, number>;
  bankroll: Record<string, number>;
}

/**
 * WHAT HAPPENED TO ONE OPENING FEEDER (2026-09-05). Two games opened a feeder
 * every five minutes with "buyers": 2, no horse ever sat, and the engine log
 * had no line about either of them: every refusal in the seat stage was a
 * silent `continue`. This is the line that was missing. Logged once per
 * opening feeder per cycle, and published in the beat detail.
 */
interface OpeningFeederDiag {
  table_id: string;
  name: string;
  /** Horses left after the cheap candidate gates (club, door, tag, roll, host cap). */
  candidates: number;
  /** Horses left after the sit verdict - the number the controller is told. */
  sittable: number;
  /** Seats this cycle meant to fill (seatsNeeded). */
  wanted: number;
  /** Horses this feeder has FIRST CLAIM on in the buyer allocation - the two
   *  18.3 promotes it at, less whoever already sat. The claim it was opened
   *  on; see HorseBuyerAllocation. */
  reserved: number;
  empty_seats: number;
  selected: number;
  seated: number;
  /** Sit-verdict refusals, count-stage and seat-stage together, by reason. */
  skipped: Record<string, number>;
  /** Set when the table never reached the candidate filter. */
  withheld: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableConfig {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  horsesPerTable: number;
  gameVariant: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASH GAME TABLE CONFIGS — Every Stake Level × Every Game Type
// ═══════════════════════════════════════════════════════════════════════════════

/* MIDWAY_UNION_ID IS GONE (2026-09-09). It was the union every cash table
   used to be inserted under, and Gate 7 deleted every table writer in this
   file - the constant then sat here with exactly one reference, its own
   declaration, which is the shape an agent "wires back up". A table's union
   is read from the row (`t.union_id`) by `eligibleClubsFor`, which is the
   only thing that ever needed to know. */

// Legacy club IDs, still read: they seed the set of clubs the bankroll loader
// pages (see clubIdsToLoad), and one of them is passed to seatHorse as the
// wallet when resolveSeatClub picks it.
const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const JAQK_CLUB_ID = 'a0000000-0000-0000-0000-000000000001';

/** The platform's ceiling on tables per horse. A tag may lower it, never
 *  raise it (tagMaxTables). Module-level so the sit verdict and the
 *  candidate filter read the same number. */
const MAX_TABLES_PER_HORSE = 4;

/**
 * The table statuses under which a held seat no longer decides the wallet -
 * verbatim from `fn_seat_club_for_user_membership_unchecked`:
 * `lower(coalesce(t2.status,'')) NOT IN ('closed','completed','cancelled','finished')`.
 * Read 2026-09-09 from pg_proc. If the function's list changes, this one must.
 */
export const HELD_SEAT_HISTORY_STATUSES: ReadonlySet<string> = new Set([
  'closed',
  'completed',
  'cancelled',
  'finished',
]);

/**
 * How old the buyer census may be before it answers zero. A cycle is 30 s
 * plus its own run time (measured 19-118 s), so two consecutive cycles fit
 * inside this with room; a census older than it means the fleet has not
 * completed a walk of the floor in five minutes and is not seating anyone.
 * See lastEligibleBuiltAt.
 */
export const ELIGIBLE_MAX_AGE_MS = 5 * 60 * 1000;
const EMPTY_CENSUS: ReadonlyMap<string, number> = new Map();

// V3 (2026-07-23): ALL 7 approved variants now spawn cash tables. The V2/V3
// engine is verified on every variant (legality fuzz + full-hand simulation +
// production burn-in on NLH), so "quality before scaling" is satisfied —
// scaling is now on.
const DEFAULT_TABLES: TableConfig[] = [
  {
    name: 'NLH 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 9,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 2.00/5.00',
    smallBlind: 2.0,
    bigBlind: 5.0,
    maxPlayers: 9,
    horsesPerTable: 5,
    gameVariant: 'nlh',
  },
  /* THE HIGH-STAKES LADDER, CAPPED AT 25/50 (Dan 2026-09-03: "ADD THE HIGHER
     STAKES FOR MIDWAY UNION, CAP IT AT 25-50").

     Until today the union's cash ladder stopped at 2/5 - three tables, all
     nine of nine - while the population that could play higher sat idle:
     measured 2026-09-03, 48 high-band horses across Shark, JAQK and Midway,
     every one of them rolled for 5/10 and 10/20 under HorseBankroll's
     buy-ins-to-sit rule and 35 of them for 25/50. stakeBandForBigBlind puts
     every big blind above 6 in the 'high' band, so these four rungs share one
     pool of about thirty cash-lane horses; four configs at up to three tables
     each is what that pool can keep populated, and 25/50 is the top by
     order. Anything above it is not added here and must not be. */
  {
    name: 'NLH 5.00/10.00',
    smallBlind: 5.0,
    bigBlind: 10.0,
    maxPlayers: 9,
    horsesPerTable: 5,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 10.00/20.00',
    smallBlind: 10.0,
    bigBlind: 20.0,
    maxPlayers: 9,
    horsesPerTable: 5,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 25.00/50.00',
    smallBlind: 25.0,
    bigBlind: 50.0,
    maxPlayers: 9,
    horsesPerTable: 5,
    gameVariant: 'nlh',
  },
  {
    name: 'PLO4 5.00/10.00',
    smallBlind: 5.0,
    bigBlind: 10.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'plo4',
  },
  {
    /* THE STRADDLE FLAG IS GONE (2026-09-05). This entry carried
       `straddleEnabled: true` from V23, when the fleet still inserted tables
       and wrote `straddle_enabled` onto them. Ruling R2 retired the lane, Gate
       7 deleted every table writer in this file, and Gate 5's snapshot applier
       now forces straddle_enabled, auto_utg_straddle and voluntary_straddle
       false on every cash table each tick. So the field had no reader at all -
       a switch on a wall connected to nothing, which is the shape of config an
       agent restores by "wiring it up". It is deleted rather than left
       declared; the name below is a fleet CONFIG KEY, not a live game.
       Pinned by LeaguePmAndStraddle.test.ts. */
    name: 'NLH Straddle 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 9,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  {
    name: 'PLO4 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'plo4',
  },
  {
    name: 'PLO5 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    // The law: plo5 is 7-max. This said 8, and 83 such tables reached
    // production. See server/src/config/tableSeating.ts.
    maxPlayers: 7,
    horsesPerTable: 5,
    gameVariant: 'plo5',
  },
  {
    name: 'PLO6 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    // The law: plo6 is 6-max. This said 7.
    maxPlayers: 6,
    horsesPerTable: 5,
    gameVariant: 'plo6',
  },
  {
    name: 'PLO8 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'plo8',
  },
  {
    name: 'Short Deck 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'short_deck',
  },
  {
    name: 'Pineapple 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'pineapple',
  },
];

/* MAX_TABLES_PER_CONFIG is GONE (Gate 7, 2026-09-05): the cap on a game's
   tables is cash_games.cap_mains, read by the controller. */

// ═══════════════════════════════════════════════════════════════════════════════
// V8 HUMANIZATION HELPERS (2026-07-24)
// The old fleet was robotically uniform: every horse bought in for exactly
// 100bb, tables filled to target instantly in one 30s cycle, and the
// fewest-tables sort made the same horses appear in the same order forever.
// These helpers give each horse a stable personality for HOW it shows up:
//  - a deterministic buy-in profile (short-stacker / standard / deep) with
//    per-sitting jitter, clamped to the table's real min/max buy-in
//  - a daily activity window (hash-derived start hour + length) so the
//    population on the floor rotates through the whole stable instead of
//    the same few dozen
//  - staggered arrivals: at most 1-2 horses join a table per cycle, so
//    tables fill the way real tables fill (except when a HUMAN is seated
//    short-handed — rescuing a human's game outranks realism pacing)
// ═══════════════════════════════════════════════════════════════════════════════

// (Pure helpers live in HorseBehavior.ts — dependency-free for unit tests.)

// ═══════════════════════════════════════════════════════════════════════════════
// HORSE FLEET MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class HorseFleetManager {
  private isRunning = false;
  private seedInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Every background seeding promise owned by this service. Clearing the
   * interval only prevents the next pass; it does not stop the pass that has
   * already crossed an await and may still buy a seat. Shutdown therefore
   * fences the generation synchronously, then joins this set to a fixed point
   * before the GameServer may release leadership.
   */
  private readonly lifecycleJobs = new Set<Promise<unknown>>();
  private lifecycleGeneration = 0;
  private stopOperation: Promise<void> | null = null;
  /**
   * The game keys each horse held at the END of the previous cycle.
   *
   * A key that was there and is not now is a seat GIVEN UP, and that is what
   * opens the two-hour window on it. Diffed here rather than hooked onto a
   * leave path because every exit lands in this map - a stand, a session end,
   * a bust, a table closing - and only the ones that hooked a code path would
   * land on a listener.
   */
  private previousSeatKeys = new Map<string, Set<string>>();
  /** When minutes-played was last accrued. See MINUTES_ACCRUAL_MS. */
  private lastMinutesAccrualAt = 0;
  /** When the Stable Hand controller's heartbeat was last checked. */
  private lastBeatCheckAt = 0;
  private lastBeatComplaint: string | null = null;
  /** When the unread-tag-book alert was last raised. Throttled to hourly. */
  private lastTagBookComplaintAt = 0;
  /** When the failing-counter-write alert was last raised. Throttled to hourly. */
  private lastStateWriteComplaintAt = 0;
  private seeding = false; // Prevents concurrent seeding
  /** Per table, how many horses the last cycle found able to sit there.
   *  Read by the ClusterController (OPORD 1.4 18.3): a horse is a buyer. */
  private lastEligibleByTable = new Map<string, number>();

  /** How many horses could sit at this table, as of the last seeding cycle.
   *  0 when the table was not in the cycle (closed, breaking, surplus), and 0
   *  for every table once the census is older than ELIGIBLE_MAX_AGE_MS. */
  eligibleHorseCount(tableId: string): number {
    if (this.censusIsStale()) return 0;
    return this.lastEligibleByTable.get(tableId) ?? 0;
  }

  /** The whole census, table id -> eligible horses, as of the last cycle.
   *  The ClusterController sends it with every pass (one RPC, keyed by
   *  Main 1) so the SQL can look each game's horse demand up itself. The map
   *  is swapped whole per cycle, never mutated, so handing it out is safe.
   *  Empty once the census is stale - see lastEligibleBuiltAt. */
  eligibleCounts(): ReadonlyMap<string, number> {
    if (this.censusIsStale()) return EMPTY_CENSUS;
    return this.lastEligibleByTable;
  }

  private censusIsStale(now: number = Date.now()): boolean {
    return now - this.lastEligibleBuiltAt > ELIGIBLE_MAX_AGE_MS;
  }

  /** Tests only: age the census by hand. */
  __setCensusBuiltAtForTest(ms: number): void {
    this.lastEligibleBuiltAt = ms;
  }
  private overrunTicks = 0; // 30s ticks dropped because the previous cycle was still running
  /** Seeds the per-sitting buy-in jitter for the WHOLE cycle, so the count
   *  and the chair size the same buy-in (buyInBBFor). Set at cycle start. */
  private cycleSittingSeed = '0';
  /**
   * When `lastEligibleByTable` was last rebuilt from a full walk of the floor.
   *
   * THE CENSUS DECAYS (2026-09-06). Every fail-closed early return in
   * seedAllTables - an incomplete table list, seat map, union map or horse
   * pool, and the outer catch - used to leave the PREVIOUS cycle's map in
   * place with nothing saying how old it was. The ClusterController ticks
   * twelve times a minute on that map, and the SQL open rule counts its
   * numbers as buyers: a fleet that cannot read the floor kept telling every
   * full game that two horses were ready to sit, and the controller kept
   * opening feeders nobody could fill (six minutes to abandon, two to rest,
   * open again). A census older than ELIGIBLE_MAX_AGE_MS answers zero, which
   * is the truth about a fleet that is not seating anyone.
   */
  private lastEligibleBuiltAt = 0;
  /* Last time a failed fleet-state publish was reported. The engine can ship
     before the World Hub migration that creates fn_ca_fleet_state_upsert, and
     an unthrottled report would file one Sentry event and one console line
     every 30 seconds for ever, which is how a real signal becomes noise. */
  private lastStatePublishReportAt = 0;
  /**
   * When the fleet last recorded a COMPLETE cycle beat, and how many
   * consecutive cycles have seated nobody with seats going spare.
   *
   * Dan 2026-09-11: "I SHOULD GET PUSH NOTIFICATIONS OR TEXT IF ANYTHING
   * INSIDE THE HORSES IS FAILING OR THEY CAN'T PLAY." A fleet that has
   * stopped beating is the purest form of "they can't play", and until now
   * nothing outside this process could see it: `ca_horse_fleet_heartbeat` is
   * a table, and no alert rule reads tables. Measured on the live beat rows,
   * 24 hours to 2026-09-11: gap p50 30 s, p95 51 s, the hourly break 447-632
   * s, and ONE gap of 2,461 s at 01:33 UTC when the seeding loop was simply
   * gone for 41 minutes. Nothing fired, and nobody knew until a human looked
   * at the floor. Published as `poker_horse_fleet_heartbeat_age_seconds` by
   * GameServer's metrics endpoint.
   */
  private lastBeatAtMs = 0;

  /** Seconds since the last completed seeding cycle beat; -1 before the first
   *  (a fleet that has never beaten is not a fleet that is 0 seconds fresh). */
  heartbeatAgeSeconds(nowMs: number = Date.now()): number {
    if (this.lastBeatAtMs === 0) return -1;
    return Math.max(0, Math.round((nowMs - this.lastBeatAtMs) / 1000));
  }
  /* Read by the bankroll loader only (clubIdsToLoad); see the note above the
     club id constants. */
  private clubIds = [SHARK_CLUB_ID, JAQK_CLUB_ID];

  /* getNextClubId() IS GONE (2026-09-09). It round-robined a club id onto a
     table this file was about to INSERT, and Gate 7 (2026-09-05) removed
     every insert. It had no caller left - dead code on the seeding path,
     holding a mutable cursor nothing advanced. The wallet a seat is bought
     from is decided by resolveSeatClub, which asks the database's own rule
     rather than taking turns. */

  // ─────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────

  private lifecycleIsCurrent(generation: number): boolean {
    return this.isRunning && this.lifecycleGeneration === generation;
  }

  private trackLifecycleJob<T>(job: Promise<T>): Promise<T> {
    const tracked = job.finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
    return tracked;
  }

  private launchSeedCycle(generation: number, context: string, successMessage?: string): void {
    if (!this.lifecycleIsCurrent(generation)) return;
    void this.trackLifecycleJob(this.seedAllTables(generation))
      .then(() => {
        if (successMessage) console.log(successMessage);
      })
      .catch((err) => reportError(err, context));
  }

  private async drainLifecycleJobs(): Promise<void> {
    // A finishing pass may schedule/chain another owned promise before its
    // finally handler runs. Re-snapshot until the ownership set is truly empty.
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  async start(): Promise<void> {
    // A same-instance restart may only begin after the prior generation has
    // completely joined. GameServer normally creates one generation, but this
    // makes the service contract sound in tests and supervised restarts too.
    if (this.stopOperation) await this.stopOperation;
    if (this.isRunning) {
      console.log('[HorseFleet] Already running');
      return;
    }

    this.isRunning = true;
    const generation = ++this.lifecycleGeneration;
    console.log('[HorseFleet] Starting fleet manager...');

    // Ensure all tables exist (fast — just inserts)
    await this.ensureAllTablesExist();
    if (!this.lifecycleIsCurrent(generation)) return;

    // Kick off initial seeding in background — DON'T block the server
    this.launchSeedCycle(
      generation,
      'HorseFleet.Initial_seeding_error',
      '[HorseFleet] Initial seeding complete'
    );

    // Recurring check: every 30 seconds, ensure horses are seated
    // Overlap guard — see HorseLifecycleManager. seedAllTables has its own
    // `seeding` flag, so this is belt-and-braces for the wrapper.
    this.seedInterval = setInterval(() => {
      // THE FREEZE (Dan 2026-09-01): seeding is a seat INSERT and a buy-in -
      // chips moving under a break screen. The felt refills on the first
      // cycle after the thaw, thirty seconds into resumed play at most.
      if (isMaintenanceFrozen()) return;
      /* A tick that finds the previous cycle still running is DROPPED by the
         `seeding` guard inside seedAllTables. Count it here so the cycle can
         say, when it finally ends, how many refills it cost - on 2026-09-02 a
         cycle ran for 47 minutes and nothing said so. */
      if (this.seeding) {
        this.overrunTicks++;
        return;
      }
      this.launchSeedCycle(generation, 'HorseFleet.Seed_cycle_error');
    }, 30000);

    console.log('[HorseFleet] Running - seeding in background, checking every 30s');
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;

    // This is the synchronous ownership fence. No await may precede it.
    this.isRunning = false;
    this.lifecycleGeneration++;
    if (this.seedInterval) {
      clearInterval(this.seedInterval);
      this.seedInterval = null;
    }

    const drain = (async () => {
      await this.drainLifecycleJobs();
      console.log('[HorseFleet] Stopped');
    })();
    const trackedStop = drain.finally(() => {
      if (this.stopOperation === trackedStop) this.stopOperation = null;
    });
    this.stopOperation = trackedStop;
    return trackedStop;
  }

  // ─────────────────────────────────────────────────────────────────────
  // ENSURE ALL TABLES EXIST IN DATABASE
  // ─────────────────────────────────────────────────────────────────────

  /**
   * HOW MANY REAL PEOPLE ARE WAITING FOR EACH TABLE.
   *
   * Dan 2026-09-02 turns on this number and nothing else: a horse gets up when
   * a human is on the list, and for no other reason. One query for the whole
   * floor, so the per-table loop stays free.
   *
   * `waiting` and `notified` both count. A notified row is a seat already
   * being HELD for that person, so the seat it needs is spoken for; leaving it
   * out would have the fleet fill the very seat the queue is about.
   *
   * Horse rows are excluded by id rather than by a database flag, because this
   * manager already knows exactly which ids are horses, and a horse in the
   * count would make a horse stand up for a horse.
   *
   * Fails CLOSED at zero: if the queue cannot be read, nobody is asked to
   * leave. The cost of that is a person waiting one more cycle; the cost of
   * failing the other way is horses standing up off every table on the floor
   * because one query timed out.
   *
   * This replaced `ensureWaitlist`, which seeded horses INTO queues to make a
   * full table look wanted. Under the new rule that is exactly backwards: the
   * queue is now the release signal, so a horse in it would delay the person
   * it is supposed to be making room for.
   */
  private async humansWaitingByTable(horseIdSet: Set<string>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      /* PAGED (2026-09-06). A bare `.select()` is capped at db-max-rows (1,000)
         by PostgREST WITHOUT erroring - the truncation this file documents
         three times for `tables`, `table_seats` and `club_members` and never
         applied here. This queue reached 10,004 rows on 2026-08-31, and the
         consequence of truncating THIS read is the worst of the three: a human
         past the cap is invisible, `humansWaiting` reads 0 for their table,
         `occupancyTargetFor` never subtracts their seat, and the 2026-09-02
         release rule - the ONLY thing that stands a horse up - silently stops
         working for them. Keyset on id. */
      const page = await fetchAllRows<{ id: string; table_id: string; user_id: string }>(
        (cursor, want) => {
          let q = supabase
            .from('table_waitlist')
            .select('id, table_id, user_id, status')
            .in('status', ['waiting', 'notified'])
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.humansWaiting', maxRows: 50_000 }
      );
      if (!page.complete) {
        // Fails CLOSED, as the original did on error: nobody is asked to leave
        // on a half-read queue. One more cycle of waiting costs a person 30
        // seconds; the other direction stands horses up off the whole floor.
        console.warn(
          '[HorseFleet] waitlist read incomplete - nobody is asked to leave this cycle.'
        );
        return new Map();
      }
      for (const r of page.rows) {
        if (!r.table_id || !r.user_id) continue;
        if (horseIdSet.has(r.user_id)) continue;
        out.set(r.table_id, (out.get(r.table_id) ?? 0) + 1);
      }
    } catch (err) {
      reportError(err, 'HorseFleet.humansWaitingByTable');
      return new Map();
    }
    return out;
  }

  /**
   * Dan 2026-08-26: "the 3rd image says there are 54 waiting — fix this bug."
   *
   * ensureWaitlist only ever GREW the queue. Nothing removed a horse's row
   * when the vibe cooled or the table drained, so queues inflated without
   * bound and a table with open seats could show dozens "waiting" — real DB
   * rows, all of them horses, none of them ever going to sit. This is the
   * missing half: horse rows beyond what the current vibe wants are marked
   * 'cleared'. Human rows are NEVER touched here — a person's place in line
   * is theirs until they sit, leave, or their seat offer expires.
   *
   * 2026-09-02, twice over. Horses no longer queue at all (waitTarget is 0
   * everywhere - see occupancyTargetFor), so "prune to the target" became
   * "clear every horse row". And this used to run once PER TABLE inside the
   * seeding loop: one SELECT per table, in sequence, 1,131 tables, on a
   * database answering in seconds - a 47-minute cycle measured on the live
   * engine, during which the floor only drained. It is now ONE read of every
   * live waitlist row and one batched UPDATE, before the loop.
   *
   * Human rows are NEVER touched here — a person's place in line is theirs
   * until they sit, leave, or their seat offer expires.
   */
  private async pruneHorseWaitlist(horseIdSet: Set<string>): Promise<void> {
    try {
      /* PAGED (2026-09-06), same reason as humansWaitingByTable above and with
         a sharper edge: this method's whole job is to DRAIN the queue, and a
         1,000-row cap meant it could only ever clear the first 1,000 horse
         rows per cycle. The 10,004-row queue this was written for could not be
         drained by the thing written to drain it. */
      /* ── A NOTIFIED ROW IS AN OFFER, NOT A QUEUE ENTRY (2026-09-06) ────────
         This cleared `waiting` AND `notified` horse rows, and `notified` means
         a seat is being HELD for that horse for sixty seconds - the platform's
         own offer, made by `fn_offer_open_seat`. Clearing it is the platform
         withdrawing an offer it just made, and it ran BEFORE
         `claimOfferedSeats` in the same cycle, which reads `notified` and
         nothing else. So the method Dan asked for on 2026-08-31 - "MAKE HORSES
         ANSWER A SEAT CALL... THEY SHOULD NEVER BE SKIPPED" - could never find
         a row to answer. Structurally dead, and dead in the direction the law
         forbids: a human's offer stands and a horse's did not (10.5).

         Only `waiting` is pruned now. The queue still holds no horses (Dan
         2026-09-02: horses do not queue, waitTarget is 0 everywhere), and an
         offer the platform has already made is honoured. An offer nobody
         answers still expires on `fn_offer_open_seat`'s own sweep. */
      const page = await fetchAllRows<{ id: string; user_id: string }>(
        (cursor, want) => {
          let q = supabase
            .from('table_waitlist')
            .select('id, user_id, status')
            .eq('status', 'waiting')
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.pruneWaitlist', maxRows: 50_000 }
      );
      const excess = page.rows
        .filter((r) => horseIdSet.has(r.user_id as string))
        .map((r) => r.id as string);
      if (excess.length === 0) return;
      // Chunked so the request line stays sane if a queue ever inflates again
      // (10,004 horse rows on 2026-08-31).
      for (let i = 0; i < excess.length; i += 200) {
        const { error: updErr } = await supabase
          .from('table_waitlist')
          .update({ status: 'cleared' })
          .in('id', excess.slice(i, i + 200));
        if (updErr) throw new Error(updErr.message);
      }
    } catch (err) {
      reportError(err, 'HorseFleet.pruneHorseWaitlist');
    }
  }

  /**
   * THE WALLET THAT PAYS FOR THIS HORSE AT THIS TABLE - the engine's copy of
   * `fn_seat_club_for_user`, so the roll it gates on, the buy-in it sizes and
   * the p_club_id it sends are all the same wallet the database debits.
   *
   *   a club id  - the wallet; passed to atomic_table_buyin as p_club_id
   *   null       - no membership of this horse can pay here: NOT A CANDIDATE
   *   undefined  - the membership map did not load this cycle: unknown, and
   *                the database decides alone (fail open, like the bankroll
   *                gate - a read that failed must never empty the floor)
   *
   * Order mirrors the function: a seat already held in this scope wins, then
   * a stable pick among the memberships that qualify. The pick is the engine's
   * own hash rather than the database's, which is why it is SENT as p_club_id
   * instead of merely predicted.
   */
  private resolveSeatClub(
    ctx: SeatClubContext,
    table: { club_id?: string | null; union_id?: string | null },
    horseId: string
  ): string | null | undefined {
    const eligible = ctx.eligibleClubsFor(table);
    if (eligible.length === 0) return null;
    const held = ctx.seatClubInScope.get(horseId)?.get(ctx.tableScope(table));
    if (held && eligible.includes(held)) return held;
    if (!ctx.known) return undefined;
    const mine = eligible.filter((c) => ctx.memberships.get(horseId)?.has(c));
    if (mine.length === 0) return null;
    return mine[horseHash(horseId) % mine.length];
  }

  private async ensureAllTablesExist(): Promise<void> {
    console.log(`[HorseFleet] Ensuring ${DEFAULT_TABLES.length} cash tables exist...`);

    // Clamping alone would hide a wrong config forever — the table would just
    // quietly be one seat smaller than the array says. Say so instead. This is
    // how PLO5-at-8 and PLO6-at-7 survived: nothing ever disagreed out loud.
    for (const config of DEFAULT_TABLES) {
      const legal = maxSeatsForVariant(config.gameVariant);
      if (config.maxPlayers > legal) {
        reportError(
          new Error(
            `HorseFleet config "${config.name}" asks for ${config.maxPlayers} seats; ` +
              `${config.gameVariant} is ${legal}-max. Seating ${legal}.`
          ),
          'HorseFleet.seat_law_override'
        );
      }
    }

    /* GATE 7 (2026-09-05): this method no longer inserts or reactivates a
       table. Every DEFAULT_TABLES key is a `cash_games` row now (the union
       ladder), the ClusterController keeps each game's Main 1 open (R3) and
       reopens a closed one every tick (RECONCILE), and the database refuses
       a cash table with no game behind it (tables_cash_needs_a_game). The
       seat-law check above stays: a wrong config still says so out loud. */
    console.log(
      `[HorseFleet] ${DEFAULT_TABLES.length} default keys are cash_games rows; the controller keeps them open`
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // SEED ALL TABLES — Fill empty seats with available horses
  // ─────────────────────────────────────────────────────────────────────

  private async seedAllTables(generation?: number): Promise<void> {
    // THE FREEZE IS TOTAL (Dan 2026-09-03): seeding is a seat INSERT and a buy-in.
    // start() runs this once immediately; a boot inside the break must not.
    if (generation !== undefined && !this.lifecycleIsCurrent(generation)) return;
    if (isMaintenanceFrozen()) return;
    if (this.seeding) return; // Prevent concurrent seeding
    this.seeding = true;
    const cycleStartedAt = Date.now();
    this.cycleSittingSeed = String(cycleStartedAt);
    /* THE PULSE (Phase 3). Filled in as the cycle learns things and published
       once, in `finally`, so that EVERY exit path beats - the early returns
       above all the way down to the catch. Starts as "we got nowhere", which
       is the truth until something overwrites it. */
    const beat: CycleBeat = {
      reason: 'cycle_did_not_complete',
      degraded: false,
      policyVersion: null,
      horsesTotal: null,
      horsesSeated: null,
      tablesSeen: null,
      tablesSeeded: null,
      seatsFilled: 0,
      withheldTables: 0,
      disabledGameTables: 0,
      disabledGamesReadFailed: 0,
      staleTablesSkipped: 0,
      staleDoorReadFailed: 0,
      bookingsReadFailed: 0,
      bookedOut: 0,
      openingFeeders: [],
      horsesSeatedCash: null,
      gates: null,
      rows: [],
    };
    /* The bankroll counters are cumulative for the process; the beat carries
       THIS cycle's share, so the position at the top is remembered. */
    const bankrollAtStart = bankrollCounters();
    try {
      // Get all active cash tables
      // AUDIT V2 (2026-07-23): club_id selected here — the old code re-queried
      // tables once per table inside the seeding loop (N+1) just to read it.
      //
      // 2026-09-02: AND IT IS PAGED, for the same reason the seat map below is.
      // This was a bare .select() with no paging and no ordering, so PostgREST
      // capped it at db-max-rows (1,000) WITHOUT erroring — the identical
      // silent truncation that was found and fixed for `table_seats` on
      // 2026-08-20, thirty lines further down, and never applied to the query
      // that feeds it.
      //
      // The seat fix made the consequence invisible rather than removing it. A
      // truncated SEAT map makes occupied seats read as empty, which fails
      // loudly: ~150,000 duplicate-key buy-ins a day. A truncated TABLE list
      // fails silently in the opposite direction — a table the seeder never
      // received is not "empty", it does not exist, so nothing is attempted
      // and nothing is logged. The floor simply never fills and no error is
      // ever raised to say why.
      //
      // Measured on 2026-09-02: 1,134 live non-tournament tables against a
      // 1,000 cap, so 134 were invisible. Unordered PostgREST reads come back
      // in physical order, which tracks insertion, so the truncated tail is
      // always the NEWEST tables — the worst possible 134 to lose, because a
      // table nobody has sat at yet is precisely the one that needs seeding.
      // Every one of the 45 Midway Union micro tables created that morning
      // ranked 1090-1134 and none of them was ever offered a horse: the floor
      // was hand-packed, drained on the next engine restart, and never
      // refilled, while Deep Stack Society (older, inside the first 1,000)
      // seeded normally all day. That contrast is what the truncation looks
      // like from the outside, and it reads as "the seeder ignores this club".
      //
      // Ordered by id and keyset-paged, so the cap cannot apply and the page
      // boundary cannot skip a row when a table opens or closes mid-read.
      const tablePage = await fetchAllRows<{
        id: string;
        name: string;
        max_players: number;
        small_blind: number;
        big_blind: number;
        game_variant: string;
        club_id: string;
        min_buy_in: number | null;
        max_buy_in: number | null;
        current_players: number | null;
        created_at: string;
        union_id: string | null;
        cluster_id?: string | null;
        lifecycle?: string | null;
        role?: string | null;
        main_index?: number | null;
        arena?: unknown;
      }>(
        (cursor, want) => {
          let q = supabase
            .from('tables')
            .select(
              'id, name, max_players, small_blind, big_blind, game_variant, club_id, union_id, arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id), min_buy_in, max_buy_in, current_players, created_at, settings, cluster_id, lifecycle, role, main_index'
            )
            .is('tournament_id', null)
            .in('status', ['waiting', 'running'])
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.openTables', maxRows: 50_000 }
      );

      // FAIL CLOSED, exactly as the seat map does. A partial table list is not
      // a smaller floor, it is a floor with holes in it that nothing will ever
      // report — so a cycle skipped here costs 30 seconds, while a cycle run
      // from a half-read list silently strands whichever tables fell off the
      // end until someone notices by hand.
      if (!tablePage.complete) {
        beat.reason = 'table_list_incomplete';
        console.warn(
          '[HorseFleet] Seeding cycle SKIPPED - the open-table list came back ' +
            'incomplete, and seeding from a partial list leaves the newest ' +
            'tables permanently unseeded.'
        );
        return;
      }
      const tables = tablePage.rows.filter(isChipFleetTable);

      /* WHO MAY SIT WHERE (Dan 2026-09-02, verbatim: "FREE THEM TO PLAY OPENLY
         INSIDE THE DEEP STACK SOCIETY ONLY. THEY HAVE NO AFFILIATION OR ARE A
         PART OF THE MIDWAY UNION.")

         A horse sits where its wallet is, and the database already knows the
         rule: `fn_seat_club_for_user` resolves a standalone club's table to a
         membership in THAT club, and a union table to a membership in one of
         the union's member clubs (`union_clubs`) - never the union's own club
         row. This map is the engine's copy of that rule, read fresh every
         cycle so a club joining or leaving a union is honoured within 30s.

         MEASURED 2026-09-02, and this is why it exists. The seeder drew its
         candidates from the whole fleet and keyed every bankroll lookup on
         `table.club_id`. For a Midway Union table that key is the union's own
         club row, which 261 of the 584 Midway horses hold no membership in and
         which no Deep Stack horse holds at all - so for every one of them the
         roll read as ZERO, `computeHorseBuyIn` sized a zero buy-in, and the
         seat it had been picked for was silently skipped for the cycle. The
         log said "bankroll gate skipped for 84,954 horse/table pairs". Midway
         was seating 22 horses an hour against Deep Stack's 198, with 476 of
         its 576 seats empty.

         Fails CLOSED like the reads above it: a cycle that cannot learn who
         belongs where would either seat nobody in a union or seat everybody
         everywhere, and both are worse than waiting 30 seconds. */
      const unionClubs = new Map<string, string[]>();
      {
        const { data: ucRows, error: ucErr } = await supabase
          .from('union_clubs')
          .select('union_id, club_id');
        if (ucErr) {
          beat.reason = 'union_map_incomplete';
          reportError(new Error(ucErr.message), 'HorseFleet.union_clubs_read_failed');
          console.warn(
            '[HorseFleet] Seeding cycle SKIPPED - the union membership map could not be read.'
          );
          return;
        }
        for (const r of ucRows ?? []) {
          const row = r as { union_id?: string | null; club_id?: string | null };
          if (!row.union_id || !row.club_id) continue;
          if (!unionClubs.has(row.union_id)) unionClubs.set(row.union_id, []);
          unionClubs.get(row.union_id)!.push(row.club_id);
        }
        for (const list of unionClubs.values()) list.sort();
      }
      /* The clubs whose wallets may pay for a seat at this table: the member
         clubs of its union, else the club itself. The database's rule, mirrored. */
      const eligibleClubsFor = (t: {
        club_id?: string | null;
        union_id?: string | null;
      }): string[] => {
        if (t.union_id) return unionClubs.get(t.union_id) ?? [];
        return t.club_id ? [t.club_id] : [];
      };

      /* THE SOLE-OPEN REGISTRY IS GONE WITH THE RULE IT PROTECTED (2026-09-02).
         It existed so the 15% held-empty hold could never switch off a variant
         that had exactly one open table. Dan's new occupancy rule has no hold
         and no zero: the sparse quarter's floor is ONE seat, so a variant with
         one table always has a game. Nothing to except any more. */

      // Optimization: Fetch all active seats once to build an in-memory map of
      // who is seated where.
      //
      // 2026-08-20: this was a bare .select() with no paging. PostgREST caps
      // every response at db-max-rows (1,000 here) WITHOUT erroring, and there
      // are 1,428 open seats — 1,245 of them on tournament tables, which this
      // seeder does not even seed but which still consume the row budget. So
      // ~428 occupied seats were invisible, and every seat the seeder could not
      // see it believed was EMPTY and tried to sit a horse in.
      //
      // Measured in postgres_logs before the fix: 18,744 `duplicate key value
      // violates unique constraint "table_seats_table_id_seat_number_key"` in
      // three hours — ~150,000 a day, the largest error stream on the platform,
      // and a ~65% failure rate on a path a genuine race could never push past
      // a few percent. The same truncated map fed the per-horse 4-table cap
      // (horseTables, below) and the human-rescue check, so those were wrong in
      // the same way.
      //
      // No money was ever at risk: atomic_table_buyin is the authoritative
      // guard and rejected all of them. That is precisely why it stayed
      // invisible — the failure mode was pure waste, logged where nobody looks.
      const seatPage = await fetchAllRows<{
        id: string;
        user_id: string;
        table_id: string;
        seat_number: number;
        stack: number | null;
        club_id: string | null;
        joined_at: string | null;
      }>(
        (cursor, want) => {
          // KEYSET, not OFFSET. `.range()` paging re-reads the table under a
          // fresh snapshot per page: a seat that empties between page 1 and
          // page 2 shifts every later row down one index, so OFFSET 1000 starts
          // PAST a still-occupied seat and never returns it — which is exactly
          // the duplicate-key buy-in this whole fix exists to stop. Seats empty
          // constantly in a live room. `id > cursor` has no such window.
          let q = supabase
            .from('table_seats')
            .select('id, user_id, table_id, seat_number, stack, club_id, joined_at')
            .is('left_at', null)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.activeSeats', maxRows: 50_000 }
      );

      // FAIL CLOSED. A partial seat map is precisely the state that produced
      // ~150,000 failed buy-ins a day: every seat we cannot see reads as empty.
      // Skipping a 30-second seeding cycle costs nothing; seeding from a
      // half-read map costs a storm.
      if (!seatPage.complete) {
        beat.reason = 'seat_map_incomplete';
        console.warn(
          '[HorseFleet] Seeding cycle SKIPPED - the seat map came back incomplete, ' +
            'and seeding from a partial map is what caused the duplicate-seat storm.'
        );
        return;
      }
      const allActiveSeats = seatPage.rows;

      /* A PLANNED MOVE HOLDS ITS SEAT (2026-09-05). The ClusterController plans
         a feeder player onto a Main's open seat and the engine lands them at
         the next hand boundary - up to a hand later. In between, this loop
         used to see the seat as empty and fill it with a fresh horse, the
         executor found `destination_full`, and the feeder player waited for
         the NEXT seat, which the fleet took too. One read per cycle; a table
         with N pending arrivals has N fewer seats to fill. */
      const pendingMovesByTable = new Map<string, number>();
      {
        // A SWAP IS NOT A RESERVATION (2026-09-05): two linked seat-change
        // moves exchange two occupied chairs and change no table's headcount.
        //
        // PAGED (2026-09-06). This was a bare `.select()` with no order and no
        // limit, in the one file whose doctrine is "page everything" and which
        // documents the silent PostgREST db-max-rows truncation three times
        // over. A truncated read here UNDERCOUNTS reservations, and an
        // undercounted reservation is the fleet filling the very seat the
        // controller planned a feeder player into - which is the bug this read
        // was added to fix. Keyset on id, exactly like the seat and table
        // reads above.
        const pmPage = await fetchAllRows<{ id: string; to_table_id: string }>(
          (cursor, want) => {
            let q = supabase
              .from('cash_seat_moves')
              .select('id, to_table_id')
              .eq('state', 'pending')
              .is('swap_move_id', null)
              .order('id', { ascending: true })
              .limit(want);
            if (cursor) q = q.gt('id', cursor);
            return q;
          },
          { label: 'HorseFleet.pendingMoves', maxRows: 50_000 }
        );
        if (!pmPage.complete) {
          // Fail LOUD but open: a reservation we cannot see costs a wasted
          // buy-in attempt (the executor reports `destination_full`), whereas
          // treating an unreadable page as "every seat is reserved" would stop
          // the floor filling at all.
          console.warn(
            '[HorseFleet] pending seat-move read incomplete - seating this cycle without ' +
              'the full reservation map; a planned arrival may find its seat taken.'
          );
        }
        for (const row of pmPage.rows) {
          pendingMovesByTable.set(
            row.to_table_id,
            (pendingMovesByTable.get(row.to_table_id) ?? 0) + 1
          );
        }
      }

      /* Which game each cluster table belongs to, for the one-seat-per-game
         rule below (the database refuses it too - ALREADY_IN_GAME - but a
         refusal the fleet can avoid should not be tried every 30 s). */
      const clusterByTableId = new Map<string, string>();
      for (const t of tables) {
        if (t.cluster_id) clusterByTableId.set(t.id, t.cluster_id);
      }

      const horseTables = new Map<string, Set<string>>();
      /**
       * AGGREGATE EXPOSURE. Chips this player has ON THE FELT right now,
       * summed across every open seat.
       *
       * The per-table share is checked per table, so it answers identically
       * for the first table and the fourth: four seats at five percent each is
       * a fifth of the roll in play, and no single-table check can see it.
       * This map is what lets `canOpenAnotherTable` see it.
       *
       * The measure is the live STACK, not the original buy-in, because the
       * question is "how much of my money is at risk", and a horse that bought
       * in for 200 and ran it to 600 has 600 at risk.
       *
       * CASH SEATS ONLY (2026-09-09). `allActiveSeats` is every open seat on
       * the platform, and a TOURNAMENT seat's stack is tournament chips - a
       * 5,000 starting stack, 840,000 at a final table - not chips from the
       * club wallet this ceiling is a share of. Summing them here told
       * `canOpenAnotherTable` (roll x 5% x 4 = 8,800 on a 44,000 roll) and
       * the mutex's `commitAllows` that every horse in an event had its whole
       * roll on the felt: measured 2026-09-09, 501 horses held tournament
       * seats with a median stack of 5,000 and the cycle line read
       * `aggregate_exposure=265` every 30 seconds while the cash floor
       * emptied. A horse's exposure is what it bought into CASH tables with;
       * the tables this cycle read are exactly the open cash floor, so a seat
       * is cash exposure when its table is in that list. `horseTables` still
       * counts every seat, because the four-game limit does (HorseGameLoad).
       */
      const horseExposure = new Map<string, number>();
      const openCashTableIds = new Set<string>(tables.map((t) => String(t.id)));
      for (const seat of allActiveSeats) {
        if (!horseTables.has(seat.user_id)) horseTables.set(seat.user_id, new Set());
        horseTables.get(seat.user_id)!.add(seat.table_id);
        if (!openCashTableIds.has(String(seat.table_id))) continue;
        const st = Number(seat.stack);
        if (Number.isFinite(st) && st > 0) {
          horseExposure.set(seat.user_id, (horseExposure.get(seat.user_id) ?? 0) + st);
        }
      }

      // Optimization: Fetch all horses once instead of querying per table
      // We NO LONGER check for 'available' status because horses can multi-table.
      // 2026-08-20: paged, same reason as the seat read above — the fleet is
      // 574 horses and a truncated pool silently shrinks who can ever be seated.
      const horsePage = await fetchAllRows<{
        id: string;
        display_name: string | null;
        username: string | null;
      }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id, display_name, username')
            .eq('is_horse', true)
            .neq('horse_status', 'disabled') // 'disabled' is the only status that prevents playing
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.validHorses', maxRows: 50_000 }
      );
      if (!horsePage.complete) {
        beat.reason = 'horse_pool_incomplete';
        console.warn('[HorseFleet] Seeding cycle SKIPPED - the horse pool came back incomplete.');
        return;
      }
      const validHorses = horsePage.rows;

      /**
       * BANKROLLS (Dan 2026-08-31). A horse's `club_members.chip_balance` is
       * its bankroll, and from the 10,000-chip reset onward it decides which
       * games it may sit in. It is per (club, user) because a horse belongs
       * to several clubs and its roll in one is not its roll in another.
       *
       * Loaded ONCE per seeding cycle rather than per seat: 1,487 horse
       * memberships against a loop that considers every table x every empty
       * seat would be thousands of point reads a cycle.
       *
       * An INCOMPLETE read is not treated as "everyone is broke" — that would
       * empty the entire floor on one bad page. It is treated as "no bankroll
       * opinion", the gate below is skipped, and the cycle behaves exactly as
       * it did before this layer existed. Failing open is right here because
       * `atomic_table_buyin` still refuses a seat the balance cannot cover;
       * this layer decides which games are SENSIBLE, not which are possible.
       */
      const bankrolls = new Map<string, number>();
      /** Clubs the bankroll map holds at least one row for. Telemetry only. */
      const clubsWithRolls = new Set<string>();
      /* The same rows, read the other way round: which clubs each horse
         belongs to. This is what decides whether a horse is a CANDIDATE for a
         table at all - see resolveSeatClub. */
      const memberships = new Map<string, Set<string>>();
      let bankrollsLoaded = false;
      // Horses the gate could not price this cycle. LOUD, because the silent
      // version of this number is what cost the floor 40 minutes.
      let rollUnknown = 0;
      try {
        /**
         * PAGED PER CLUB (2026-08-31). `club_members` has NO `id` column — its
         * primary key is (club_id, user_id) — and `fetchAllRows` defaults its
         * keyset column to `id`. A single cross-club read therefore looked for
         * `id` on the last row of the first full page, found undefined, and
         * returned `complete: false` EVERY cycle: 1,505 membership rows against
         * a 1,000-row page always fills page one. The bankroll gate had never
         * once been applied in production (76 `missing_cursor_key` alarms in a
         * 41-minute window on 2026-08-31), and the failure was silent because
         * the fail-open branch below is the correct behaviour for a genuinely
         * bad page.
         *
         * `user_id` is unique WITHIN a club but not across clubs, so it is only
         * a legal cursor once the query is narrowed to one club. Paging per
         * club is therefore not an optimisation, it is what makes the keyset
         * sound: a page boundary landing mid-user in a cross-club scan would
         * have skipped that user's remaining memberships outright.
         *
         * A partial read on ANY club abandons the whole map rather than seating
         * from a half-loaded one, because a horse missing from the map reads as
         * a zero roll to the gate below.
         */
        /**
         * THE CLUBS THAT ACTUALLY OWN THE TABLES, not a hard-coded pair.
         *
         * `this.clubIds` is the round-robin used when CREATING tables. It is
         * not the set of clubs that own the tables now on the floor, and on
         * 2026-08-31 it shared not one entry with them: all 26 open cash
         * tables belonged to `fade0000-…-0001` while the loader read
         * `a41434bb-…` and `a0000000-…`, which own zero cash tables between
         * them. Every gate lookup therefore missed.
         *
         * That was survivable only because a separate paging bug kept
         * `bankrollsLoaded` false, so the gate never ran. #2101 fixed the
         * paging, the gate ran for the first time, and the floor emptied
         * inside one seeding cycle.
         *
         * Deriving the set from `tables` cannot drift: the clubs read are by
         * construction the clubs whose seats are being decided.
         */
        const clubIdsToLoad = new Set<string>(this.clubIds);
        for (const t of tables) {
          const cid = (t as { club_id?: string | null }).club_id;
          if (cid) clubIdsToLoad.add(cid);
          // A union table's wallets live in the union's MEMBER clubs, which
          // own no tables of their own (JAQK and SHARK own zero) and so were
          // never loaded: 261 Midway horses had no roll on this map.
          for (const c of eligibleClubsFor(t)) clubIdsToLoad.add(c);
        }

        let allComplete = true;
        for (const clubId of clubIdsToLoad) {
          const brPage = await fetchAllRows<{
            user_id: string;
            club_id: string;
            chip_balance: number | string | null;
          }>(
            (cursor, want) => {
              let q = supabase
                .from('club_members')
                .select('user_id, club_id, chip_balance')
                .eq('club_id', clubId)
                // The only two statuses fn_seat_club_for_user will pay from.
                .in('status', ['active', 'approved'])
                .order('user_id', { ascending: true })
                .limit(want);
              if (cursor) q = q.gt('user_id', cursor);
              return q;
            },
            { label: 'HorseFleet.bankrolls', maxRows: 50_000, idKey: 'user_id' }
          );
          if (!brPage.complete) {
            allComplete = false;
            break;
          }
          for (const r of brPage.rows) {
            const v = Number(r.chip_balance);
            /* Which clubs the map actually holds rows FOR. On 2026-08-31 it
               loaded "completely" while keyed on clubs that own zero cash
               tables, so every lookup missed and the gate emptied the floor.
               The load flag alone cannot tell that apart from a genuine
               non-member; this set can. Read only by the telemetry split at
               the fail-open branch - it decides nothing. */
            clubsWithRolls.add(String(r.club_id));
            if (Number.isFinite(v)) bankrolls.set(`${r.club_id}:${r.user_id}`, v);
            if (!memberships.has(r.user_id)) memberships.set(r.user_id, new Set());
            memberships.get(r.user_id)!.add(r.club_id);
          }
        }
        if (allComplete) {
          bankrollsLoaded = true;
        } else {
          bankrolls.clear();
          memberships.clear();
          console.warn(
            '[HorseFleet] bankroll read incomplete - seating this cycle without the bankroll gate.'
          );
        }
      } catch (err) {
        reportError(err, 'HorseFleet.bankroll_load_failed');
      }

      /* ── THE DOOR RULES, READ ONCE (2026-09-05) ──────────────────────────
         A horse booted for low VPIP is barred from that game for two hours
         (fn_cash_rejoin_floor raises VPIP_BARRED), and a horse that left a
         game with chips meets a rejoin floor in it (BUYIN_BELOW_FLOOR). A
         human reads both in the lobby and does not try; the fleet is the
         horse's browser (10.5) and until today it tried anyway - 341 of 349
         buy-in refusals in one hour were VPIP_BARRED - and, worse, COUNTED
         every barred horse as a buyer, so the controller opened feeders for
         players the door would refuse. One paged read for the whole floor,
         keyed exactly as the SQL joins (club, variant, sb, bb).

         FAILS OPEN, like the bankroll loader above and for the same reason:
         the database is the authoritative guard, so an unread row costs one
         wasted buy-in attempt, whereas treating an unread map as "everyone is
         barred" would empty the floor. */
      let rejoin: RejoinConstraints = EMPTY_REJOIN_CONSTRAINTS;
      try {
        const nowIsoForRejoin = new Date().toISOString();
        const rejoinPage = await fetchAllRows<{
          id: string;
          player_id: string;
          club_id: string;
          variant: string;
          sb: number | string;
          bb: number | string;
          required_stack: number | string | null;
          barred_until: string | null;
          expires_at: string;
        }>(
          (cursor, want) => {
            let q = supabase
              .from('cash_rejoin_constraints')
              .select(
                'id, player_id, club_id, variant, sb, bb, required_stack, barred_until, expires_at'
              )
              .gt('expires_at', nowIsoForRejoin)
              .order('id', { ascending: true })
              .limit(want);
            if (cursor) q = q.gt('id', cursor);
            return q;
          },
          { label: 'HorseFleet.rejoinConstraints', maxRows: 50_000 }
        );
        if (rejoinPage.complete) {
          rejoin = buildRejoinConstraints(rejoinPage.rows, Date.now());
        } else {
          console.warn(
            '[HorseFleet] rejoin constraints read incomplete - seating this cycle without ' +
              'the VPIP bar and rejoin floor; the database still refuses at the door.'
          );
        }
      } catch (err) {
        reportError(err, 'HorseFleet.rejoin_constraints_load_failed');
      }

      /* THE OPERATOR'S SWITCH (2026-09-05). `cash_games.enabled = false` is
         OPORD 1.4 18.4: no seeding, no opening; empties close. The seeding
         loop below skipped a cluster table only when its LIFECYCLE was
         breaking or closed and never asked whether the GAME was enabled, so a
         disabled game's live tables were seeded like any other. "NLH
         0.05/0.10 Classic" was switched off by an operator at 16:47 CDT on
         2026-09-04; between 01:10 and 03:41 the next morning the fleet seated
         five horses onto its feeder and it dealt 76 hands in an hour. 30
         games were disabled at the time. Read ONCE per cycle, paged like the
         loaders above. See HorseDisabledGames.

         FAILS OPEN, like the bankroll and rejoin loaders, and for a sharper
         reason: failing CLOSED here would empty every cluster game on the
         floor on one bad read, which is a worse outage than one more cycle of
         seating on a switched-off game. So a failed or short read is counted
         (`disabledGamesReadFailed`) and reaches both the cycle line and the
         beat, and this cycle treats no game as disabled. */
      let disabledGameIds = new Set<string>();
      try {
        const disabledPage = await fetchAllRows<{ id: string }>(
          (cursor, want) => {
            let q = supabase
              .from('cash_games')
              .select('id')
              .eq('enabled', false)
              .order('id', { ascending: true })
              .limit(want);
            if (cursor) q = q.gt('id', cursor);
            return q;
          },
          { label: 'HorseFleet.disabledGames', maxRows: 50_000 }
        );
        if (disabledPage.complete) {
          disabledGameIds = buildDisabledGameIds(disabledPage.rows);
        } else {
          beat.disabledGamesReadFailed = 1;
          console.warn(
            '[HorseFleet] disabled games read incomplete - seating this cycle as if every ' +
              'game were enabled (fail open); a disabled game may be seeded for one cycle.'
          );
        }
      } catch (err) {
        beat.disabledGamesReadFailed = 1;
        reportError(err, 'HorseFleet.disabled_games_load_failed');
      }

      /* ── A BOOKING IS A GAME (2026-09-06) ────────────────────────────────
         The database refuses a fifth concurrent game, and it counts a
         tournament BOOKING as a game beside a live seat
         (`fn_enforce_four_table_limit` -> `fn_concurrent_game_load`). The
         fleet counted only seats, so it offered the controller buyers the
         database would refuse: `FOUR TABLE LIMIT` was raised 10,577 times in
         under four hours on 2026-09-06 - the most common error on the whole
         database - and opening feeders selected 156 horses in three hours and
         seated 34. Two horses were at four live SEATS; 351 were at the
         database's four-GAME limit, and 349 of those looked free from here.

         It is not a horse rule (10.5): the same function counts a human's
         bookings identically, and its own HINT says the limit applies to
         players and horses alike. This is the fleet reading, for the horse,
         what a human reads in the lobby.

         TWO READS, both paged, both once per cycle: the bookings, and the
         tables of the tournaments they belong to - the second is what keeps a
         seat-first game from being counted twice (36 of 2,148 bookings on
         2026-09-06), exactly as the SQL's `NOT EXISTS` does.

         FAILS OPEN, like the bankroll, rejoin and disabled-game loaders: a
         cycle that cannot read the bookings counts none and behaves exactly as
         every cycle before today did. The database is still the guard; the
         cost is wasted buy-in attempts, and the beat says it happened. */
      let bookingLoad: ReadonlyMap<string, number> = new Map<string, number>();
      /** Open TOURNAMENT tables, so a cash-only rule can exclude their seats. */
      const tournamentTableIds = new Set<string>();
      /* THE WALLET SCOPE OF EVERY OPEN TOURNAMENT TABLE (2026-09-09). See the
         seat-club scope build below: the database's "one club at a time"
         rule reads a held seat at ANY table of the union, tournament tables
         included, and the engine read only the cash ones. Filled from the
         same read; empty when it failed (then a held tournament seat is
         invisible here and the database decides, which is the fail-open the
         loader already declares). */
      const tournamentTableScope = new Map<string, string>();
      try {
        const bookingPage = await fetchAllRows<{
          id: string;
          user_id: string;
          tournament_id: string;
          tournaments:
            | { status: string; start_time: string | null }
            | Array<{ status: string; start_time: string | null }>
            | null;
        }>(
          (cursor, want) => {
            let q = supabase
              .from('tournament_players')
              .select('id, user_id, tournament_id, tournaments!inner(status, start_time)')
              .in('status', ['registered', 'playing'])
              .in('tournaments.status', ['ANNOUNCED', 'REGISTERING'])
              .order('id', { ascending: true })
              .limit(want);
            if (cursor) q = q.gt('id', cursor);
            return q;
          },
          { label: 'HorseFleet.tournamentBookings', maxRows: 50_000 }
        );
        /* The tournament each open tournament table belongs to. Only tables
           that are not closed, because a seat at a closed table is history in
           `fn_concurrent_game_load` too. */
        const tournamentTablePage = await fetchAllRows<{
          id: string;
          tournament_id: string | null;
          union_id: string | null;
          club_id: string | null;
          status: string | null;
        }>(
          (cursor, want) => {
            let q = supabase
              .from('tables')
              .select('id, tournament_id, union_id, club_id, status')
              .not('tournament_id', 'is', null)
              .neq('status', 'closed')
              .order('id', { ascending: true })
              .limit(want);
            if (cursor) q = q.gt('id', cursor);
            return q;
          },
          { label: 'HorseFleet.tournamentTables', maxRows: 50_000 }
        );
        if (bookingPage.complete && tournamentTablePage.complete) {
          const tournamentByTableId = new Map<string, string>();
          for (const row of tournamentTablePage.rows) {
            if (row.tournament_id) tournamentByTableId.set(row.id, row.tournament_id);
            /* The statuses fn_seat_club_for_user_membership_unchecked treats
               as history when it looks for a held seat. */
            if (!HELD_SEAT_HISTORY_STATUSES.has(String(row.status ?? '').toLowerCase())) {
              tournamentTableScope.set(row.id, String(row.union_id ?? row.club_id ?? ''));
            }
          }
          /* Hoisted out of this block (2026-09-06) so the candidate filter can
             tell a CASH seat from a tournament one. The horse's own tag
             ceiling is a cash rule and must not count tournament chairs; see
             HorseGameLoad.remainingGameCapacity. Empty when this read failed,
             which makes `cashSeats` fall back to every seat - the stricter
             answer, and the honest one when we cannot tell them apart. */
          for (const id of tournamentByTableId.keys()) tournamentTableIds.add(id);
          /* THE WINDOW (2026-09-06). The start time rides along so that
             `buildBookingLoad` can apply the same sixty-minute window
             `fn_concurrent_game_load` applies: a booking for an event more
             than an hour out is a plan, not a game. Read once, here, so the
             count and the chair see one clock. */
          const withStart = bookingPage.rows.map((row) => {
            const t = Array.isArray(row.tournaments) ? row.tournaments[0] : row.tournaments;
            return {
              user_id: row.user_id,
              tournament_id: row.tournament_id,
              start_time: t?.start_time ?? null,
            };
          });
          bookingLoad = buildBookingLoad(withStart, tournamentByTableId, horseTables, Date.now());
        } else {
          beat.bookingsReadFailed = 1;
          console.warn(
            '[HorseFleet] tournament booking read incomplete - counting NO bookings this ' +
              'cycle (fail open); the database still refuses the fifth game at the door. ' +
              'A wallet held by a tournament seat is unknown this cycle too, and the ' +
              'database picks it alone.'
          );
        }
      } catch (err) {
        beat.bookingsReadFailed = 1;
        reportError(err, 'HorseFleet.tournament_bookings_load_failed');
      }

      /* WHICH BANDS HAVE A GAME AT ALL (2026-09-05).
         `fn_assign_horse_stake_bands` ranks the fleet by bb/100 and hands out
         merit bands without ever asking which games exist. On 2026-09-05 that
         put 100 horses in 'high' while every game with bb > 6 was switched
         off - the six high games closed by an operator at 16:47 the day
         before - and `stakeBandAllows` is a hard gate, so those 100 could sit
         NOWHERE. Read from the table list this cycle already holds, minus the
         tables the seeding loop below would refuse anyway; no extra query.
         The band a horse is ASSIGNED is not touched (it is a merit record and
         the switch is temporary); only the band it may SIT in moves, and only
         downward. See effectiveStakeBandFor. */
      const bandsWithAGame = new Set<HorseStakeBand>();
      /* AND THE SAME QUESTION PER HOST (2026-09-11). A horse sits only where it
         holds a membership, and the two hosts deal different ladders: Deep
         Stack Society micro/low/mid/high, Midway Union micro/low/mid. The
         platform-wide set above therefore told every Midway horse that 'high'
         had a game, so a Midway horse assigned 'high' would never step down and
         would be refused at every Midway table - the 2026-09-05 shape, one host
         at a time. Same scan, same predicates, keyed by the table's club. */
      const bandsWithAGameByHost = new Map<string, Set<HorseStakeBand>>();
      /* A DRAINING TABLE IS NOT SUPPLY (2026-09-06). The scan below excludes
         breaking, closed and disabled-game tables but not the two the fleet
         also refuses: `retire_when_empty` and the night park (they build
         `surplusTableIds` further down, and the seeding loop skips both). A
         band whose only tables are draining therefore read as supplied, and
         `projectStakeBandOnto` refuses to step a horse DOWN out of a band it
         cannot actually sit in - stranding exactly the horses the projection
         exists to rescue. The same two predicates, asked here. Both sets are
         empty on the cash floor today (every open cash table is a cluster
         table), so this changes nothing now and cannot rot later. */
      const drainingHere = (t: { cluster_id?: string | null; settings?: unknown }): boolean =>
        !t.cluster_id && (isRetiringTable(t) || isNightParkedTable(t));
      /* ...AND WHICH EXACT BIG BLINDS (2026-09-06). The tag names blinds, not
         a band, and `tagAllowsStake` is a hard gate on the exact number. A
         tag whose every stake names a game that is switched off - measured
         2026-09-06: 20 tags on 18 horses carrying only 10.00 / 20.00 / 50.00,
         every one of those rungs closed by the operator on 09-04 - refuses
         every table on the floor, and the band projection below (built for
         exactly this) is never reached because it sits on the untagged
         branch. See the stake gate in the candidate filter. */
      /* PER HOST, NOT PER PLATFORM (2026-09-11). This was one set over every
         open table on the floor, and the fallthrough below asks it about a
         horse that can only sit on ONE host. Deep Stack deals 0.02, 0.05 and
         50; Midway deals none of them - so a Midway tag drawn onto one of
         those rungs read as "the game is running" here, never fell through to
         the merit band, and was refused `tag` at every Midway table for ever.
         Measured 2026-09-11: 69 Midway cash tags name a stake Midway deals in
         no variant, 57 of them a stake Deep Stack deals; 51 of 530 Midway
         cash-capable bodies could not sit anywhere on their own host. The
         tagger stopped minting them (StableHand.assignPreferredStakes), and
         this is the seeding side, so a game an operator switches off on one
         host after tagging strands nobody either. */
      const stakesWithAGame = new Map<string, Set<string>>();
      for (const t of tables) {
        if (t.lifecycle === 'breaking' || t.lifecycle === 'closed') continue;
        if (isTableOfDisabledGame(t, disabledGameIds)) continue;
        if (drainingHere(t as { cluster_id?: string | null; settings?: unknown })) continue;
        const band = stakeBandForBigBlind(Number(t.big_blind));
        bandsWithAGame.add(band);
        const hostId = String((t as { club_id?: string | null }).club_id ?? '');
        let hostBands = bandsWithAGameByHost.get(hostId);
        if (!hostBands) {
          hostBands = new Set<HorseStakeBand>();
          bandsWithAGameByHost.set(hostId, hostBands);
        }
        hostBands.add(band);
        let hostStakes = stakesWithAGame.get(hostId);
        if (!hostStakes) {
          hostStakes = new Set<string>();
          stakesWithAGame.set(hostId, hostStakes);
        }
        hostStakes.add(Number(t.big_blind).toFixed(2));
      }
      const bandSupply = applyStakeBandSupply(bandsWithAGame, bandsWithAGameByHost);
      if (bandSupply.missing.length > 0) {
        console.log(
          `[HorseFleet] band supply: no enabled game in band(s) ${bandSupply.missing.join(', ')}; ` +
            `${bandSupply.fallbacks} horse(s) seat one band down`
        );
      }

      // V8: full horse-id set (any status) so we can tell HUMAN seats from
      // horse seats — humans get rescue priority below.
      // Paged: a horse missing from this set reads as a HUMAN, which triggers
      // the short-handed-human rescue path and reorders the whole seeding queue.
      const idPage = await fetchAllRows<{ id: string }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id')
            .eq('is_horse', true)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.horseIds', maxRows: 50_000 }
      );
      // A horse missing from this set reads as a HUMAN, which triggers the
      // short-handed-human rescue path and reorders the whole seeding queue.
      if (!idPage.complete) {
        beat.reason = 'horse_ids_incomplete';
        console.warn('[HorseFleet] Seeding cycle SKIPPED - the horse id set came back incomplete.');
        return;
      }
      const horseIdSet = new Set(idPage.rows.map((h) => h.id));
      const hourUTC = new Date().getUTCHours();

      /* ── FLEET POLICY (Phase 3) ────────────────────────────────────────
         ONE READ PER CYCLE PER CLUB SCOPE, never one per table: the module
         caches for 60 seconds, but a lookup per table would still be a
         thousand awaits inside the loop, and this manager has already paid
         for that mistake once (the per-table waitlist query that stretched a
         30-second cycle to 47 minutes on 2026-09-02).

         WITH NO POLICY ROW, OR AN UNREADABLE ONE, EVERYTHING BELOW BEHAVES
         EXACTLY AS IT DID BEFORE THIS BLOCK EXISTED. getFleetPolicy never
         throws and never returns null; its defaults are today's numbers. See
         HorseFleetPolicy.ts. */
      const policyByClub = new Map<string | null, FleetPolicy>();
      const policyScopes = new Set<string | null>([null]);
      for (const t of tables) if (t.club_id) policyScopes.add(t.club_id);
      for (const scope of policyScopes) policyByClub.set(scope, await getFleetPolicy(scope));
      const globalPolicy = policyByClub.get(null) ?? { ...FLEET_POLICY_DEFAULTS };
      /* A table's club row wins field by field over the global row; the RPC
         does that merge, so this only has to pick the right scope. */
      const policyFor = (clubId?: string | null): FleetPolicy =>
        policyByClub.get(clubId ?? null) ?? globalPolicy;
      for (const p of policyByClub.values()) {
        if (p.degraded) beat.degraded = true;
        if (p.version && (beat.policyVersion === null || p.version > beat.policyVersion)) {
          beat.policyVersion = p.version;
        }
      }
      if (beat.degraded) {
        console.warn(
          '[HorseFleet] Fleet policy could not be read - running on the hardcoded ' +
            'defaults for this cycle (today behaviour, unchanged).'
        );
      }

      console.log(
        `[HorseFleet] Seeding cycle: ${tables.length} tables found, ${validHorses.length} total horses.`
      );

      // Tables draining under a Stable Hand flag are not seeded. Since Gate 7
      // every open cash table is a cluster table, which the loop below skips,
      // so this set is empty on the cash floor and stays for any non-cluster
      // table the platform may still carry.
      const surplusTableIds = new Set<string>();
      /* A table marked `settings.retire_when_empty` is surplus by declaration
         (Dan 2026-09-03, "close any tables over 2/5"): it gets no new horses
         and HorseSessionRotator walks its horses out. This is how a RUNNING
         table above a club's stake cap is drained without cashing seats out
         under a hand. See isRetiringTable.

         THE CLOSER IS GONE AND NOTHING REPLACED IT (recorded 2026-09-05).
         retireSurplusTables() used to close the drained row; Gate 7 deleted it
         because a cash table is closed only by its game's ClusterController.
         Every open cash table is a cluster table today, and a cluster table is
         skipped by the `continue` above, so this set is empty in production
         (0 flagged rows, 0 non-cluster cash tables, measured 2026-09-05) and
         the missing closer costs nothing. If a non-cluster table is ever
         flagged again it will drain to empty and then stay open forever. Do
         not re-add a name-family closer here; give the flag to the controller,
         or delete the flag. */
      let retiring = 0;
      let parked = 0;
      for (const t of tables) {
        /* A cluster table is never surplus, whatever flag it carries: its
           ClusterController opens and closes it (R3 keeps Main 1 open), so
           draining it here is a fight the fleet would lose every tick. */
        if (t.cluster_id) continue;
        if (isRetiringTable(t as { settings?: unknown })) {
          surplusTableIds.add(t.id);
          retiring++;
        } else if (isNightParkedTable(t as { settings?: unknown })) {
          /* PARKED FOR THE NIGHT (Dan 2026-09-04). Same drain, same "closed
             only once genuinely empty", opposite lifetime: the Stable Hand
             executor lifts the flag and reopens the table every cycle outside
             the night window. Never the retirement flag - that one is
             permanent by design and a night using it would delete the floor. */
          surplusTableIds.add(t.id);
          parked++;
        }
      }
      if (surplusTableIds.size > 0) {
        console.log(
          `[HorseFleet] ${surplusTableIds.size} surplus table(s) draining - not seeding them` +
            (retiring > 0 ? ` (${retiring} marked retire_when_empty)` : '') +
            (parked > 0 ? ` (${parked} parked for the night)` : '')
        );
      }

      let totalSeated = 0;

      // ── FLEET ACTIVITY FLOOR (Dan 2026-08-26: "a minimum of 1 out of 3
      // horses should be playing") ──────────────────────────────────────────
      // Measured from live seats, the only truth about where a horse is
      // (horse_status is never flipped for cash play). `allActiveSeats` is
      // EVERY open seat on the platform, tournament chairs included (the seat
      // read's own note says so), so "playing" here means playing anything -
      // which is Dan's sentence. The comment that stood here until 2026-09-09
      // claimed the opposite ("tournament seats are not in allActiveSeats, so
      // this undercounts"); it was wrong, and the beat now carries the cash
      // floor's own count beside this one so the two are never confused
      // again. When the seated fraction drops under a third, every non-empty
      // table wants one more seat this cycle, which lifts the floor without
      // thrashing any single game.
      const seatedHorseCount = new Set(
        allActiveSeats.filter((s) => horseIdSet.has(s.user_id)).map((s) => s.user_id)
      ).size;
      const seatedCashHorseCount = new Set(
        allActiveSeats
          .filter((s) => horseIdSet.has(s.user_id) && openCashTableIds.has(String(s.table_id)))
          .map((s) => s.user_id)
      ).size;
      const fleetBoost =
        validHorses.length > 0 && seatedHorseCount < Math.ceil(validHorses.length / 3);
      if (fleetBoost) {
        console.log(
          `[HorseFleet] Activity floor: ${seatedHorseCount}/${validHorses.length} horses seated (<1/3) - boosting seat targets this cycle`
        );
      }

      /* ── IS ANYBODY NEW SITTING DOWN THIS CYCLE? ──────────────────────
         The kill switch, the pause and the schedule are fleet-wide, so they
         are asked once, here, in the contract's order. `seatedHorses` is what
         makes `max_horses` a BUDGET rather than a switch: at 199 of a 200 cap
         the fleet still seats one more, and only a cap already reached
         withholds outright.

         WITHHELD IS NOT STOPPED. Everything else in this cycle still runs -
         the waitlist prune below, the diagnostics after the loop, the
         overflow and retirement passes, and the heartbeat in `finally` - so
         the console
         can see a quiet floor and the reason for it rather than an engine
         that appears to have died. Nothing here removes a seated horse; the
         floor drains only through the paths that already exist. */
      const cycleWithheld = withheldReason(globalPolicy, {
        nowUTCHour: hourUTC,
        seatedHorses: seatedHorseCount,
      });
      /* How many more horses may take a seat anywhere this cycle. Infinity is
         the default and means "no ceiling", which is today's behaviour. */
      let seatBudget =
        globalPolicy.maxHorses === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, globalPolicy.maxHorses - seatedHorseCount);

      /* ── OPERATION STABLE HAND: THE PER-HOST UNIQUE-OCCUPANCY CAP ────────
         The floor is capped per HOST, not per club and not per table, because
         one body holding four seats is one body. Without this the planner's
         wind-down is pointless: it stands a horse up and this cycle seats
         another thirty seconds later, which is a cash-out and a buy-in per
         horse per cycle and the loudest tell a floor can have.

         IT ONLY EVER REFUSES A NEW BODY. Nothing here stands anybody up, and
         a horse already seated on the host may still open another table - the
         cap is on bodies, so multi-tabling is untouched. Every failure path
         lands on NO CAP, which is exactly today's behaviour:

           - the controller switched off              -> no cap
           - the membership map did not load          -> no cap (it is cleared
             when the read is incomplete, so the count is 0 and is skipped)
           - a host whose population reads as zero    -> no cap
           - a human short-handed at the table        -> bypassed outright

         A cap already exceeded refuses NEW bodies and waits; the floor walks
         down through the paths that already exist (session ends, bust-outs,
         the planner's wind-down) rather than being emptied by this file. */
      const hostOfTable = new Map<string, string>();
      for (const t of tables) hostOfTable.set(String(t.id), String((t as any).club_id ?? ''));
      const eligibleByHost = new Map<string, number>();
      if (controllerEnabled()) {
        for (const [hostId, wallets] of Object.entries(WALLETS_FOR_HOST)) {
          let bodies = 0;
          for (const clubs of memberships.values()) {
            if (wallets.some((w) => clubs.has(w))) bodies++;
          }
          if (bodies > 0) eligibleByHost.set(hostId, bodies);
        }
      }
      const stableHandCaps = stableHandHostCaps(eligibleByHost, chicagoNow());
      const bodiesOnHost = bodiesOnHostFrom(allActiveSeats, hostOfTable);
      /* WHERE EACH HORSE ALREADY IS. One body plays one club and one host at a
         time (section 11), and both are read from the live seat map rather
         than from stable_hand_horse_state: the seat rows are what actually
         happened, and the state table's mirror of them is written by this
         cycle rather than trusted by it. */
      const activeClubOf = new Map<string, string>();
      const activeHostOf = new Map<string, string>();
      for (const seat of allActiveSeats) {
        if (!horseIdSet.has(seat.user_id)) continue;
        const club = (seat as { club_id?: string | null }).club_id;
        if (club && !activeClubOf.has(seat.user_id)) activeClubOf.set(seat.user_id, String(club));
        const host = hostOfTable.get(String(seat.table_id));
        if (host && !activeHostOf.has(seat.user_id)) activeHostOf.set(seat.user_id, host);
      }
      /* WHAT THE SHAPE ASKED FOR. Empty when the controller is off or its plan
         has expired, which puts every table back on its own per-table target -
         today's behaviour, unchanged. */
      const shapeBoosts = controllerEnabled() ? seatBoosts() : new Map<string, number>();
      let hostCapRefused = 0;
      if (stableHandCaps.size > 0) {
        console.log(
          `[HorseFleet] Stable Hand caps this cycle: ` +
            [...stableHandCaps]
              .map(([h, c]) => `${h.slice(0, 8)}=${bodiesOnHost.get(h)?.size ?? 0}/${c}`)
              .join(' ')
        );
      }
      if (cycleWithheld) {
        console.log(
          `[HorseFleet] Seating withheld this cycle (${cycleWithheld}) - the cycle still ` +
            'prunes, reports and beats; no seated horse is touched.'
        );
      }

      /* ── THE SEAT MAP IS INDEXED ONCE (2026-09-06, measured) ──────────────
         `allActiveSeats` is a flat array of every open seat on the platform -
         about 2,000 rows - and three places used to scan the whole of it per
         TABLE: `humanShort` below, and `tableOccupiedSeats` in the seeding
         loop. `humanShort` is called from inside a comparator, so a sort of
         ~1,100 tables ran it roughly 2 x 1,100 x log2(1,100) times - on the
         order of 4 x 10^7 row visits to decide an ORDER, before a single seat
         was filled.

         That is the biggest single cost in a cycle that measures 19-118
         seconds, and the cycle time is not a cosmetic number: it is why the
         feeder abandon window had to be widened to six minutes ("three
         minutes is shorter than one worst-case cycle plus a tick interval",
         migration 20260906015029), which is in turn why an opening feeder can
         sit empty for eight minutes. One pass to index, then every lookup is
         O(1). */
      const seatsByTable = new Map<string, typeof allActiveSeats>();
      for (const s of allActiveSeats) {
        const list = seatsByTable.get(s.table_id);
        if (list) list.push(s);
        else seatsByTable.set(s.table_id, [s]);
      }
      // V8: tables with a short-handed HUMAN seed first (never leave a human
      // stranded); everything else keeps its natural order. Precomputed rather
      // than recomputed inside the comparator - same predicate, same answer.
      const humanShortIds = new Set<string>();
      for (const [tableId, seats] of seatsByTable) {
        if (seats.length < 4 && seats.some((x) => !horseIdSet.has(x.user_id))) {
          humanShortIds.add(tableId);
        }
      }
      const humanShort = (t: { id: string }): boolean => humanShortIds.has(t.id);
      /* A STABLE FLOOR, NOT A DIFFERENT RANDOM SUBSET EVERY CYCLE.
         Now that a full table is filled to max in ONE pass rather than one or
         two seats at a time, the fleet runs out of horses partway down this
         list - 209 open cash configs and 1,091 tables against a fleet that can
         seat perhaps 1,500 at four tables each. Which tables get the horses is
         therefore decided here, and it must be decided the SAME WAY every
         cycle: an unstable order would fill a different few hundred tables
         each pass, and every horse in the room would stand up and move for no
         reason anybody watching could see.

         Humans first (never leave a person short-handed), then table id, which
         is stable, opaque and spreads the populated set across variants and
         stakes rather than favouring whatever the database happened to return
         first. */
      /* A MUST-MOVE GAME'S TABLES COME FIRST (OPORD 1.4 18.4: "an enabled
         game's Main 1 is the fleet's responsibility ... seeded to the horse
         occupancy target"). The fleet runs out of horses partway down this
         list; a cluster table at the back sat at 0 for an hour on 2026-09-04
         while a dozen fleet clones were filled ahead of it. Dan: "you have to
         add horses to the game, or show them it's available". Humans still
         first, then the clusters, then everything else by id. */
      /* Inside a game, the mains before the feeder and Main 1 before Main 2:
         a horse seated on a feeder while a main has a seat open is a horse
         the controller must then move (2026-09-05). */
      /* AN OPENING FEEDER COMES BEFORE EVERYTHING (2026-09-05). The
         controller opens a feeder only when Main 1 is full AND this fleet has
         just reported two or more horses that could sit in the game. Ranked
         last, that feeder waited behind ~140 cluster tables for a budget the
         cycle spends in 1-5 seats, took at most one horse (a sparse table's
         target can be 1), never reached the two it needs to go live, and was
         abandoned at three minutes: 36 feeders opened in two hours, 2 went
         live, 31 abandoned. The fleet promised the buyers; it seats them
         first. A LIVE feeder ranks after the mains as before, because a horse
         on it while a main has a chair is a horse the controller must move. */
      const clusterRank = (t: {
        cluster_id?: string | null;
        role?: string | null;
        main_index?: number | null;
        lifecycle?: string | null;
      }) =>
        !t.cluster_id
          ? 0
          : t.lifecycle === 'opening'
            ? -1
            : t.role === 'feeder'
              ? 1000
              : Number(t.main_index ?? 999);
      const orderedTables = [...tables].sort(
        (a, b) =>
          Number(humanShort(b)) - Number(humanShort(a)) ||
          Number(!!b.cluster_id) - Number(!!a.cluster_id) ||
          clusterRank(a) - clusterRank(b) ||
          String(a.id).localeCompare(String(b.id))
      );

      /* ── A HORSE ANSWERS A SEAT CALL ────────────────────────────────────
         Dan 2026-08-31, binding: "MAKE HORSES ANSWER A SEAT CALL... THEY
         SHOULD NEVER BE SKIPPED."

         Before this, fn_offer_open_seat selected the head of the queue with
         `AND NOT COALESCE(p.is_horse,false)`, so a horse could hold a place in
         line forever and never be offered the seat: 10,004 of 10,055 waitlist
         rows are horses, 301 of them in the last 24 hours, and not one was
         ever offered. The rule is the same one the RIT offer already learned
         (scheduleHorseRITResponses, 2026-08-18: "horses never answered
         rit_offer, so ANY horse in the all-in set let the offer expire") —
         the answer is to make the horse respond, never to skip it.

         BEFORE the seeding loop, deliberately. The hold only stops further
         OFFERS (fn_offer_open_seat counts holds against max_players); it does
         not stop this manager seeding a different horse into that very seat.
         Claiming first is what makes the hold mean something. */
      /* Who is actually waiting for a seat, read once for the whole floor.
         This is the only input to the 2026-09-02 release rule. */
      const humansWaitingByTable = await this.humansWaitingByTable(horseIdSet);

      /* HORSES DO NOT QUEUE ANY MORE (Dan 2026-09-02): every horse row comes
         out of every waiting list, on a full table as much as a sparse one.
         Done ONCE for the whole floor, here, rather than once per table inside
         the loop below - that was one round trip per table, 1,131 of them in
         sequence, and on a saturated database it is what stretched a 30-second
         cycle to 47 minutes. See the cycle-duration warning in finally. */
      await this.pruneHorseWaitlist(horseIdSet);

      /* WHERE EACH HORSE IS ALREADY REPRESENTING A CLUB, per scope. The seat
         it holds decides its wallet for a second seat in the same union
         (fn_seat_club_for_user_membership_unchecked, Dan 2026-08-21 "one club
         at a time"), and the engine must reach the same answer the database
         will, or it gates on one roll and the database debits another. The
         EARLIEST open seat wins, exactly as the function orders by joined_at. */
      const tableScope = (t: { club_id?: string | null; union_id?: string | null }): string =>
        t.union_id ?? t.club_id ?? '';
      const tableById = new Map(tables.map((t) => [t.id, t] as const));
      const seatClubInScope = new Map<string, Map<string, string>>();
      const seatJoinedAt = new Map<string, number>();
      /* A HELD TOURNAMENT SEAT DECIDES THE WALLET TOO (2026-09-09). The
         database rule reads `t2.union_id = v_union` over EVERY open seat, and
         a Midway Union tournament table carries the union id exactly as a
         cash table does. This loop looked seats up in `tableById` - the CASH
         floor only - so for a horse sitting in a Midway event the engine
         hash-picked a wallet, gated the roll, sized the buy-in, read the tag
         and judged the mutex on it, sent it as p_club_id, and the database
         debited the OTHER club: the one its tournament seat already holds,
         which wins over p_preferred_club. Measured 2026-09-09 against
         production: 448 of 584 Midway horses held a union seat the database
         would honour, the engine saw 24 of them, and for 145 the two picks
         disagreed. The tournament read above carries the scope now; when it
         failed the map is empty and those seats are unknown here, which is
         the same fail-open the booking loader already declares. */
      const scopeOfSeatTable = (tableId: string): string | undefined => {
        const t = tableById.get(tableId);
        if (t) return tableScope(t);
        return tournamentTableScope.get(tableId);
      };
      for (const seat of allActiveSeats) {
        const scope = scopeOfSeatTable(seat.table_id);
        if (scope === undefined || !seat.club_id) continue;
        const joined = Date.parse(seat.joined_at ?? '') || Number.MAX_SAFE_INTEGER;
        const key = `${seat.user_id}:${scope}`;
        const prev = seatJoinedAt.get(key);
        if (prev !== undefined && prev <= joined) continue;
        seatJoinedAt.set(key, joined);
        if (!seatClubInScope.has(seat.user_id)) seatClubInScope.set(seat.user_id, new Map());
        seatClubInScope.get(seat.user_id)!.set(scope, seat.club_id);
      }
      const membership: SeatClubContext = {
        eligibleClubsFor,
        tableScope,
        seatClubInScope,
        memberships,
        known: bankrollsLoaded,
      };
      // Horse/table pairs refused because the horse holds no membership that
      // can pay for that table. Loud, like rollUnknown: the silent version of
      // this number is what hid the Midway floor for a day.
      let clubDropped = 0;
      /* Horse/table pairs refused by the horse's OWN tag - wrong game, wrong
         stake, or a horse that does not play cash at all. Reported like
         clubDropped, because the silent version of this number is what hid the
         Midway floor for a day. */
      let tagDropped = 0;
      /* Horse/table pairs where the tag's every stake names a closed game and
         the merit band decided instead (see the stake gate). */
      let strandedTagFallthrough = 0;
      /* Refusals from the Stable Hand mutex, by reason, for the cycle log.
         A gate whose refusals are invisible is a gate nobody can tune. */
      const mutexRefused = new Map<SitRejection, number>();
      /* `${horseId}:${tableId}` -> the game key that seat was taken on, so the
         daily counter is written against the key the mutex actually judged. */
      const sitKeyOf = new Map<string, string>();
      /* Counter writes for this cycle, flushed ONCE at the end. */
      const stateMutations: StateMutation[] = [];
      const todayKey = chicagoCounterDay();
      let restDayDropped = 0;
      let dailyCapDropped = 0;
      /* Horse/table pairs refused at the fleet's own door because the
         database's door would refuse them: barred for low VPIP from this
         game, or holding a rejoin floor the horse's wallet cannot cover.
         Reported with the tag counters, because a barred horse that is still
         counted as a buyer is exactly the number that opened eleven empty
         feeders in an hour. */
      let barredDropped = 0;
      let floorUnaffordableDropped = 0;
      /* A BOOKING IS A GAME (2026-09-06). Horse/table pairs refused because
         the horse is already committed to four games counting its tournament
         bookings - the refusal the database was making 10,577 times in four
         hours while the fleet counted the horse as a buyer. Reported with the
         other door counters for the same reason: the silent version of this
         number opened a feeder every five minutes for players who could not
         take a seat. See HorseGameLoad. */
      let bookedOutDropped = 0;
      /* The horse's OWN cash ceiling (its tag's max_tables) refusing another
         cash table. `mayEnterAnotherGame` said no and nothing counted it. */
      let ownCeilingDropped = 0;
      /* Sittable horses a table's pool left out because the hour is outside
         their activity window - the number the "No available horses" line
         had been hiding: a table with three sittable horses, all asleep, and
         a table with none read identically. */
      let asleepDropped = 0;
      /* Cluster tables under the dealable minimum whose awake pool could not
         reach two and were offered the whole sittable pool instead. */
      let hourWidened = 0;
      /* THE TAG BOOK. Null when it could not be read WHOLE, and every gate
         that consults it is written so that null means "today's behaviour,
         unchanged". */
      const nowMs2 = Date.now();
      const book = controllerEnabled() ? await tagBook.load() : null;
      const chicagoWeekday = chicagoNow().weekday;
      if (book) {
        console.log(
          `[HorseFleet] Tag book: ${book.tags.size} membership tag(s), ${book.states.size} horse state(s)`
        );
      } else if (controllerEnabled()) {
        console.warn(
          '[HorseFleet] Tag book unread this cycle - seating from the hash rules, unchanged.'
        );
        /* AND SAY SO WHERE SOMEBODY WILL SEE IT. A console line on a box
           nobody is tailing is not an observable: this exact failure ran for
           four hours on 2026-09-04 - the book read fine from a laptop with the
           same key and returned null on the engine - and the only reason it
           was found was a hand query against the counters it should have
           written. Failing open is correct; failing open SILENTLY is not.
           Throttled to once an hour and raised on change only. */
        if (nowMs2 - this.lastTagBookComplaintAt >= 60 * 60_000) {
          this.lastTagBookComplaintAt = nowMs2;
          await supabase
            .rpc('fn_raise_server_financial_alert', {
              p_severity: 'warning',
              p_source: 'HorseFleet.tagBook',
              p_message:
                'The Stable Hand tag book could not be read whole this cycle, so seating is ' +
                'running on the old hash rules and no daily counter is being written. The ' +
                'fleet is unharmed - every gate fails open - but the tag layer is switched ' +
                'off until this reads clean.',
              p_context: { kind: 'stable_hand_tag_book_unread' },
              p_entity_id: 'stable_hand',
            })
            .then(
              () => undefined,
              (err: unknown) => reportError(err, 'HorseFleet.tagBookAlert')
            );
        }
      }

      /* A seat call is still a NEW seating, so it obeys the switch and the
         budget with everything else. The offer itself is left untouched: the
         hold belongs to fn_offer_open_seat's own sweep, which expires it and
         passes the seat to the next player in line. A draining table is still
         never answered, whatever the policy says. */
      const claimed = cycleWithheld
        ? 0
        : await this.claimOfferedSeats(
            tables,
            allActiveSeats,
            bankrolls,
            bankrollsLoaded,
            horseIdSet,
            membership,
            surplusTableIds,
            seatBudget,
            rejoin,
            disabledGameIds
          );
      seatBudget -= claimed;
      beat.seatsFilled += claimed;
      if (claimed > 0) {
        console.log(`[HorseFleet] ${claimed} horse(s) answered a seat call`);
      }

      /* An empty list, not an early return: the loop is the only thing
         withheld, and everything after it still runs. */
      const tablesToSeed = cycleWithheld ? [] : orderedTables;
      let tablesSeeded = 0;
      let disabledGameTables = 0;
      let firstTableWithheld: string | null = null;
      /* THE CLUSTER'S DEMAND IS COUNTED EVERY CYCLE, FULL TABLE OR NOT
         (2026-09-05). `lastEligibleByTable` used to be written only for a
         table this loop reached the candidate filter for - i.e. one with a
         seat to fill - and was never cleared, so a FULL Main 1 (the one state
         in which the controller needs the number, to open a feeder) reported
         whatever it had the last time it had room, for ever. Built fresh here
         and swapped in whole at the end, so a reader never sees a half-built
         cycle; a withheld cycle honestly reports nothing. */
      const nextEligible = new Map<string, number>();
      /* A BUYER IS COUNTED ONCE (2026-09-05). For every cluster table the
         POOL is kept, not its length, and each horse's remaining table
         capacity is kept beside it; after the loop `allocateBuyers` walks the
         pools in this same seeding order and hands each horse out once. The
         same two free horses used to be counted as buyers for every full Main
         1 on the host at once. See HorseBuyerAllocation. */
      const clusterPools: BuyerPool[] = [];
      const capacityByHorse = new Map<string, number>();
      /* A DOOR THAT SAID "FULL" IS NOT ASKED AGAIN THIS CYCLE (2026-09-11).
         `FOUR TABLE LIMIT` and `TABLE_CAP_REACHED` are the database counting
         the horse's games, and nothing this cycle can lower that count - the
         cycle only ever ADDS seats. The seeding walk nonetheless offered the
         same horse to the next table, and the next: 97 seat-side refusals in
         24 hours, each one a locked buy-in RPC (an advisory lock, a wallet
         read and a rollback) spent to be told what the previous table already
         said. Every other refusal is per TABLE - the seat was taken, the
         table closed, the floor was too high - and stays per table. */
      const cappedThisCycle = new Set<string>();
      /* ONE SIT PREDICATE FOR THE COUNT AND THE CHAIR (2026-09-05). The seat
         stage used to ask four questions the candidate filter never asked -
         wallet, buy-in, aggregate ceiling, mutex - and `continue` silently on
         each. The controller was told "2 buyers" for horses that would never
         sit, opened a feeder every five minutes, and abandoned it empty every
         time. `sitVerdictFor` is now the ONE answer, asked for the count (a
         cluster table's pool is the SITTABLE pool) and asked again for the
         chair. It is pure; the telemetry it would emit comes back with the
         verdict and is emitted here, where the decision is acted on. The maps
         are the cycle's live maps, so a seat bought this cycle is visible to
         the next verdict, exactly as before. See HorseSitVerdict. */
      const sitCtx: SitVerdictContext = {
        resolveSeatClub: (t, id) => this.resolveSeatClub(membership, t, id),
        sizeBuyIn: (t, id, club, floor) => {
          const telemetry: BankrollEvent[] = [];
          const buyIn = this.computeHorseBuyIn(
            t,
            id,
            bankrolls,
            bankrollsLoaded,
            club,
            floor,
            (e) => telemetry.push(e)
          );
          return { buyIn, telemetry };
        },
        bankrolls,
        bankrollsLoaded,
        rejoin,
        horseTables,
        horseExposure,
        activeClubOf,
        activeHostOf,
        book,
        todayKey,
        chicagoWeekday,
        /* ONE MOMENT FOR THE WHOLE PASS. `nowMs2` is taken once, above the tag
           book load, so every two-hour-window verdict in this cycle is judged
           against the same clock rather than drifting across a pass that takes
           seconds. */
        nowMs: nowMs2,
        killed: stableHandKilled(),
        maxTablesPerHorse: MAX_TABLES_PER_HORSE,
      };
      /* Seat-stage refusals that used to be silent, by reason, for the cycle
         line. The mutex's own reasons still go to mutexRefused. */
      const seatStageSkipped = new Map<SitSkipReason, number>();
      /* A REFUSED BUY-IN SAYS WHY (2026-09-06). What the DATABASE refused,
         after the fleet had cleared the horse - the refusals seatHorse is
         deliberately quiet about. FOUR TABLE LIMIT was 10,577 of them in four
         hours and nothing in this engine said a word. */
      const buyInRefused = new Map<BuyInRefusal, number>();
      /* Horse/table pairs a cluster table's COUNT left out because the verdict
         said no - the pairs that used to be reported to the controller as
         buyers. */
      const unsittable = new Map<SitSkipReason, number>();
      const bump = (m: Map<SitSkipReason, number>, r: SitSkipReason) =>
        m.set(r, (m.get(r) ?? 0) + 1);
      const noteSkip = (
        diag: OpeningFeederDiag | null,
        r:
          | SitSkipReason
          | 'lone_seat_refused'
          | 'lone_seat_left'
          | 'stale_snapshot'
          | `buyin_${BuyInRefusal}`
      ) => {
        if (diag) diag.skipped[r] = (diag.skipped[r] ?? 0) + 1;
      };
      /* NO LONE HORSE (2026-09-05): empty cluster tables the fleet left empty
         this cycle because only one horse could sit there. Counted once per
         table per cycle and logged once per cycle - see HorseLoneTable.ts. */
      let loneSeatRefused = 0;
      /* Empty cluster tables that still ended a cycle with ONE horse after the
         door refused the second and a second draw over the pool found nobody
         else. The lone stand (HorseLoneTable) clears these at ten minutes. */
      let loneSeatLeft = 0;
      /* THE TABLE MAY BE GONE BY THE TIME WE SEAT INTO IT (2026-09-05).
         The open-table list above was read ONCE at the top of this cycle, and
         a cycle takes 57 to 118 seconds (its own line). The controller closes
         an opening feeder nobody came to and breaks a table the whole time,
         so by the time this loop commits a horse the row it is holding can
         already be `closed` - and `fn_refuse_seat_on_closed_cluster_table`
         then raises TABLE_CLOSING, fifteen times in twenty-five minutes on
         2026-09-05. Each one is a horse spent on a door that was shut.

         ONE batched read per cycle, as late as the loop allows: it is issued
         lazily on the first seat this cycle actually attempts, so a cycle
         that seats nobody asks nothing, and a cycle that does asks once and
         gets the freshest answer the loop can act on. Not one query per
         table, and never one per horse.

         Fail OPEN on an error or a short read, like the bankroll, rejoin and
         disabled-game loaders: a bad read must not stop the floor filling.
         See HorseStaleTable. */
      const clusterIdsToSeed = [
        ...new Set(tablesToSeed.filter((t) => t.cluster_id).map((t) => t.id)),
      ];
      let doors: DoorSnapshot = unknownDoors();
      let doorsAsked = false;
      let staleTablesSkipped = 0;
      /* NO BARE EARLY EXIT IN HERE, deliberately - it is latched with a flag
         and an `if` instead of returning. The contract pinned by
         HorseFleetPolicyWiring ("a withheld cycle is a skipped seating list,
         NOT an early return") is asserted by reading this method's SOURCE for
         the bare keyword, so a closure that exits early reads exactly like a
         cycle that bailed out, and so does a comment that spells it. */
      const readDoorsOnce = async (): Promise<void> => {
        const first = !doorsAsked;
        doorsAsked = true;
        if (first && clusterIdsToSeed.length > 0) {
          try {
            const doorPage = await fetchAllRows<{
              id: string;
              lifecycle?: string | null;
              status?: string | null;
            }>(
              (cursor, want) => {
                let q = supabase
                  .from('tables')
                  .select('id, lifecycle, status')
                  .in('id', clusterIdsToSeed)
                  .order('id', { ascending: true })
                  .limit(want);
                if (cursor) q = q.gt('id', cursor);
                return q;
              },
              { label: 'HorseFleet.doorRecheck', maxRows: 50_000 }
            );
            if (doorPage.complete) {
              doors = doorsFromRows(doorPage.rows);
            } else {
              beat.staleDoorReadFailed = 1;
              console.warn(
                '[HorseFleet] door re-read incomplete - seating this cycle on the ' +
                  'top-of-cycle snapshot (fail open); a closed table may refuse a buy-in.'
              );
            }
          } catch (err) {
            beat.staleDoorReadFailed = 1;
            reportError(err, 'HorseFleet.door_recheck_failed');
          }
        }
      };
      for (const table of tablesToSeed) {
        let diag: OpeningFeederDiag | null = null;
        try {
          /* THE DIAGNOSTIC IS OPENED FIRST (2026-09-06). It used to be created
             AFTER the three `continue`s below, so an opening feeder skipped
             for surplus, for `breaking`/`closed`, or for a disabled game
             produced no `opening_feeders` entry and no console line at all -
             the one diagnostic these sessions rely on went silent exactly when
             a feeder was being skipped STRUCTURALLY, which is the case hardest
             to guess from the outside. Opened here, and each skip names itself
             in `withheld` on the way out. */
          if (table.cluster_id && table.lifecycle === 'opening') {
            diag = {
              table_id: table.id,
              name: String(table.name ?? ''),
              candidates: 0,
              sittable: 0,
              wanted: 0,
              reserved: 0,
              empty_seats: 0,
              selected: 0,
              seated: 0,
              skipped: {},
              withheld: null,
            };
          }
          // A draining table gets no new horses. Without this the surplus can
          // never empty, and so can never be retired.
          if (surplusTableIds.has(table.id)) {
            if (diag) diag.withheld = 'surplus_draining';
            continue;
          }
          // A cluster table that is breaking (18.3: no new sit-ins) or closed
          // gets none either; the controller is walking its players out.
          if (table.lifecycle === 'breaking' || table.lifecycle === 'closed') {
            if (diag) diag.withheld = `lifecycle_${table.lifecycle}`;
            continue;
          }
          /* A table of a DISABLED game gets none either (18.4: no seeding).
             Before any seat arithmetic and before the pool is kept for
             nextEligible, so the game reports 0 eligible - which is exactly
             what lets fn_cash_cluster_tick mark it dormant and close its
             empties instead of the fleet refilling them. Counted, and the
             count reaches the cycle line. */
          if (isTableOfDisabledGame(table, disabledGameIds)) {
            disabledGameTables++;
            if (diag) diag.withheld = 'game_disabled';
            continue;
          }

          // Determine currently occupied seats for THIS table from our in-memory map
          // Indexed once at the top of the cycle - see seatsByTable. This was
          // a full scan of every open seat on the platform, per table.
          const tableOccupiedSeats = seatsByTable.get(table.id) ?? [];
          const occupiedNumbers = new Set(tableOccupiedSeats.map((s) => s.seat_number));
          /* A planned arrival holds its seat (see pendingMovesByTable). */
          const currentCount = occupiedNumbers.size + (pendingMovesByTable.get(table.id) ?? 0);
          /* A cluster table with nothing to fill still answers the
             controller's question (how many horses COULD sit in this game);
             it runs the candidate filter and seats nobody. */
          let countOnly = false;

          // ── V14 OCCUPANCY (Dan 2026-08-23) ────────────────────────────────
          // Every table used to carry ONE fixed target from DEFAULT_TABLES, so
          // the lobby looked the same hour after hour: the same games at the
          // same counts, every one a seat or two short of full, none of them
          // ever with a queue. A real floor is lopsided. The target now drifts
          // per table on a ~22 minute bucket - hot (full, with a list), busy,
          // steady (2-3 open), quiet (short-handed and visibly looking) - and
          // is deterministic in (table, bucket) so it holds still long enough
          // to be read instead of thrashing seats every 30s cycle.
          /* Counted rather than tested, because `min_humans_to_seat` needs
             the number. `humanAtTable` is the same boolean it always was. */
          const humansAtTable = tableOccupiedSeats.filter((x) => !horseIdSet.has(x.user_id)).length;
          const humanAtTable = humansAtTable > 0;
          /* THE ONE THING THAT OPENS A SEAT (Dan 2026-09-02). Humans on this
             table's waiting list, counted from the same map for every table so
             the seeding loop stays one query deep. Horses are excluded by id:
             they no longer queue at all, and a horse in the count would make a
             horse stand up for a horse. */
          const humansWaiting = humansWaitingByTable.get(table.id) ?? 0;
          /* THIS TABLE'S POLICY, from its own club scope. A club row wins
             field by field over the global row (the RPC does that merge), so
             a club can be paused without touching the rest of the floor.
             Asked here, before any seat arithmetic, so a withheld table costs
             nothing and says why. */
          const policy = policyFor(table.club_id);
          const tableWithheld = withheldReason(policy, {
            nowUTCHour: hourUTC,
            seatedHorses: seatedHorseCount,
            seatedAtTable: currentCount,
            humansAtTable,
            stakeBand: stakeBandForBigBlind(table.big_blind),
            variant: table.game_variant,
          });
          if (tableWithheld) {
            beat.withheldTables++;
            if (firstTableWithheld === null) firstTableWithheld = tableWithheld;
            if (diag) diag.withheld = tableWithheld;
            continue;
          }
          if (seatBudget <= 0) {
            beat.withheldTables++;
            if (firstTableWithheld === null) firstTableWithheld = 'max_horses_reached';
            if (diag) diag.withheld = 'max_horses_reached';
            continue;
          }

          const target = occupancyTargetFor(
            table.id,
            table.max_players,
            humanAtTable,
            Date.now(),
            humansWaiting
          );
          const { fill } = target;
          let { seatTarget } = target;
          // Activity floor (see fleetBoost above). A full table is already at
          // max and cannot be lifted; this only ever helps a sparse one.
          if (fleetBoost) {
            seatTarget = Math.min(table.max_players, seatTarget + 1);
          }
          /* THE POLICY SCALES THE TARGET, IT DOES NOT REPLACE IT. A bias of
             1.0 - the default, and what an absent policy row returns - leaves
             `seatTarget` exactly as occupancyTargetFor computed it, so this
             line changes nothing at all until an operator sets a bias. The
             clamp is Dan's floor: no bias may take a table below one seat. */
          seatTarget = applyBias(seatTarget, policy.occupancyBias, table.max_players);

          // A full table with a vibe that says "hot" grows a WAITING LIST
          // rather than simply being full - that queue is the thing that makes
          // a game look like the game everyone wants.
          //
          // Dan 2026-08-26: and ONLY a genuinely full table. A queue behind a
          // table with open seats is a visible lie ("Waiting 54" beside an
          // OPEN seat map), so any table that is not at max prunes its horse
          // rows to zero — including the case where the vibe target is below
          // max. Humans in the queue are never touched.
          /* HORSES DO NOT QUEUE ANY MORE (Dan 2026-09-02). waitTarget is 0 for
             every table now, and the horse rows were cleared floor-wide above,
             before this loop, in one round trip. A waiting list is the signal
             that a real person wants in, and it has to mean only that: a horse
             standing in the queue both delays that person and makes "is a
             human waiting" unanswerable. */
          /* THE CAP IS APPLIED LAST, AFTER THE BIAS, on purpose: a bias above
             1.0 applied to an already-capped target would lift it back over
             the cap, and a cap of N that can seat N+1 is not a cap. With no
             cap this is `seatTarget - currentCount`, the same subtraction that
             was here before, and a table already at or over its target still
             seats nobody rather than standing anybody up. */
          /* ── THE SHAPE'S OWN ASK ────────────────────────────────────────
             `occupancyTargetFor` decides what ONE table should look like on
             its own 22-minute drift. The planner decides what the FLOOR should
             look like - 60% full, 20% with a seat open, 20% joinable - and
             those are different questions. Where the planner has asked for a
             table to be fuller, its number wins, clamped to the seats that
             exist. It can only ever raise the target: a shape order that could
             LOWER one would be a stand order, and stands go through the
             executor where the leave path is. */
          const boost = shapeBoosts.get(table.id);
          if (boost !== undefined && boost > 0) {
            seatTarget = Math.min(table.max_players, Math.max(seatTarget, currentCount + boost));
          }
          /* AN OPENING FEEDER IS SEEDED TO TWO, NOW (2026-09-05). The
             controller promotes a feeder to live at two seated (18.3) and
             abandons an empty one at three minutes. A sparse table's vibe
             target can be 1, and the 1-2 trickle below could leave it at 1
             for a cycle - one horse alone on a table that cannot deal, then
             moved to the next Main chair, then an empty feeder abandoned. The
             feeder exists because this fleet said two horses could sit; two
             sit, in this cycle, and the vibe takes over once it is live. */
          const openingFeeder = !!table.cluster_id && table.lifecycle === 'opening';
          /* ...AND SO IS EVERY OTHER CLUSTER TABLE AT 0 OR 1 (2026-09-05, NO
             LONE HORSE). The opening-feeder rule above was the right rule for
             the wrong set: measured the same afternoon, 47 of 140 live cluster
             tables held exactly one horse (46 the only table of their game),
             seated 253 minutes on average, 39 with no hand in thirty minutes.
             A sparse table's vibe target can be 1, and once it is met nothing
             adds a second. A cluster table is seeded to a dealable minimum or
             not at all - see HorseLoneTable.ts; the refusal that keeps a single
             horse off an EMPTY table is at the seat stage below. Non-cluster
             tables keep their old arithmetic. */
          const seedToDealable = !!table.cluster_id && currentCount < DEALABLE_MINIMUM;
          if (openingFeeder || seedToDealable) {
            seatTarget = Math.min(table.max_players, Math.max(seatTarget, DEALABLE_MINIMUM));
          }
          const seatsAllowed = capBySeatedCount(seatTarget, currentCount, policy.maxPerTable);
          if (seatsAllowed <= 0) {
            if (!table.cluster_id) continue;
            countOnly = true;
          }
          let seatsNeeded = Math.max(0, seatsAllowed);

          /* A FULL TABLE FILLS IN ONE GO; A SPARSE ONE STILL TRICKLES.
             The 1-2 per cycle stagger was there so a game did not appear out
             of nowhere, and at 30 seconds a cycle it takes four minutes to
             fill a nine-hander - four minutes in which the table is visibly
             short and, worse, in which the fleet has spread its horses one per
             table across a floor of a thousand tables instead of filling any
             of them. Dan asked for full tables, so the tables that are meant
             to be full are filled now and the pacing stays where it still
             reads as human: the sparse quarter, and a human's rescue. */
          const humanNeedsRescue = humanAtTable && currentCount < 4;
          if (fill !== 'full' && !humanNeedsRescue) {
            seatsNeeded = Math.min(seatsNeeded, 1 + Math.floor(Math.random() * 2));
          }
          /* ...except the two that make a cluster table dealable (see
             seedToDealable above): an opening feeder, and any cluster table at
             0 or 1. Never above seatsAllowed. */
          seatsNeeded = seatsToDealable({
            clusterTable: !!table.cluster_id,
            currentCount,
            seatsNeeded,
            seatsAllowed,
          });
          /* The fleet-wide cap, spent down as the floor fills. Last, so it
             cannot be undone by anything above it. */
          seatsNeeded = Math.min(seatsNeeded, seatBudget);
          if (diag) diag.wanted = seatsNeeded;
          if (seatsNeeded <= 0) {
            if (!table.cluster_id) continue;
            countOnly = true;
          }

          // Find empty seat numbers
          const emptySeats: number[] = [];
          for (let s = 1; s <= table.max_players && emptySeats.length < seatsNeeded; s++) {
            if (!occupiedNumbers.has(s)) emptySeats.push(s);
          }
          if (diag) diag.empty_seats = emptySeats.length;
          if (emptySeats.length === 0) {
            if (!table.cluster_id) continue;
            countOnly = true;
          }

          // Find candidate horses:
          // 1. Not already at this table
          // 2. Not exceeding 4 max tables
          /* The game key the door rules are written against (club, variant,
             sb, bb), formatted once per table. See rejoinTableKey. */
          const constraintTableKey = rejoinTableKey(table);
          const candidateHorses = validHorses.filter((h) => {
            /* THE DATABASE ALREADY SAID THIS HORSE IS FULL (2026-09-11). It
               refused a buy-in for it at an earlier table in THIS cycle with
               the platform game limit, and nothing here lowers that count.
               See cappedThisCycle. */
            if (cappedThisCycle.has(h.id)) {
              bookedOutDropped++;
              return false;
            }
            /* A HORSE PLAYS INSIDE ITS OWN CLUB (Dan 2026-09-02): only a horse
               whose membership can pay for this table is a candidate for it.
               `null` is "no such membership" and excludes; `undefined` is
               "the map did not load" and lets the database decide, exactly as
               the bankroll gate fails open below. See resolveSeatClub.

               ASKED FIRST NOW (2026-09-04), because the tag is per MEMBERSHIP:
               a horse holds a JAQK tag and a Shark tag independently, and
               which one applies is decided by which wallet pays for this
               seat. */
            const seatClub = this.resolveSeatClub(membership, table, h.id);
            if (seatClub === null) {
              clubDropped++;
              return false;
            }

            /* ── THE DOOR (2026-09-05). A horse barred from THIS game for low
               VPIP is not a candidate for it - the database would refuse the
               seat (VPIP_BARRED) and, until today, did, 341 times an hour,
               after the fleet had already counted the horse as a buyer. A
               human sees GAME_BARRED in the lobby and does not try; neither
               does the fleet. Every table, cluster or not. */
            const doorKey = rejoinPlayerKey(h.id, constraintTableKey);
            if (rejoin.barred.has(doorKey)) {
              barredDropped++;
              return false;
            }

            /* ── THE TAG DECIDES, AND WHERE THERE IS NO TAG THE OLD HASH DOES
               ────────────────────────────────────────────────────────────────
               `horses:tag` wrote 1,580 of these on 2026-09-04 and nothing read
               one until today: mode, variants, preferred stakes and the table
               ceiling were all still being derived from a hash of the horse's
               id, which is why every horse played every variant.

               EVERY GATE BELOW IS THREE-VALUED. `false` refuses, `true`
               allows, and `undefined` means "no tag was read" - in which case
               the rule that was here before decides, unchanged. That is the
               same fail-open contract as the bankroll gate two blocks down,
               and for the same reason: a tag we could not read is not a horse
               with no tag. See StableHandTags. */
            /* `undefined` seatClub is the membership map failing to load. No
               scope means no tag, which every gate below reads as "no
               opinion" - the same fail-open answer the club gate itself
               gives on that branch. */
            const tag = seatClub ? book?.tags.get(tagKey(h.id, seatClub)) : undefined;

            // Dan 2026-08-26 game lanes: a third of the stable plays events
            // only (tournaments / spins / heads-up) and never sits at cash.
            const cashOk = tagAllowsCash(tag);
            if (cashOk === false) {
              tagDropped++;
              return false;
            }
            if (cashOk === undefined && gameLaneFor(h.id) === 'events') return false;

            /* THE VARIANT. Nothing before this restricted it at all, so one
               horse played Omaha-8, short deck and pineapple interchangeably.
               Measured supply before switching it on, so the floor cannot
               starve: Midway Union carries 438 NLH horses, 110 PLO4 and 45 of
               the thinnest limit variant, against 20 NLH tables and a limit
               board trimmed to two. */
            const variantOk = tagAllowsVariant(tag, String(table.game_variant ?? ''));
            if (variantOk === false && !humanNeedsRescue) {
              tagDropped++;
              return false;
            }

            /* THE STAKE. Dan 2026-08-29: a horse plays ONE stake level. The
               tag names the exact blinds rather than a band - before any of
               this, blinds were read solely to size a buy-in, and 64 of 210
               horses sat across multiple stakes in 48 hours, one at 0.10/0.20
               and 25.00/50.00 both. */
            let stakeOk = tagAllowsStake(tag, Number(table.big_blind));
            /* A TAG WITH NO GAME LEFT IN IT FALLS THROUGH TO THE BAND
               (2026-09-06). `tagAllowsStake` is exact, and a tag drawn into a
               band whose every rung the operator has closed refuses every
               table there is. Only then - never when the tag names a stake
               that is running - the tag is read as "no opinion" and the
               merit band decides, projected DOWN onto the bands that have a
               game (effectiveStakeBandFor), the way an untagged horse's is.
               Downward only, so the 25/50 regular plays 2/5 while 25/50 is
               shut, and never a micro game. */
            if (
              stakeOk === false &&
              tag &&
              tag.preferredStakes.length > 0 &&
              !tag.preferredStakes.some((s) =>
                stakesWithAGame
                  .get(String((table as { club_id?: string | null }).club_id ?? ''))
                  ?.has(Number(s).toFixed(2))
              )
            ) {
              strandedTagFallthrough++;
              stakeOk = undefined;
            }
            if (stakeOk === false && !humanNeedsRescue) {
              tagDropped++;
              return false;
            }
            if (
              stakeOk === undefined &&
              !stakeBandAllows(
                h.id,
                table.big_blind,
                String((table as { club_id?: string | null }).club_id ?? '')
              )
            )
              return false;

            /* ── THE HORSE'S OWN DAY ────────────────────────────────────────
               A rest day and a daily cap are what stop a thousand horses
               playing identical 24-hour shifts, and both were written by the
               tagger and read by nobody. A human short-handed at this table
               outranks both: a rest day is a texture, a person waiting is not. */
            const st = book?.states.get(h.id);
            if (!humanNeedsRescue && isRestDayFor(st, chicagoWeekday)) {
              restDayDropped++;
              return false;
            }
            if (!humanNeedsRescue && dailyCapReached(st, todayKey)) {
              dailyCapDropped++;
              return false;
            }
            /**
             * BANKROLL GATE (Dan 2026-08-31). A stake band says which games a
             * horse has EARNED; the bankroll says which it can AFFORD. Both
             * must agree, and this is the second one.
             *
             * The rule is denominated in buy-ins of THIS game, because a
             * chip figure means nothing across a ladder — 10,000 is fifty
             * buy-ins at 1/2 and twenty at 2/5. A horse under its policy's
             * buy-in requirement simply is not a candidate: it moves down,
             * and if nothing is left it goes to the freerolls.
             */
            if (bankrollsLoaded) {
              /**
               * AN UNKNOWN ROLL IS UNKNOWN, NOT ZERO — 2026-08-31, and this
               * line emptied the entire cash floor for 40 minutes.
               *
               * It used to `return false`, which reads as "no membership, no
               * seat" and is wrong twice over. The doctrine of this whole
               * layer, stated in the comment above the loader, is that a
               * bankroll we cannot read means NO BANKROLL OPINION — because
               * `atomic_table_buyin` still refuses a seat the balance cannot
               * cover, so this gate decides which games are SENSIBLE, never
               * which are possible. A refusal here is the one failure mode
               * the loader was carefully written to avoid, re-introduced one
               * line below it.
               *
               * And it is not hypothetical. The map was keyed on two
               * hard-coded club ids that own ZERO cash tables, so every
               * lookup for a real table missed and every horse was refused,
               * at every table, every cycle. See the loader for the rest.
               */
              const roll = seatClub ? bankrolls.get(`${seatClub}:${h.id}`) : undefined;
              if (roll === undefined) {
                rollUnknown++;
                /* THE COUNTER SPLITS; THE DECISION DOES NOT.
                   Both branches below seat the horse, and both must. This
                   fail-open is the line that kept the cash floor up for forty
                   minutes on 2026-08-31, and a 2026-09-04 change that turned
                   the very evidence below into a REFUSAL was reverted the same
                   day - two existing guards refused it. `maySeatWithUnknownRoll`
                   exists and is deliberately NOT consulted here.

                   What the evidence is worth is TELLING THE TWO APART. An
                   unreadable roll for a club the map does not cover is the
                   ordinary case - 261 of 584 horses are not members of the club
                   that owns the open cash tables. An unreadable roll for a club
                   the map DOES cover is a data fault. One number for both hid
                   that. */
                bankrollEvent(
                  seatClub && clubsWithRolls.has(seatClub)
                    ? 'seat_fail_open_roll_faulty'
                    : 'seat_fail_open_roll_unknown'
                );
                return true;
              }
              const ref = referenceBuyIn(
                table.big_blind,
                Number((table as any).min_buy_in) || undefined,
                Number((table as any).max_buy_in) || undefined
              );
              if (!canSit(roll, ref, bankrollPolicyFor(h.id))) {
                bankrollEvent('seat_refused_underrolled');
                return false;
              }
              /* THE REJOIN FLOOR MUST BE AFFORDABLE. A horse that left this
                 game with more than its roll now holds cannot meet the floor
                 the door will demand (fn_cash_effective_buyin clamps it to
                 the table max, so that is the most it can be asked for). The
                 database would refuse the buy-in; the fleet does not try, and
                 does not count the horse as a buyer. Only when the roll is
                 KNOWN - an unknown roll fails open, as above. */
              const rejoinFloorForPair = rejoin.rejoinFloor.get(doorKey);
              if (rejoinFloorForPair !== undefined) {
                const tableMax = Number((table as any).max_buy_in) || table.big_blind * 200;
                const effectiveFloor =
                  tableMax > 0 ? Math.min(rejoinFloorForPair, tableMax) : rejoinFloorForPair;
                if (effectiveFloor > roll) {
                  floorUnaffordableDropped++;
                  return false;
                }
              }
            }
            /* THE PER-HOST CAP (Operation Stable Hand). Last of the
               candidate gates, and the only one that reasons about the FLOOR
               rather than about this horse: a body already seated on this host
               is already counted and may open another table, a new body may
               not once the host is at its curve. Bypassed entirely when a
               human at this table needs the game rescued. */
            if (
              !hostAllowsNewBody({
                hostId: String((table as any).club_id ?? ''),
                horseId: h.id,
                caps: stableHandCaps,
                bodiesOnHost,
                humanNeedsRescue,
              })
            ) {
              hostCapRefused++;
              return false;
            }
            const tablesForHorse = horseTables.get(h.id);
            /* WHAT THIS HORSE IS COMMITTED TO, the way the database counts it
               (2026-09-06): live seats PLUS bookings for tournaments that have
               not started. Both rules are asked through the one function so
               the fleet and `fn_enforce_four_table_limit` cannot disagree -
               they did, 10,577 times in under four hours, and every one of
               those was a buyer the controller had already opened a feeder
               for. See HorseGameLoad. */
            let cashSeatsForHorse = 0;
            if (tablesForHorse) {
              for (const tid of tablesForHorse) {
                if (!tournamentTableIds.has(tid)) cashSeatsForHorse++;
              }
            }
            const gameLoad = {
              seats: tablesForHorse?.size ?? 0,
              bookings: bookingLoad.get(h.id) ?? 0,
              ownCashCeiling: tagMaxTables(tag, MAX_TABLES_PER_HORSE),
              /* The tag ceiling is a CASH rule (HorseGameLoad). `seats` above
                 is every open seat on the platform, tournaments included, and
                 subtracting those from a cash ceiling refused 837 tagged
                 horses cash tables they were entitled to. When the tournament
                 table read failed this set is empty, every seat counts as
                 cash, and the ceiling is exactly as strict as it was before. */
              cashSeats: cashSeatsForHorse,
            };
            /* THE HORSE'S REMAINING CAPACITY, for the buyer allocation after
               the loop. Recorded the FIRST time this cycle sees the horse, so
               the allocator replays the cycle from the position it started in
               (horseTables grows as this cycle seats; a later table's view is
               already net of those seats, which the allocator counts itself). */
            if (!capacityByHorse.has(h.id)) {
              capacityByHorse.set(h.id, remainingGameCapacity(gameLoad));
            }
            /* THE HORSE'S OWN CEILING (a grinder carries four, a mixer one)
               AND the platform's four-game limit. Asked before the seat map is
               consulted, because a horse with NO seat at all can still be
               committed to four tournaments - 172 of the 603 horses sitting at
               nothing were, on 2026-09-06. */
            if (!mayEnterAnotherGame(gameLoad)) {
              if (refusalReason(gameLoad) === 'platform') {
                bookedOutDropped++;
              } else {
                ownCeilingDropped++;
              }
              return false;
            }
            if (!tablesForHorse) return true;
            if (tablesForHorse.has(table.id)) return false;
            /* ONE SEAT PER GAME (2026-09-05). A must-move game is one game
               however many tables it has. A horse already at any of its
               tables is not a candidate for another of them - the controller
               moves players between a game's tables; the fleet never does. */
            if (table.cluster_id) {
              for (const tid of tablesForHorse) {
                if (clusterByTableId.get(tid) === table.cluster_id) return false;
              }
            }
            return true;
          });

          // V8 ACTIVITY WINDOWS: only horses inside their daily window sit
          // down (falls back to the full pool if a human needs a game NOW and
          // the active pool ran dry).
          //
          // THE RESCUE FALLBACK WIDENS THE HOUR, NEVER THE BAND. candidateHorses
          // is already band-filtered, so a human waiting at 0.50/1 can pull an
          // off-hours low-stakes horse out of bed - which is believable - but
          // can never summon the 25/50 regular, which is not. A quiet
          // high-stakes table is ordinary; the wrong name in a micro game is
          // the tell Dan is describing.
          /* ── THE SITTABLE POOL (2026-09-05). For a CLUSTER table the pool
             is the horses the seat stage would actually seat: the same
             `sitVerdictFor` the chair is decided by, asked here for the count.
             A horse whose wallet cannot be resolved, whose buy-in sizes to
             zero, whose aggregate exposure is at its ceiling or whom the
             Stable Hand mutex refuses is neither counted as a buyer nor
             selected. The cheap gates above ran first; this runs on what
             they left. Non-cluster tables are unchanged (nobody opens a
             feeder on them). */
          let sittable = candidateHorses;
          if (table.cluster_id) {
            sittable = candidateHorses.filter((h) => {
              const v = sitVerdictFor(h.id, table, sitCtx);
              if (v.ok) return true;
              bump(unsittable, v.reason);
              noteSkip(diag, v.reason);
              return false;
            });
          }
          if (diag) {
            diag.candidates = candidateHorses.length;
            diag.sittable = sittable.length;
          }
          let pool = sittable.filter((h) => isActiveNow(h.id, hourUTC));
          /* How many were awake before any rule widened the hour, for the
             `asleep` and `hour_widened` counters below. */
          const awake = pool.length;
          if (pool.length < emptySeats.length && humanNeedsRescue) pool = sittable;
          /* ── AN OPENING FEEDER WIDENS THE HOUR TOO (2026-09-06, measured) ──
             The activity window is texture: it decides WHICH of the horses
             that could sit do sit, so the floor rotates through the stable.
             It is the wrong gate for a feeder this fleet opened. Read from the
             beat over one afternoon, the same line for thirty minutes:

               "PLO4 0.50/1 Classic Feeder": candidates 6, sittable 4,
               wanted 6, reserved 2, selected 1, seated 0,
               skipped {lone_seat_refused: 1}

             Four horses could sit; three were outside their window; the one
             inside it was refused as a lone seat; the feeder sat empty, was
             abandoned at six minutes, rested two, and was opened again on the
             same two buyers. The window widens for a human's rescue for the
             same reason it widens here: the seats are wanted NOW, by a game
             that exists because this fleet said the horses were there. Never
             the band, never the verdict - only the hour. */
          if (openingFeeder && pool.length < FEEDER_BUYERS_TO_GO_LIVE) pool = sittable;
          /* ── AND SO DOES ANY CLUSTER TABLE THAT CANNOT DEAL (2026-09-09) ────
             The feeder rule above was the right rule for the wrong set, a
             second time: `seedToDealable` already says an empty or lone
             cluster table is seeded to two THIS cycle, and the lone-seat
             refusal keeps a single horse off an empty one. Between them a
             table with two sittable horses of which one was awake was left
             at zero for as long as the hour held - every cycle the window
             chose one, the refusal declined one, and the cycle line said
             "lone_seat_refused=9" with no way to tell it from a table nobody
             could sit at. The seats are wanted NOW by a game that cannot
             deal; the hour is texture, and texture does not keep a Main 1
             dark. Never the band, never the verdict - only the hour, and only
             when the awake pool falls short of the dealable minimum. */
          if (seedToDealable && !openingFeeder && pool.length < DEALABLE_MINIMUM) {
            pool = sittable;
          }
          if (pool.length > awake) hourWidened++;
          /* The window's own count, so a table with sittable horses that are
             all asleep is never again reported as a table with none. Counted
             from the pool actually used, so a widened hour counts zero. */
          asleepDropped += sittable.length - pool.length;
          const asleepHere = sittable.length - pool.length;
          /* What the ClusterController asks: how many horses COULD sit here
             this cycle. A horse is a buyer (Law 10.5); the open rule in
             OPORD 1.4 18.3 counts them beside the humans on the waitlist. */
          let clusterPool: BuyerPool | null = null;
          if (table.cluster_id) {
            /* A cluster table's pool is kept for the allocation after the
               loop. A FULL table asks for FULL_TABLE_BUYER_PROBE (two: the
               open rule's threshold), never more, so it cannot eat the
               capacity a table with real open seats needs.

               THE FEEDER RESERVES THE BUYERS IT WAS OPENED FOR (2026-09-06).
               A table opened on the strength of two buyers has FIRST CLAIM on
               two of them until it is live or abandoned - the same courtesy
               18.3 gives a lone human, who gets a 60-second opening hold
               rather than a ghost table, and no different a deal for a horse
               (10.5). The claim is the two seats it is promoted at, less
               whoever already sat, and it is stated here rather than being a
               side effect of where this table fell in the walk. Nothing is
               stored: it is derived from `lifecycle` every cycle, so it dies
               with the feeder. See HorseBuyerAllocation. */
            const feederClaim = openingFeeder
              ? Math.max(0, FEEDER_BUYERS_TO_GO_LIVE - currentCount)
              : 0;
            /* A SEATING TABLE CLAIMS WHAT IT WILL SEAT (2026-09-06). This
               booked `max_players - currentCount` - nine less the count - of
               the floor's shared horse capacity for a table the trickle will
               give one or two horses this cycle, and the allocation walks in
               seeding order, so with a spare pool in the single digits the
               full Mains that need a feeder probe (two each) lost the draw to
               whichever sparse table sorted first. The claim is `seatsNeeded`:
               the seats this cycle is actually going to fill. */
            clusterPool = {
              tableId: table.id,
              clusterId: table.cluster_id,
              pool: pool.map((h) => h.id),
              /* A PROBE IS A FULL TABLE (2026-09-06). `countOnly` is also set
                 when the vibe target is already met, when the 1-2 trickle
                 produced zero, and when the seat budget ran out - tables with
                 real open seats. Calling those a probe made each one book two
                 horses of the floor's shared capacity to answer a question the
                 SQL cannot act on (the OPEN rule needs `v_open_unreserved = 0`,
                 so a table with a free seat blocks the open by itself), and
                 report two buyers, which keeps the game "due" on every 5-second
                 pass. The claim now follows the SEATS, not the reason the fleet
                 stopped: no open seat is a genuine probe, an open seat left
                 unfilled this cycle asks for nothing. */
              claim: openingFeeder
                ? 'reserved'
                : countOnly && emptySeats.length === 0
                  ? 'probe'
                  : 'seating',
              seatsWanted: openingFeeder
                ? feederClaim
                : countOnly
                  ? emptySeats.length === 0
                    ? FULL_TABLE_BUYER_PROBE
                    : 0
                  : Math.max(0, Math.min(seatsNeeded, Number(table.max_players) - currentCount)),
            };
            if (diag) diag.reserved = feederClaim;
            clusterPools.push(clusterPool);
          } else {
            nextEligible.set(table.id, pool.length);
          }
          if (countOnly) continue;

          /* FOUR TABLES IS THE TARGET, NOT THE CEILING (Dan 2026-09-02).
             "THEY SHOULD BE PLAYING 4 TABLES AT ONCE."

             The old weight was `random / (1 + tables)`, which pulls the
             opposite way: a horse sitting at nothing outranked one sitting at
             three, so the fleet spread itself one seat per horse across the
             floor and almost nobody reached four. Measured before this change:
             229 seats filled by 229 distinct players - an average of 1.00
             tables per seated horse, with a cap of 4 that nothing ever
             approached.

             Now a horse already playing - and not yet at four - is the FIRST
             choice, because topping a multi-tabler up to four is what the rule
             asks for and it also fills tables faster than waking somebody new.
             A horse at nothing is still picked when the multi-tablers run out,
             which is what keeps the fleet's whole roster in play instead of
             the same four hundred names. MAX_TABLES_PER_HORSE still excludes
             anyone at four; this only orders the rest. */
          const weighted = pool
            .map((h) => {
              const at = horseTables.get(h.id)?.size || 0;
              const towardFour = at > 0 && at < MAX_TABLES_PER_HORSE ? 4 : 1;
              return { h, w: Math.random() * towardFour };
            })
            .sort((a, b) => b.w - a.w);
          const selectedHorses = weighted.slice(0, emptySeats.length).map((x) => x.h);
          if (diag) diag.selected = selectedHorses.length;

          if (selectedHorses.length === 0) {
            if (emptySeats.length > 0) {
              // Name the band. A strict band means a stake level CAN run out of
              // horses, and when that happens it must be legible in the logs
              // rather than looking like the fleet is broken.
              /* ...and name what is actually missing (2026-09-09). This line
                 used to read the same for a table nobody could sit at and a
                 table with three sittable horses all outside their hour, and
                 the difference is the difference between a supply problem
                 and a window problem. `candidates` is after the cheap gates,
                 `sittable` after the verdict, `asleep` the window's share. */
              console.log(
                `[HorseFleet] No available horses for "${table.name}" (need ${emptySeats.length}, ` +
                  `band ${stakeBandForBigBlind(table.big_blind)}, candidates ${candidateHorses.length}, ` +
                  `sittable ${sittable.length}, asleep ${asleepHere})`
              );
            }
            continue;
          }

          /* THE ONE PREDICATE, asked for the chair. Wallet, buy-in (sized in
             computeHorseBuyIn, shared with claimOfferedSeats), aggregate
             ceiling and the Stable Hand mutex, in that order - the same
             verdict the sittable pool above was built from. The telemetry the
             decision carries is emitted HERE, once, where it is acted on; a
             refusal is counted, never silent.

             Asked for every selected horse BEFORE the first buy-in (the
             verdict is side-effect free and per horse, so the answers are the
             ones the old in-line loop would have given), because the lone-seat
             refusal below needs to know how many will actually sit. */
          const cleared: Array<{
            horse: (typeof selectedHorses)[number];
            seatNumber: number;
            verdict: Extract<SitVerdict, { ok: true }>;
          }> = [];
          for (let i = 0; i < selectedHorses.length; i++) {
            const horse = selectedHorses[i];
            const verdict = sitVerdictFor(horse.id, table, sitCtx);
            for (const e of verdict.telemetry) bankrollEvent(e);
            if (!verdict.ok) {
              if (isMutexRejection(verdict.reason)) {
                mutexRefused.set(verdict.reason, (mutexRefused.get(verdict.reason) ?? 0) + 1);
              } else {
                bump(seatStageSkipped, verdict.reason);
              }
              noteSkip(diag, verdict.reason);
              continue;
            }
            cleared.push({ horse, seatNumber: emptySeats[i], verdict });
          }

          /* NO LONE HORSE (2026-09-05). An EMPTY cluster table is seated to
             two or not at all: one horse alone on it cannot deal, and the
             fleet would then consider the table's target met and leave it as
             the "1" the lobby showed for 253 minutes. The horse is not
             refused anything a human is not - the OPORD holds a one-buyer
             opening for a partner too. Counted and logged once per cycle. */
          if (
            refusesLoneSeat({
              clusterTable: !!table.cluster_id,
              currentCount,
              sittable: cleared.length,
            })
          ) {
            loneSeatRefused++;
            noteSkip(diag, 'lone_seat_refused');
            continue;
          }

          /* THE DOOR, RE-READ (2026-09-05). Everything above ran on the
             snapshot; this is the last moment before a horse is committed, so
             this is where the cluster table's CURRENT lifecycle and status are
             asked for - once for the whole cycle, on the first seat it
             attempts. A table that went `breaking` or `closed` while this
             cycle was walking is skipped here, and its horses are still
             unspent: nothing below ran, so their exposure, table count and the
             seat budget are untouched and the next table in this same loop can
             take them. See HorseStaleTable. */
          if (table.cluster_id && cleared.length > 0) {
            await readDoorsOnce();
            if (!isStillSeatable(doors, table.id)) {
              staleTablesSkipped++;
              noteSkip(diag, 'stale_snapshot');
              continue;
            }
          }

          // Seat each horse at an ACTUAL empty seat
          let seated = 0;
          /* ONE SEATING, ONE PLACE. The main pass below and the lone-seat
             second draw after it seat a horse through this closure, so the
             bookkeeping a seat carries - the mutex counter, the session start,
             the host body count, the live exposure, the budget - cannot drift
             between the two callers. */
          const seatOne = async (
            horse: (typeof selectedHorses)[number],
            seatNumber: number,
            verdict: Extract<SitVerdict, { ok: true }>
          ): Promise<boolean> => {
            const { seatClub, buyIn } = verdict;
            /* THE COUNTER THE MUTEX READS is written against the SAME key the
               mutex judged (see the takenKey write below). */
            const key = verdict.sitKey;
            if (key) {
              sitKeyOf.set(`${horse.id}:${table.id}`, key);
            }
            /* A SESSION STARTS when a horse with nothing open sits down. Read
               BEFORE the seat is added to horseTables below: this used to be
               tested after it, when the set already held this table, so the
               size was never zero and the balance was never recorded. The 50%
               commit cap (HorseSitVerdict / commitAllows) then fell back to
               the balance NOW, and a horse that had won during its session was
               allowed to commit more - the exact thing the cap exists to stop. */
            const wasIdle = (horseTables.get(horse.id)?.size ?? 0) === 0;

            const success = await this.seatHorse(
              table.id,
              horse.id,
              seatNumber,
              buyIn,
              table.name,
              seatClub ?? null,
              (reason) => {
                buyInRefused.set(reason, (buyInRefused.get(reason) ?? 0) + 1);
                noteSkip(diag, `buyin_${reason}`);
                /* The horse is at the platform's game limit as the DATABASE
                   counts it (seats plus bookings). No later table in this
                   cycle can be different, so it is not offered one. */
                if (reason === 'four_game_limit' || reason === 'table_cap') {
                  cappedThisCycle.add(horse.id);
                }
              }
            );
            if (!success) return false;
            seated++;
            totalSeated++;
            seatBudget--;
            // Update our in-memory map so we don't assign them to another table if they hit 4
            if (!horseTables.has(horse.id)) horseTables.set(horse.id, new Set());
            horseTables.get(horse.id)!.add(table.id);
            /* And the host's body count, in the same breath. A cap read from
               the position the cycle STARTED with would let one pass seat the
               whole floor past it. */
            /* THE COUNTER THE MUTEX READS. Recorded against the SAME key
               the mutex judged, so "three sits on this game today" counts
               the sits it actually refused a fourth of. */
            const takenKey = sitKeyOf.get(`${horse.id}:${table.id}`);
            if (takenKey) {
              stateMutations.push({
                horseId: horse.id,
                sitOnKey: takenKey,
                /* The 50% commit cap is measured against the balance at the
                   moment the session started, so winning later does not raise
                   it. */
                ...(wasIdle && seatClub
                  ? { sessionStartBalance: bankrolls.get(`${seatClub}:${horse.id}`) ?? undefined }
                  : {}),
              });
            }
            const seatedHost = String((table as any).club_id ?? '');
            if (seatedHost) {
              if (!bodiesOnHost.has(seatedHost)) bodiesOnHost.set(seatedHost, new Set());
              bodiesOnHost.get(seatedHost)!.add(horse.id);
            }
            // The seat we just bought is exposure NOW, not next cycle: without
            // this the aggregate ceiling only ever sees the position the cycle
            // STARTED with, and a single pass could seat a horse at four
            // tables while every check reads zero.
            horseExposure.set(horse.id, (horseExposure.get(horse.id) ?? 0) + buyIn);
            return true;
          };

          const seatedIdsHere = new Set<string>();
          const freedChairs: number[] = [];
          for (const { horse, seatNumber, verdict } of cleared) {
            if (await seatOne(horse, seatNumber, verdict)) seatedIdsHere.add(horse.id);
            else freedChairs.push(seatNumber);
          }

          /* ── NO LONE HORSE, JUDGED ON THE OUTCOME (2026-09-06) ─────────────
             The refusal above judged the count of horses that CLEARED the
             verdict. A buy-in can still fail at the door (FOUR TABLE LIMIT,
             a floor, insufficient balance, TABLE_CLOSING - seatHorse reports
             seven), and two cleared with one seated is exactly the lone horse
             the rule exists to prevent. On an opening feeder it is worse than
             cosmetic: a feeder with one seat is never abandoned (the sweep
             wants zero seats), never promoted (promote wants two), never a
             break candidate (break wants live), and blocks the game from
             opening anything else - the game is frozen until the lone stand
             at ten minutes, then six more to abandon. So when an empty
             cluster table ends this pass with exactly one horse, the rest of
             the pool is asked, in order, until a second one sits or the pool
             is spent. Same verdict, same door, same bookkeeping. */
          if (table.cluster_id && currentCount === 0 && seated === 1 && seatBudget > 0) {
            const tried = new Set(cleared.map((c) => c.horse.id));
            const chairs = [...freedChairs];
            for (let s = 1; s <= table.max_players && chairs.length < 2; s++) {
              if (!occupiedNumbers.has(s) && !cleared.some((c) => c.seatNumber === s))
                chairs.push(s);
            }
            let secondDrawTried = 0;
            for (const h of pool) {
              if (seated >= 2 || seatBudget <= 0 || chairs.length === 0) break;
              if (tried.has(h.id)) continue;
              tried.add(h.id);
              secondDrawTried++;
              const v = sitVerdictFor(h.id, table, sitCtx);
              for (const e of v.telemetry) bankrollEvent(e);
              if (!v.ok) {
                noteSkip(diag, v.reason);
                continue;
              }
              const chair = chairs.shift()!;
              if (await seatOne(h, chair, v)) seatedIdsHere.add(h.id);
            }
            if (seated === 1) {
              loneSeatLeft++;
              noteSkip(diag, 'lone_seat_left');
              console.warn(
                `[HorseFleet] "${table.name}" ended the cycle with ONE horse after a second draw ` +
                  `over ${secondDrawTried} more candidate(s) - the lone stand will clear it if nobody joins`
              );
            }
          }

          if (diag) diag.seated = seated;
          if (seated > 0 && clusterPool) {
            /* The horses this table actually took go to the front of its
               pool, so the allocation after the loop hands out the same
               bodies the cycle did - including a second-draw horse that was
               not among the selected. */
            const seatedIds = seatedIdsHere;
            clusterPool.pool = [
              ...clusterPool.pool.filter((id) => seatedIds.has(id)),
              ...clusterPool.pool.filter((id) => !seatedIds.has(id)),
            ];
          }
          if (seated > 0) {
            tablesSeeded++;
            // NOTE: We do NOT update current_players here.
            // atomic_seat_horse already recalculates current_players authoritatively from table_seats.
            // Manually overwriting would cause race conditions with stale local counters.
            /* The same rule the engine's own recount writes (`count >= 2 ?
               'running' : 'waiting'`, services/supabase/tables.ts), so the
               two never disagree, and it flips ONLY a `waiting` row: a table
               an operator closed by status alone between the door re-read
               and this write must not be reopened by a seeding pass
               (2026-09-09; it used to be `.neq('status', 'running')`). */
            if (currentCount + seated >= 2) {
              await supabase
                .from('tables')
                .update({ status: 'running' })
                .eq('id', table.id)
                .eq('status', 'waiting');
            }
          }
        } catch (err: any) {
          reportError(err, 'HorseFleet.Error_seeding_table_tablename');
        } finally {
          /* EXACTLY ONE LINE PER OPENING FEEDER PER CYCLE, whatever path the
             table took. A feeder that opens and gets nobody now says why. */
          if (diag) {
            beat.openingFeeders.push(diag);
            console.log(
              `[HorseFleet] opening feeder "${diag.name}": candidates ${diag.candidates}, ` +
                `sittable ${diag.sittable}, wanted ${diag.wanted}, reserved ${diag.reserved}, ` +
                `empty seats ${diag.empty_seats}, ` +
                `selected ${diag.selected}, seated ${diag.seated}, ` +
                `skipped {${formatSkipCounts(new Map(Object.entries(diag.skipped)))}}` +
                (diag.withheld ? `, withheld ${diag.withheld}` : '')
            );
          }
        }
      }
      /* Swapped whole (see nextEligible above). A withheld cycle - the loop
         ran over nothing - leaves an empty map, which is the truth: the fleet
         will seat nobody this cycle, so no game has horse demand. */
      /* THE ALLOCATION. Cluster tables get the number of horses the floor
         can actually spare for them, walked in seeding order; a horse is
         handed out once per table it can still open and never twice within
         one game. Non-cluster tables keep their pool size (nobody opens a
         feeder on it). */
      for (const [tableId, n] of allocateBuyers(clusterPools, capacityByHorse)) {
        nextEligible.set(tableId, n);
      }
      this.lastEligibleByTable = nextEligible;
      // The only place the census is stamped: a cycle that returned early
      // above never reaches here, and its stale map ages out (see
      // lastEligibleBuiltAt) instead of being repeated to the controller.
      this.lastEligibleBuiltAt = Date.now();

      /* ── WHAT THE CONSOLE WILL SEE ─────────────────────────────────────
         Built from what this cycle already read - no extra query. `reason` is
         only set when nothing was seated, because that is the question the
         Health panel exists to answer: a quiet floor with no reason attached
         is indistinguishable from a broken engine. */
      beat.tablesSeen = tables.length;
      beat.tablesSeeded = tablesSeeded;
      beat.disabledGameTables = disabledGameTables;
      beat.seatsFilled += totalSeated;
      beat.horsesTotal = validHorses.length;
      beat.horsesSeated = seatedHorseCount;
      beat.horsesSeatedCash = seatedCashHorseCount;
      beat.reason =
        cycleWithheld ??
        (beat.seatsFilled === 0 ? (firstTableWithheld ?? 'nothing_to_seat') : null);
      beat.rows = this.buildFleetStateRows(
        validHorses,
        horseIdSet,
        allActiveSeats,
        bankrolls,
        bankrollsLoaded
      );

      if (rollUnknown > 0) {
        console.warn(
          `[HorseFleet] bankroll gate skipped for ${rollUnknown} horse/table pairs - ` +
            `no membership row for that club. Seating proceeded (fail-open).`
        );
      }
      if (clubDropped > 0) {
        console.log(
          `[HorseFleet] ${clubDropped} horse/table pairs excluded - the horse holds no ` +
            `membership that can pay for that table (a horse plays inside its own club).`
        );
      }
      if (strandedTagFallthrough > 0) {
        console.log(
          `[HorseFleet] ${strandedTagFallthrough} horse/table pair(s) judged by the merit band ` +
            `because the tag's every stake names a closed game (stranded tag fallthrough).`
        );
      }
      if (tagDropped > 0 || restDayDropped > 0 || dailyCapDropped > 0) {
        console.log(
          `[HorseFleet] tags: ${tagDropped} horse/table pair(s) excluded by the horse's own ` +
            `game, stake or lane; ${restDayDropped} on a rest day; ${dailyCapDropped} at their ` +
            `daily cap. A human short-handed at the table bypasses all three.`
        );
      }
      if (barredDropped > 0 || floorUnaffordableDropped > 0) {
        console.log(
          `[HorseFleet] door: ${barredDropped} horse/table pair(s) barred from that game for ` +
            `low VPIP; ${floorUnaffordableDropped} holding a rejoin floor their roll cannot ` +
            `cover. Neither is tried, neither is counted as a buyer.`
        );
      }
      beat.bookedOut = bookedOutDropped;
      if (bookedOutDropped > 0) {
        console.log(
          `[HorseFleet] four-game limit: ${bookedOutDropped} horse/table pair(s) excluded - ` +
            `the player is already committed to four games counting tournament bookings, ` +
            `which is what the database counts. Not tried, not counted as a buyer.`
        );
      }
      /* WHAT THE DATABASE REFUSED after the fleet had cleared the horse. The
         seven quiet refusals in seatHorse were invisible until 2026-09-06;
         they are a counter now, never a silence. */
      if (buyInRefused.size > 0) {
        console.log(`[HorseFleet] buy-in refused: ${formatRefusals(buyInRefused)}`);
      }
      beat.staleTablesSkipped = staleTablesSkipped;
      if (staleTablesSkipped > 0) {
        console.log(staleSnapshotLine(staleTablesSkipped));
      }
      if (loneSeatRefused > 0) {
        console.log(
          `[HorseFleet] lone_seat_refused=${loneSeatRefused}: empty cluster table(s) left empty ` +
            `this cycle because only one horse could sit - a cluster table is seeded to two ` +
            `or not at all (no lone horse).`
        );
      }
      if (loneSeatLeft > 0) {
        console.warn(
          `[HorseFleet] lone_seat_left=${loneSeatLeft}: empty cluster table(s) ended the cycle with ` +
            `ONE horse - the door refused the second and the second draw found nobody else.`
        );
      }
      if (mutexRefused.size > 0) {
        console.log(
          '[HorseFleet] Stable Hand mutex refused: ' +
            [...mutexRefused].map(([r, n]) => `${r}=${n}`).join(' ')
        );
      }
      /* THE SKIPS THAT USED TO BE SILENT. Every reason, every cycle it
         happened, so a seat stage that refuses every selected horse can never
         again leave the log empty. */
      if (seatStageSkipped.size > 0) {
        console.log(
          '[HorseFleet] seat stage skipped: ' +
            `no_seat_club=${seatStageSkipped.get('no_seat_club') ?? 0} ` +
            `zero_buy_in=${seatStageSkipped.get('zero_buy_in') ?? 0} ` +
            `aggregate_exposure=${seatStageSkipped.get('aggregate_exposure') ?? 0}`
        );
      }
      if (unsittable.size > 0) {
        console.log(
          '[HorseFleet] not sittable: horse/table pairs left out of a cluster count by the ' +
            `sit verdict (never reported as buyers): ${formatSkipCounts(unsittable)}`
        );
      }
      if (hostCapRefused > 0) {
        console.log(
          `[HorseFleet] ${hostCapRefused} horse/table pairs held back by the Stable Hand ` +
            `per-host cap - the host is at its occupancy curve, so no NEW body took a seat ` +
            `there. Nobody was stood up by this.`
        );
      }
      if (ownCeilingDropped > 0 || asleepDropped > 0 || hourWidened > 0) {
        console.log(
          `[HorseFleet] window: ${asleepDropped} sittable horse/table pair(s) outside their ` +
            `activity hour; ${hourWidened} cluster table(s) under the dealable minimum took ` +
            `the whole sittable pool; ${ownCeilingDropped} pair(s) at the horse's own ` +
            `cash-table ceiling.`
        );
      }
      /* EVERY COUNTER ABOVE, ONCE MORE, WHERE THE CONSOLE CAN READ IT. The
         cycle line is a console on a box nobody tails; the heartbeat is what
         the operator console shows. Until 2026-09-09 the heartbeat carried
         `reason: nothing_to_seat` and none of the numbers that explain it. */
      const bankrollNow = bankrollCounters();
      const bankrollThisCycle: Record<string, number> = {};
      for (const [k, v] of Object.entries(bankrollNow)) {
        const delta = v - (bankrollAtStart[k] ?? 0);
        if (delta > 0) bankrollThisCycle[k] = delta;
      }
      const record = (m: ReadonlyMap<string, number>): Record<string, number> =>
        Object.fromEntries([...m].filter(([, n]) => n > 0));
      beat.gates = {
        no_membership: clubDropped,
        barred: barredDropped,
        tag: tagDropped,
        stranded_tag_fallthrough: strandedTagFallthrough,
        rest_day: restDayDropped,
        daily_cap: dailyCapDropped,
        floor_unaffordable: floorUnaffordableDropped,
        host_cap: hostCapRefused,
        booked_out: bookedOutDropped,
        own_ceiling: ownCeilingDropped,
        asleep: asleepDropped,
        hour_widened: hourWidened,
        lone_seat_refused: loneSeatRefused,
        lone_seat_left: loneSeatLeft,
        stale_tables_skipped: staleTablesSkipped,
        unsittable: record(unsittable),
        seat_stage_skipped: record(seatStageSkipped),
        mutex_refused: record(mutexRefused),
        buy_in_refused: record(buyInRefused),
        bankroll: bankrollThisCycle,
      };

      /**
       * THE LADDER RAN OUT - the number that says whether the fleet has
       * anywhere left to step DOWN to.
       *
       * A horse that cannot afford the cheapest game on the board is not
       * making a decision, it is stranded, and a stranded fleet looks exactly
       * like a working one from every other angle: no errors, no refusals
       * worth reading, tables just quietly stop filling. 175 of 584 horses
       * are banded into stakes with no open table today, and every micro
       * table is closed, so this is the number that will say whether the
       * micro relaunch actually gave them a rung.
       *
       * Priced against the cheapest game the fleet could ACTUALLY join:
       * surplus tables are excluded because they are being wound down.
       */
      if (bankrollsLoaded && bankrolls.size > 0) {
        let cheapestRef = Infinity;
        for (const t of tables) {
          if (surplusTableIds.has(t.id)) continue;
          const r = referenceBuyIn(
            Number(t.big_blind),
            Number((t as any).min_buy_in) || undefined,
            Number((t as any).max_buy_in) || undefined
          );
          if (r > 0 && r < cheapestRef) cheapestRef = r;
        }
        if (Number.isFinite(cheapestRef)) {
          let stranded = 0;
          for (const [key, roll] of bankrolls) {
            const horseId = key.slice(key.indexOf(':') + 1);
            if (!canSit(roll, cheapestRef, bankrollPolicyFor(horseId))) stranded++;
          }
          // A GAUGE, not a count - see HorseBankrollTelemetry. Written every
          // cycle including zero, so the line goes quiet the moment the micro
          // relaunch gives the fleet somewhere to step down to.
          bankrollEvent('ladder_exhausted', stranded);
        }
      }

      const brLine = bankrollSummaryLine();
      if (brLine) console.log(brLine);

      if (totalSeated > 0) {
        console.log(`[HorseFleet] Seated ${totalSeated} horses across tables`);
      }

      // GATE 7 (2026-09-05): demand opens a FEEDER through the controller's
      // OPEN rule and thin tables close through its BREAK rule. The fleet no
      // longer spawns or retires a table; the Stable Hand's open order is a
      // game (openPlannedTables asks fn_cash_game_ensure), never a table.
      await this.openPlannedTables(tables, bodiesOnHost, stableHandCaps);

      /* ══ THE DAY'S COUNTERS, WRITTEN ONCE PER CYCLE ═══════════════════════
         Everything the Stable Hand mutex reads about a horse's day is written
         here: the sits it has taken on each game, the minutes it has played,
         and the two-hour window that opens when it gives a seat up. Before
         today every one of those columns held its default forever, so the
         per-key sit cap compared 0 against 3-5 and always said yes.

         THE EXITS ARE DIFFED, NOT HOOKED. A seat is given up by a stand, a
         session end, a bust, or a table closing under it, and only the paths
         somebody remembered to hook would fire a listener. The key set each
         horse held last cycle minus the set it holds now IS the exit list,
         whatever caused it. */
      /* WRAPPED, because everything below is bookkeeping and NONE of it is
         worth losing a seeding cycle over - but equally, a throw here used to
         be swallowed by the outer catch and take the counters, the heartbeat
         watch and the flush with it, leaving no trace at all. */
      try {
        const currentSeatKeys = new Map<string, Set<string>>();
        for (const seat of allActiveSeats) {
          if (!horseIdSet.has(seat.user_id)) continue;
          // Reuses the lookup built for the seat-club scope above.
          const t = tableById.get(seat.table_id);
          if (!t) continue;
          /* THE KEY IS THE GAME (2026-09-09, gameKeyForTable). Keyed on the
             table NAME this read every controller must-move between a game's
             tables - feeder to main, main to main - as a seat GIVEN UP:
             1,438 moves in 90 minutes, "5-9 seat(s) given up, 0 sit(s)" on
             every cycle line, and a two-hour window opened on a game the
             horse never left. The same function keys the mutex's sit count,
             so the two cannot drift again. */
          const key = gameKeyForTable(t);
          if (!currentSeatKeys.has(seat.user_id)) currentSeatKeys.set(seat.user_id, new Set());
          currentSeatKeys.get(seat.user_id)!.add(key);
        }
        for (const [horseId, was] of this.previousSeatKeys) {
          const nowKeys = currentSeatKeys.get(horseId);
          for (const key of was) {
            if (!nowKeys?.has(key)) stateMutations.push({ horseId, closedKey: key });
          }
        }
        this.previousSeatKeys = currentSeatKeys;

        /* MINUTES PLAYED, accrued on its own clock rather than every cycle: a
         thousand rows twice a minute to move a counter by 0.5 is not a
         measurement, it is a write storm. The elapsed time is CAPPED so an
         engine that was down for two hours does not credit every seated horse
         with two hours it did not play. */
        const nowMs = Date.now();
        if (this.lastMinutesAccrualAt === 0) {
          this.lastMinutesAccrualAt = nowMs;
        } else if (nowMs - this.lastMinutesAccrualAt >= MINUTES_ACCRUAL_MS) {
          const minutes = Math.min(30, (nowMs - this.lastMinutesAccrualAt) / 60_000);
          for (const horseId of currentSeatKeys.keys()) {
            stateMutations.push({ horseId, addMinutes: minutes });
          }
          this.lastMinutesAccrualAt = nowMs;
        }

        /* ══ IS THE CONTROLLER STILL RUNNING? ═════════════════════════════
         Read here, in the SEEDING cycle, rather than in the controller that
         writes it: a watcher inside the thing it watches reports nothing when
         the thing stops. This catches an executor throwing every cycle, or one
         left switched off - the two failures that leave the engine healthy and
         the floor unmanaged.

         It does NOT catch a dead engine, and is not meant to. Engine health and
         exact-SHA adoption are independently proven by the Club Arena release
         workflow and read-only production audit. */
        if (nowMs - this.lastBeatCheckAt >= 10 * 60_000) {
          this.lastBeatCheckAt = nowMs;
          try {
            const verdict = beatVerdict({
              lastBeatAtMs: await lastBeatAt(),
              nowMs,
              enabled: controllerEnabled(),
            });
            if (verdict === 'ok') {
              this.lastBeatComplaint = null;
            } else if (this.lastBeatComplaint !== verdict) {
              // Complain ON CHANGE. A warning re-filed every ten minutes is a
              // warning somebody mutes.
              this.lastBeatComplaint = verdict;
              const why =
                verdict === 'never_beat'
                  ? 'has never written a heartbeat - the controller looks installed but is not running'
                  : 'has not written a heartbeat in over ten minutes - it was running and stopped';
              await supabase.rpc('fn_raise_server_financial_alert', {
                p_severity: 'warning',
                p_source: 'HorseFleet.stableHandHeartbeat',
                p_message: `The Stable Hand controller ${why}. The floor is being seeded but nobody is holding it to its curve.`,
                p_context: { kind: 'stable_hand_controller_silent', verdict },
                p_entity_id: 'stable_hand',
              });
              console.warn(`[HorseFleet] Stable Hand controller ${verdict}`);
            }
          } catch (err) {
            reportError(err, 'HorseFleet.stableHandHeartbeat');
          }
        }

        if (book && stateMutations.length > 0) {
          const folded = foldMutations(book.states, stateMutations, todayKey, nowMs);
          const written = await writeStateRows(folded.rows);
          // Fold back into the cached book so the NEXT cycle reads the counter
          // this one wrote, rather than waiting for the cache to expire.
          for (const [id, st] of folded.next) book.states.set(id, st);
          if (written > 0) {
            console.log(
              `[HorseFleet] Stable Hand state: ${written} horse row(s) updated ` +
                `(${stateMutations.filter((m) => m.sitOnKey).length} sit(s), ` +
                `${stateMutations.filter((m) => m.closedKey).length} seat(s) given up, ` +
                `${stateMutations.filter((m) => m.addMinutes).length} minute accrual(s))`
            );
          }
          if (folded.skippedUntagged > 0) {
            console.warn(
              `[HorseFleet] ${folded.skippedUntagged} counter update(s) skipped - ` +
                `the tagger has never assigned those horses a rest day or a daily cap`
            );
          }
          /* A WRITE THAT WROTE NOTHING IS THE FAILURE THAT HID ALL DAY.
             writeStateRows deliberately swallows its error and returns 0, so
             that a bad counter write can never take the floor down with it -
             which is right, and which is also why nobody saw 23502 repeating
             every cycle from 08:42 to 23:07 on 2026-09-04. reportError was not
             the backstop it looked like: Sentry's own budget was dropping
             hundreds of events an hour that day. So the zero is raised HERE,
             where it is a fact about the platform rather than a log line, and
             throttled to once an hour so it stays readable. */
          if (folded.rows.length > 0 && written === 0) {
            if (nowMs - this.lastStateWriteComplaintAt >= 60 * 60_000) {
              this.lastStateWriteComplaintAt = nowMs;
              await supabase
                .rpc('fn_raise_server_financial_alert', {
                  p_severity: 'warning',
                  p_source: 'HorseFleet.stableHandState',
                  p_message:
                    `The Stable Hand counter write is failing: ${folded.rows.length} row(s) ` +
                    'were folded and none were accepted. Sit counts, the daily minute cap and ' +
                    'the two-hour re-buy window are all reading zero, so those three gates are ' +
                    'passing everything. The fleet is otherwise unaffected.',
                  p_context: { kind: 'stable_hand_state_write_failing', rows: folded.rows.length },
                  p_entity_id: 'stable_hand',
                })
                .then(
                  () => undefined,
                  (err: unknown) => reportError(err, 'HorseFleet.stateWriteAlert')
                );
            }
          }
        } else if (controllerEnabled() && stateMutations.length > 0 && !book) {
          console.warn(
            `[HorseFleet] ${stateMutations.length} Stable Hand counter update(s) DROPPED - ` +
              `the tag book was unread this cycle`
          );
        }
      } catch (err) {
        reportError(err, 'HorseFleet.stableHandBookkeeping');
      }

      /* THE LIFECYCLE PASS IS GONE (2026-09-06). OPORD 1.4 s18.2 lists it for
         deletion beside `spawnOverflowTables` and `retireSurplusTables`; those
         two went at Gate 7 and this one was left running every 30 seconds.

         It had nothing to do and one way to do harm. Read from production
         today: of 3,636 live cluster tables and 1,954 non-cluster cash tables,
         ZERO carry `auto_restart` or `auto_create_table` - Gate 5's applier
         forces both false on every cluster table each tick - so every pass was
         an RPC that returned an empty set. And its AUTO CREATE arm calls
         `fn_clone_table_row`, which copied `cluster_id`, `role`, `main_index`
         and `lifecycle`: cloning a full Main 1 produced a SECOND Main 1 of the
         same game, which is the shape that opened 3,000 tables on one game on
         2026-09-05 (docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md s6). The cloner
         is fixed in the same PR so no caller can do it; the pass is deleted
         because the controller owns lifecycle and a second owner of it is the
         defect, not the redundancy. */
    } catch (err: any) {
      reportError(err, 'HorseFleet.seedAllTables_error');
    } finally {
      /* THE CADENCE IS THE FEATURE. "Every 30 seconds" was the claim in start()
         and 47 minutes was the measurement (2026-09-02, engine log: cycle
         began 18:08:35, "Seated 80" at 18:55:53) - one waitlist query per
         table, sequentially, for 1,131 tables, on a saturated database. The
         floor decayed for the whole gap and every hand-packed table drained
         with nothing refilling it. A slow cycle is a bug in its own right, so
         it announces itself. */
      const cycleSeconds = Math.round((Date.now() - cycleStartedAt) / 1000);
      /* 18.4 on the same line every cycle: how many cluster tables were left
         alone because their game is switched off, and whether the switch was
         actually read. A read failure is the one case where a disabled game
         may have been seeded, so it is named rather than folded into zero. */
      const disabledNote =
        beat.disabledGamesReadFailed > 0
          ? '; disabled games: READ FAILED, none skipped (fail open)'
          : `; ${beat.disabledGameTables} table(s) of disabled games skipped`;
      if (this.overrunTicks > 0 || cycleSeconds > 60) {
        console.warn(
          `[HorseFleet] Seeding cycle took ${cycleSeconds}s and ${this.overrunTicks} 30s tick(s) ` +
            'were dropped while it ran - the floor was not refilled for that long' +
            disabledNote
        );
      } else {
        console.log(`[HorseFleet] Seeding cycle took ${cycleSeconds}s${disabledNote}`);
      }
      /* THE PULSE, ONCE, ON EVERY EXIT PATH (Phase 3 contract section 2).
         In `finally` deliberately: the early returns above are the cycles the
         console most needs to see, and a cycle that seated nobody because an
         operator switched the fleet off must not look like a cycle that
         seated nobody because the engine fell over. Never throws - see
         publishFleetState - so it cannot replace a real error with its own. */
      await this.publishFleetState(beat, Date.now() - cycleStartedAt);
      this.overrunTicks = 0;
      this.seeding = false;
    }
  }

  /**
   * THE FLEET'S STATE, FROM WHAT THIS CYCLE ALREADY READ.
   *
   * No new query: every field comes from rows the seeding cycle loaded for its
   * own reasons (the open-seat map, the horse pool, the bankroll map) or from
   * a pure function of the horse id. A field this cycle genuinely does not
   * know is null - see FleetStateRow for which, and why guessing one would be
   * worse than leaving it empty.
   *
   * `allActiveSeats` is EVERY open seat on the platform, tournament tables
   * included (that is why it is paged; see the note on the read), so a horse
   * with no row in it is genuinely idle rather than merely away from cash.
   *
   * A horse holding several seats gets ONE row keyed on its EARLIEST seat, the
   * same "earliest open seat wins" rule the club resolver uses, so the console
   * and the wallet resolver never disagree about which table represents it.
   */
  private buildFleetStateRows(
    validHorses: Array<{ id: string }>,
    horseIdSet: Set<string>,
    allActiveSeats: Array<{
      user_id: string;
      table_id: string;
      seat_number: number;
      stack: number | null;
      club_id: string | null;
      joined_at: string | null;
    }>,
    bankrolls: Map<string, number>,
    bankrollsLoaded: boolean
  ): FleetStateRow[] {
    const earliest = new Map<string, (typeof allActiveSeats)[number]>();
    for (const seat of allActiveSeats) {
      if (!horseIdSet.has(seat.user_id)) continue;
      const prev = earliest.get(seat.user_id);
      if (
        prev &&
        (Date.parse(prev.joined_at ?? '') || Number.MAX_SAFE_INTEGER) <=
          (Date.parse(seat.joined_at ?? '') || Number.MAX_SAFE_INTEGER)
      ) {
        continue;
      }
      earliest.set(seat.user_id, seat);
    }

    const rows: FleetStateRow[] = [];
    const enabled = new Set(validHorses.map((h) => h.id));
    for (const horseId of horseIdSet) {
      const seat = earliest.get(horseId);
      const clubId = seat?.club_id ?? null;
      const stack = seat && Number.isFinite(Number(seat.stack)) ? Number(seat.stack) : null;
      const roll =
        bankrollsLoaded && clubId ? (bankrolls.get(`${clubId}:${horseId}`) ?? null) : null;
      rows.push({
        horse_id: horseId,
        /* 'disabled' is the only horse_status that stops a horse playing, so
           a horse missing from the enabled pool is exactly that and nothing
           more is inferred. A seat outranks it: a horse disabled while seated
           is still sitting there, and the roster must say so. */
        state: seat ? 'seated' : enabled.has(horseId) ? 'idle' : 'suspended',
        club_id: clubId,
        table_id: seat?.table_id ?? null,
        seat_index: seat ? Number(seat.seat_number) : null,
        stack,
        lane: gameLaneFor(horseId),
        stake_band: stakeBandFor(horseId),
        bankroll: roll,
      });
    }
    return rows;
  }

  /**
   * ONE WRITE PER CYCLE: the state rows and the heartbeat, together.
   *
   * `fn_ca_fleet_state_upsert` replaces the rows it is given and appends one
   * heartbeat, so naming no rows replaces nothing - which is the right
   * behaviour for a cycle that ended early and knows nothing to say.
   *
   * BEST EFFORT, ALWAYS. Telemetry that can fail a seeding cycle is worse than
   * no telemetry: this runs inside `finally`, so a throw here would replace
   * whatever real error the cycle was reporting. Nothing below can throw.
   *
   * The counts it cannot honestly fill are sent as null rather than zero.
   * `horses_idle` is not `total - seated` because a horse in a tournament is
   * neither; `horses_stuck` is derived from `last_action_at`, which the
   * seeding cycle never reads; `seats_released` belongs to
   * HorseSessionRotator, which is the only thing that stands a horse up.
   */
  private async publishFleetState(beat: CycleBeat, cycleMs: number): Promise<void> {
    try {
      const { error } = await supabase.rpc('fn_ca_fleet_state_upsert', {
        p_rows: beat.rows,
        p_beat: {
          cycle_ms: cycleMs,
          horses_total: beat.horsesTotal,
          horses_seated: beat.horsesSeated,
          horses_idle: null,
          horses_stuck: null,
          tables_seen: beat.tablesSeen,
          tables_seeded: beat.tablesSeeded,
          seats_filled: beat.seatsFilled,
          seats_released: null,
          policy_version: beat.policyVersion,
          degraded: beat.degraded,
          /* `detail` is stored as the jsonb object it is handed
             (fn_ca_fleet_state_upsert: `case when jsonb_typeof(p_beat ->
             'detail') = 'object' then p_beat -> 'detail'`, read 2026-09-09),
             so the gate counters need no migration to reach the console. */
          detail: {
            reason: beat.reason,
            withheld_tables: beat.withheldTables,
            overrun_ticks: this.overrunTicks,
            disabled_game_tables: beat.disabledGameTables,
            disabled_games_read_failed: beat.disabledGamesReadFailed,
            stale_tables_skipped: beat.staleTablesSkipped,
            stale_door_read_failed: beat.staleDoorReadFailed,
            bookings_read_failed: beat.bookingsReadFailed,
            booked_out: beat.bookedOut,
            horses_seated_cash: beat.horsesSeatedCash,
            gates: beat.gates,
            opening_feeders: beat.openingFeeders,
          },
        },
      });
      if (error) throw new Error(error.message || 'fn_ca_fleet_state_upsert failed');
      /* The beat LANDED. Stamped here rather than at the top of the cycle so
         the age means "the fleet completed a cycle and recorded it", which is
         the thing the page is about. */
      this.lastBeatAtMs = Date.now();
    } catch (err) {
      const now = Date.now();
      if (now - this.lastStatePublishReportAt >= 5 * 60_000) {
        this.lastStatePublishReportAt = now;
        reportError(err, 'HorseFleet.publishFleetState');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // TABLE RETIREMENT (2026-08-19)
  // ─────────────────────────────────────────────────────────────────────

  /* retireSurplusTables is GONE (Gate 7, 2026-09-05). Every open cash table
     is a cluster table, and a cluster table is closed by the controller's
     BREAK rule (balance floor, hysteresis, must-move out) and never by a
     name-family count. */

  // ─────────────────────────────────────────────────────────────────────
  // V8 DEMAND-BASED TABLE SPAWNING
  // ─────────────────────────────────────────────────────────────────────

  /* runTableLifecyclePass is GONE (2026-09-06), and with it the AUTO RESTART /
     AUTO CREATE TABLE pass it wrapped. See the note at its old call site in
     seedAllTables: OPORD 1.4 s18.2 deletes it beside spawnOverflowTables and
     retireSurplusTables, it acted on zero rows (nothing on the platform
     carries either flag), and its AUTO CREATE arm cloned a Main 1 into a
     second Main 1. The clone path itself is fixed in the same PR
     (20260906160550) so no caller can repeat it. The fleet owns no table
     lifecycle at all now; the ClusterController does. */

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  THE PLANNER'S OPEN ORDERS - the only path that creates a Stable Hand
   *  table, and the most cautious thing in this file
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `planFloor` asks for a table when the floor is BELOW its curve and the
   * neediest stake band has nowhere to put anybody. That is a real gap and it
   * is worth closing - but creating tables is the one order that can make the
   * floor worse in the direction Dan has just spent a day pulling it back
   * from ("fewer tables, more players at each"), so every rule here is a
   * refusal:
   *
   *   - ONE table per host per cycle, whatever the order asked for;
   *   - NEVER during the night window, when the other half of this system is
   *     parking thin tables. Opening and parking on the same cycle is a
   *     controller arguing with itself;
   *   - NEVER while the host is at or above its occupancy cap. A new table
   *     cannot be filled by bodies the curve does not allow;
   *   - and ONLY when the host has NO open table of that variant at that
   *     stake. This is what makes it safe: the count cannot creep, because a
   *     second table of the same game is never opened, and there is no name to
   *     collide with because there was nothing there.
   *
   * Tables opened here carry the HOST as club_id, so the snapshot sees them
   * and the close and park machinery owns them. They are outside
   * DEFAULT_TABLES, so neither ensureAllTablesExist nor spawnOverflowTables
   * touches them.
   */
  private async openPlannedTables(
    tables: Array<{ id: string; name: string; club_id?: string | null }>,
    bodiesOnHost: ReadonlyMap<string, ReadonlySet<string>>,
    caps: ReadonlyMap<string, number>
  ): Promise<void> {
    if (!controllerEnabled()) return;
    if (isMaintenanceFrozen()) return;
    // The night is for consolidating, not for opening.
    if (isNightWindow(chicagoNow().hour)) return;

    const orders = takeOpenOrders();
    if (orders.length === 0) return;

    const openedThisCycle = new Set<string>();

    for (const order of orders) {
      try {
        if (openedThisCycle.has(order.hostId)) continue;
        const cap = caps.get(order.hostId);
        if (cap !== undefined && (bodiesOnHost.get(order.hostId)?.size ?? 0) >= cap) continue;

        /* THE ORDER NAMES ITS RUNG WHERE IT CAN (2026-09-11). `stakeForBand`
           answers the PLATFORM ladder's top rung of the band - 25/50 for
           'high' - and Midway has dealt nothing above 2/5 since an operator
           closed those games on 09-04. The planner asked for that band on
           every under-curve cycle and this loop refused it: 328 identical
           "open order refused: the game is switched off" lines in ninety
           minutes. The controller now picks from the host's own enabled
           ladder and sends the rung; `stakeForBand` remains the answer when
           the snapshot could not read a ladder, which is the old behaviour. */
        const stake = order.stake ?? stakeForBand(order.band);
        if (!stake) continue;
        const variant = String(order.variant ?? 'nlh').toLowerCase();
        /* AN OPERATOR'S CLOSE OUTRANKS A PLANNER'S OPEN (2026-09-06).
           fn_cash_game_ensure re-enables a game it finds switched off, and
           this order used to reach it unconditionally - so a Stable Hand open
           order for a band whose games an operator had closed (the six bb > 6
           games, closed 2026-09-04 16:47 CDT, which every handoff since says
           not to reopen) would have quietly switched one back on. OPORD 1.4
           18.4 makes `enabled` the one human knob; a machine does not turn it
           back. A key that exists and is disabled is left alone and said so. */
        const { data: closedGame, error: closedErr } = await supabase
          .from('cash_games')
          .select('id, name, closed_by')
          .eq('club_id', order.hostId)
          .eq('variant', variant)
          .eq('sb', stake.sb)
          .eq('bb', stake.bb)
          .eq('enabled', false)
          .limit(1)
          .maybeSingle();
        if (closedErr) {
          reportError(closedErr, 'HorseFleet.openPlannedGame_closed_read_failed');
          continue; // cannot tell whether a human closed it: do not reopen
        }
        if (closedGame) {
          console.log(
            `[HorseFleet] Stable Hand open order for ${variant} ${stake.sb}/${stake.bb} on host ` +
              `${order.hostId.slice(0, 8)} refused: game "${String((closedGame as { name?: string }).name ?? '')}" ` +
              `is switched off by an operator, and a planner does not switch it back on`
          );
          continue;
        }
        /* GATE 7 (2026-09-05): the Stable Hand plans GAMES. The order used to
           insert a plain table on the host; the database now refuses a cash
           table with no game behind it (tables_cash_needs_a_game) and the
           ClusterController opens, feeds, promotes, breaks and closes the
           tables of every game. fn_cash_game_ensure returns the key's game -
           created with Main 1 if absent - and is idempotent, so a repeated
           order costs one read. A disabled key never reaches it (above). */
        const { data, error } = await supabase.rpc('fn_cash_game_ensure', {
          p_club_id: order.hostId,
          p_variant: variant,
          p_sb: stake.sb,
          p_bb: stake.bb,
          p_template: 'classic',
          p_handedness: clampSeatsForVariant(variant, 9),
        });
        if (error) {
          reportError(error, 'HorseFleet.openPlannedGame_failed');
          continue;
        }
        openedThisCycle.add(order.hostId);
        console.log(
          `[HorseFleet] Stable Hand ensured game ${String(data ?? '').slice(0, 8)} ` +
            `(${variant} ${stake.sb}/${stake.bb}) on host ${order.hostId.slice(0, 8)} - ` +
            `the ${order.band} band had no ${variant} game and the floor is under its curve`
        );
      } catch (err) {
        reportError(err, 'HorseFleet.openPlannedTables_error');
      }
    }
  }

  /* spawnOverflowTables is GONE (Gate 7, 2026-09-05). The '#2 / #3' overflow
     clone was a table with no game behind it; the database now refuses one
     (tables_cash_needs_a_game), and demand opens a FEEDER through the
     ClusterController's OPEN rule (OPORD 1.4 s18.3) instead. */

  // ─────────────────────────────────────────────────────────────────────
  // SEAT A SINGLE HORSE
  // ─────────────────────────────────────────────────────────────────────

  /**
   * WHAT THIS HORSE BRINGS TO A SEAT — one definition, two callers.
   *
   * Extracted 2026-08-31 when horses began answering seat offers. The seeding
   * loop and claimOfferedSeats must size a buy-in identically; two copies of
   * this arithmetic is exactly the shape of bug this codebase keeps paying
   * for (see src/lib/cashBuyIn.ts, written because four layers disagreed
   * about one number).
   *
   * Returns 0 when the bankroll's share cannot reach the table minimum, which
   * the caller must read as "not this game for this horse" — never as free.
   */
  /**
   * SIT DOWN WHEN THE SEAT IS CALLED.
   *
   * A `notified` waitlist row is a seat being HELD for that player for 60
   * seconds. A human clicks; a horse has no client, so this is its hand on the
   * chair. The seeding cycle runs every 30 seconds, so a horse always gets at
   * least one look at an offer inside the hold.
   *
   * An expired hold is left alone rather than claimed late: the row belongs to
   * fn_offer_open_seat's own sweep, which expires it and passes the seat to
   * the next player in line. Taking it here would let a horse jump a queue it
   * had already timed out of.
   *
   * Best-effort, like everything else in this manager: a seat call that cannot
   * be answered must never be the reason a seeding cycle fails.
   */
  private async claimOfferedSeats(
    tables: any[],
    allActiveSeats: Array<{ user_id: string; table_id: string; seat_number: number }>,
    bankrolls: Map<string, number>,
    bankrollsLoaded: boolean,
    horseIdSet: Set<string>,
    membership: SeatClubContext,
    /** Tables being wound down: an offer at one of these is never answered. */
    surplusTableIds: Set<string>,
    /* How many seats the fleet-wide policy cap leaves this cycle. Infinity
       when there is no cap, which is today's behaviour. */
    budget: number = Number.POSITIVE_INFINITY,
    /* The door rules read this cycle (VPIP bar, rejoin floor). Empty when
       the read failed: the database still refuses at the door. */
    rejoin: RejoinConstraints = EMPTY_REJOIN_CONSTRAINTS,
    /* Games the operator has switched off (18.4), read this cycle. Empty
       when the read failed: fail open, same as the seeding loop. */
    disabledGameIds: ReadonlySet<string> = new Set<string>()
  ): Promise<number> {
    let claimed = 0;
    try {
      const tableById = new Map<string, any>(tables.map((t: any) => [t.id as string, t]));

      /* PAGED (2026-09-09), like every other read of this queue in the file.
         A bare `.select()` is capped at db-max-rows (1,000) without erroring;
         a `notified` row past the cap is a seat call a horse never answers,
         and this is the one path Dan said horses must never skip. Keyset on
         id. An incomplete read still answers the offers it did read: a seat
         call answered is better than a seat call ignored, and the hold on the
         rest expires on fn_offer_open_seat's own sweep exactly as before. */
      const offerPage = await fetchAllRows<{
        id: string;
        table_id: string;
        user_id: string;
        notified_at: string | null;
        hold_expires_at: string | null;
      }>(
        (cursor, want) => {
          let q = supabase
            .from('table_waitlist')
            .select('id, table_id, user_id, notified_at, hold_expires_at')
            .eq('status', 'notified')
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.offeredSeats', maxRows: 50_000 }
      );
      if (!offerPage.complete) {
        console.warn(
          '[HorseFleet] seat-offer read incomplete - answering the offers it did read; ' +
            'the rest keep their hold and are answered next cycle.'
        );
      }
      const offers = offerPage.rows;

      const mine = (offers ?? []).filter(
        (o: any) => horseIdSet.has(o.user_id) && tableById.has(o.table_id)
      );
      if (mine.length === 0) return 0;

      // Seats already occupied, so two offers at one table cannot both take
      // seat 1 in the same cycle.
      const taken = new Map<string, Set<number>>();
      for (const s of allActiveSeats) {
        if (!taken.has(s.table_id)) taken.set(s.table_id, new Set<number>());
        taken.get(s.table_id)!.add(Number(s.seat_number));
      }

      for (const offer of mine as any[]) {
        // The cap counts a claimed seat like any other: a fleet at its ceiling
        // takes no new seats by any route.
        if (claimed >= budget) break;
        const table = tableById.get(offer.table_id);
        if (!table || table.tournament_id) continue;
        /* A DRAINING TABLE TAKES NOBODY BACK (2026-09-03). This path seats a
           horse from a waitlist offer and never consulted surplusTableIds, so
           a horse holding a `notified` row for a retiring table would be
           seated straight back into it, undoing the drain one offer at a
           time. Nothing had gone wrong yet only because pruneHorseWaitlist
           runs earlier in the same cycle and clears every horse row - an
           ordering coincidence between two independent methods, not a rule.
           This is the rule. */
        if (surplusTableIds.has(String(offer.table_id))) continue;
        /* A TABLE OF A DISABLED GAME IS NOT ANSWERED EITHER (18.4, 2026-09-05).
           Same set, same predicate as the seeding loop: a horse holding an
           offer for a switched-off game leaves the seat to its own sweep. */
        if (isTableOfDisabledGame(table, disabledGameIds)) continue;
        /* NOR ONE THE CONTROLLER IS WALKING PLAYERS OUT OF (2026-09-06). The
           seeding loop refuses `breaking` and `closed` before it does any seat
           arithmetic (18.3: no new sit-ins on a breaking table); this path had
           no lifecycle test at all, so an offer made a minute before a break
           started would seat a horse INTO the table the controller is
           emptying, and the must-move would have to carry it straight back
           out. The prune used to hide this by clearing every horse row first;
           now that a horse can genuinely answer an offer, the rule has to be
           written down rather than depended on as an accident. */
        if (table.lifecycle === 'breaking' || table.lifecycle === 'closed') continue;

        const expiresAt = offer.hold_expires_at
          ? Date.parse(offer.hold_expires_at)
          : offer.notified_at
            ? Date.parse(offer.notified_at) + 60_000
            : NaN;
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) continue;

        const used = taken.get(table.id) ?? new Set<number>();
        const maxSeats = Number(table.max_players) || 9;
        let seatNumber = -1;
        for (let s = 1; s <= maxSeats; s++) {
          if (!used.has(s)) {
            seatNumber = s;
            break;
          }
        }
        if (seatNumber < 0) continue;

        // Same wallet rule as the seeding loop: a horse answers a seat call
        // with the club that can pay for it, or does not answer at all.
        const seatClub = this.resolveSeatClub(membership, table, offer.user_id);
        if (seatClub === null) continue;
        /* The same door rules as the seeding loop: a horse barred from this
           game does not answer its seat call, and one holding a rejoin floor
           answers with the floor. */
        const offerDoorKey = rejoinPlayerKey(offer.user_id, rejoinTableKey(table));
        if (rejoin.barred.has(offerDoorKey)) continue;
        const buyIn = this.computeHorseBuyIn(
          table,
          offer.user_id,
          bankrolls,
          bankrollsLoaded,
          seatClub,
          rejoin.rejoinFloor.get(offerDoorKey)
        );
        if (buyIn <= 0) continue;

        const ok = await this.seatHorse(
          table.id,
          offer.user_id,
          seatNumber,
          buyIn,
          table.name,
          seatClub ?? null
        );
        if (!ok) continue;

        used.add(seatNumber);
        taken.set(table.id, used);
        claimed++;

        // The seat is taken; the row must say so, or pruneHorseWaitlist reads
        // it as a horse still standing in the queue and clears it every cycle.
        const { error: updErr } = await supabase
          .from('table_waitlist')
          .update({ status: 'seated' })
          .eq('id', offer.id);
        if (updErr) {
          reportError(new Error(updErr.message), 'HorseFleet.claimOfferedSeats_mark_seated');
        }
      }
    } catch (err) {
      reportError(err, 'HorseFleet.claimOfferedSeats');
    }
    return claimed;
  }

  private computeHorseBuyIn(
    table: any,
    horseId: string,
    bankrolls: Map<string, number>,
    bankrollsLoaded: boolean,
    seatClub: string | null | undefined,
    /* The rejoin floor this horse holds in this game, if any (chip
       continuity: it may not rejoin with less than it left with). Read once
       per cycle from cash_rejoin_constraints; undefined when there is none
       or the map did not load, in which case the database's own retry in
       seatHorse still catches it. */
    rejoinFloor?: number,
    /* Where the sizing's telemetry goes. The live counter by default; the sit
       verdict hands in a collector so that judging a horse for the COUNT
       emits nothing and the seat stage emits it once. */
    note: (e: BankrollEvent) => void = bankrollEvent
  ): number {
    const minB = Number(table.min_buy_in) || table.big_blind * 40;
    const maxB = Number(table.max_buy_in) || table.big_blind * 200;
    // V9: humans buy in for ROUND numbers, never 227.40. Snap to a 5bb step,
    // then clamp to the table's real limits.
    const step = table.big_blind * 5;
    /* One roll per (horse, table, cycle): the count and the chair must size
       the same buy-in or the aggregate-exposure ceiling can pass one and
       refuse the other. See buyInBBFor. */
    const raw =
      table.big_blind * buyInBBFor(horseId, `${String(table.id)}|${this.cycleSittingSeed}`);
    let buyIn =
      Math.round(Math.max(minB, Math.min(maxB, Math.round(raw / step) * step)) * 100) / 100;

    /* NEVER BRING TOO MUCH OF THE ROLL TO ONE TABLE. The table's max buy-in is
       what the GAME allows, not what this bankroll should put at risk in a
       single seat - a 400 max is not an instruction to a horse with 3,000 to
       its name. */
    if (bankrollsLoaded) {
      /* Keyed on the club that will actually PAY (resolveSeatClub), never on
         `table.club_id`: for a union table that is the union's own club row,
         where no wallet ever lives, so the roll read as zero and every union
         horse was sized a zero buy-in and skipped (2026-09-02). */
      const roll = (seatClub ? bankrolls.get(`${seatClub}:${horseId}`) : undefined) ?? 0;
      const capped = bankrollBuyIn({
        bankroll: roll,
        desired: buyIn,
        minBuyIn: minB,
        maxBuyIn: maxB,
        policy: bankrollPolicyFor(horseId),
      });
      if (capped <= 0) {
        note('seat_refused_share_below_min');
        return 0;
      }
      if (capped < buyIn) note('buyin_capped');
      const snapped = Math.round(capped / step) * step;
      buyIn = Math.round(Math.max(minB, Math.min(capped, snapped)) * 100) / 100;
    }
    /* THE FLOOR IS THE LAST WORD, AS IT IS FOR A HUMAN (2026-09-05). The
       buy-in modal shows a returning player GREATEST(min, floor) clamped to
       the table max (fn_cash_effective_buyin), and the door refuses less. A
       horse reads the same number and brings it - the bankroll share above
       decides what is sensible, the floor decides what is possible, and
       possible wins or the horse does not sit. The candidate filter has
       already dropped a horse whose known roll cannot cover it. */
    return applyRejoinFloor(buyIn, rejoinFloor, maxB);
  }

  private async seatHorse(
    tableId: string,
    horseId: string,
    seatNumber: number,
    buyIn: number,
    tableName: string,
    clubId: string | null,
    /* A REFUSED BUY-IN SAYS WHY (2026-09-06). Seven refusal messages below are
       deliberately not reported - a seeding race is not an incident - and the
       cost of that silence was two days of "selected 4, seated 0" with nothing
       anywhere naming the door. The caller counts what comes back. */
    onRefusal?: (reason: BuyInRefusal) => void
  ): Promise<boolean> {
    // THE FREEZE IS TOTAL (Dan 2026-09-03): a cycle that began before :53 stops at
    // the first seat after it (a cycle has run for 47 minutes before).
    if (isMaintenanceFrozen()) {
      onRefusal?.('frozen');
      return false;
    }
    try {
      // ROUND 34 FIX: Direct UPDATE on public.wallets is rejected by the
      // Phase 4.1.6a wallet guard ("Direct balance mutation on public.wallets
      // is forbidden"). All balance changes must flow through whitelisted
      // SECURITY DEFINER RPCs that log to chip_ledger. The
      // atomic_table_buyin RPC handles every step atomically — balance
      // check, debit, seat insert, audit log, and tables.current_players
      // bump — and is whitelisted, so a single call replaces the manual
      // 4-step sequence below.
      // p_club_id is the wallet the engine gated and sized this seat on
      // (resolveSeatClub). fn_seat_club_for_user honours it when the horse
      // really is a member there, so the database debits the roll the engine
      // reasoned about instead of hashing its own pick. Null when the
      // membership map did not load: then the database decides alone.
      let { error: rpcErr } = await supabase.rpc('atomic_table_buyin', {
        p_user_id: horseId,
        p_table_id: tableId,
        p_seat_number: seatNumber,
        p_amount: buyIn,
        p_auto_rebuy: false,
        p_club_id: clubId,
      });

      // CHIP CONTINUITY / HORSES ARE PLAYERS (CLAUDE.md 10.5). A horse that
      // left this game in this club with chips inside the last two hours
      // meets the same rejoin floor a human does: the database says what the
      // minimum is right now, and the horse - like a human reading the
      // higher number on the buy-in slider - pays it if its roll covers it.
      // One retry, at exactly the floor; a second refusal is final.
      const floorMatch = /BUYIN_BELOW_FLOOR:.*?([0-9]+(?:\.[0-9]+)?)\s*$/.exec(
        rpcErr?.message || ''
      );
      if (rpcErr && floorMatch) {
        const required = Number(floorMatch[1]);
        if (Number.isFinite(required) && required > buyIn) {
          ({ error: rpcErr } = await supabase.rpc('atomic_table_buyin', {
            p_user_id: horseId,
            p_table_id: tableId,
            p_seat_number: seatNumber,
            p_amount: required,
            p_auto_rebuy: false,
            p_club_id: clubId,
          }));
        }
      }

      if (rpcErr) {
        // 'Insufficient balance' / 'already seated' are silent expected
        // failures during the seeding race; only report other errors.
        // 2026-08-19: TABLE_CAP_REACHED joins the list — the per-user 4-table
        // cap now lives inside atomic_table_buyin itself (the in-memory
        // MAX_TABLES_PER_HORSE filter above is advisory and raceable across
        // processes; the RPC is the authoritative guard), so a cap rejection
        // during a seeding race is expected, not an error.
        const msg = rpcErr.message || '';
        if (
          !msg.includes('Insufficient balance') &&
          !msg.includes('Player already seated') &&
          !msg.includes('duplicate key') &&
          !msg.includes('TABLE_CAP_REACHED') &&
          // The RPC's cap rejection actually reads "FOUR TABLE LIMIT: user …"
          // (constraint 23514) — the TABLE_CAP_REACHED literal above never
          // matched it, so every expected cap rejection during seeding was
          // reported as an error: 57 reports in one 10-minute window on
          // 2026-08-31. The in-memory MAX_TABLES_PER_HORSE filter only counts
          // cash seats this process knows about, while the RPC also counts
          // tournament bookings, so cap rejections here are ordinary.
          !msg.includes('FOUR TABLE LIMIT') &&
          // A rejoin floor the roll could not meet is the horse declining a
          // higher minimum, not a defect.
          !msg.includes('BUYIN_BELOW_FLOOR') &&
          !msg.includes('Insufficient club chips')
        ) {
          reportError(rpcErr, 'HorseFleet.atomic_table_buyin_failed_for_horse');
        }
        onRefusal?.(classifyBuyInRefusal(msg));
        return false;
      }

      // Log a tableName-aware description on top of the RPC's generic
      // "Cash game buy-in at table" string so audit reconciliation can
      // match human-readable table names.
      void tableName; // RPC writes its own description; this comment is the trail

      return true;
    } catch (err: any) {
      reportError(err, 'HorseFleet.seatHorse_error');
      onRefusal?.(classifyBuyInRefusal(err?.message));
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // FLEET HEALTH
  // ─────────────────────────────────────────────────────────────────────

  async getFleetHealth(): Promise<{
    total: number;
    available: number;
    seated: number;
    stuck: number;
  }> {
    try {
      const healthPage = await fetchAllRows<{ id: string; horse_status: string | null }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id, horse_status')
            .eq('is_horse', true)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.fleetHealth', maxRows: 50_000 }
      );
      const horses = healthPage.rows;
      // An incomplete read and a genuinely empty fleet must not report the same
      // numbers — this is a health probe, and a silent undercount is a lie.
      if (!healthPage.complete || horses.length === 0) {
        return { total: 0, available: 0, seated: 0, stuck: 0 };
      }

      let available = 0,
        seated = 0,
        stuck = 0;
      for (const h of horses) {
        if (h.horse_status === 'available') available++;
        else if (h.horse_status === 'seated') seated++;
        else stuck++;
      }

      return { total: horses.length, available, seated, stuck };
    } catch (err) {
      /* The zeroes above are the DELIBERATE answer to an incomplete read - a
         health probe that undercounts silently is a lie. A THROWN read used
         to return the same four zeroes with nothing said anywhere, so the
         two indistinguishable answers had one visible cause between them.
         Reported now; the zeroes still stand. */
      reportError(err, 'HorseFleet.fleetHealth_failed');
      return { total: 0, available: 0, seated: 0, stuck: 0 };
    }
  }
}
