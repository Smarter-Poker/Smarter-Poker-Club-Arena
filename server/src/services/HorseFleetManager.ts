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
  evaluateSit,
  gameKey,
  variantLabel,
  killed as stableHandKilled,
  type SitRejection,
} from './StableHand.js';
import {
  tagBook,
  tagKey,
  sitsOnKeyToday,
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
import { reportError } from './errorReporter.js';
import { clampSeatsForVariant, maxSeatsForVariant } from '../config/tableSeating.js';
import {
  bankrollBuyIn,
  bankrollPolicyFor,
  canOpenAnotherTable,
  canSit,
  referenceBuyIn,
} from './HorseBankroll.js';
import { bankrollEvent, bankrollSummaryLine } from './HorseBankrollTelemetry.js';
import {
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
} from './HorseBehavior.js';
import {
  applyBias,
  capBySeatedCount,
  FLEET_POLICY_DEFAULTS,
  getFleetPolicy,
  withheldReason,
  type FleetPolicy,
} from './HorseFleetPolicy.js';

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
  rows: FleetStateRow[];
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
  /** V23 (Dan 2026-08-28, "fully build all of these"): this table runs a UTG
   *  straddle. The V18 straddle brain layer shipped 2026-08-26 and has fired
   *  ZERO times in production because the fleet spawned no straddle tables —
   *  this is the product half of that feature. NLH only. */
  straddleEnabled?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASH GAME TABLE CONFIGS — Every Stake Level × Every Game Type
// ═══════════════════════════════════════════════════════════════════════════════

// FIX 201: Tables spawn from the UNION, not individual clubs.
// All cash tables belong to the Midway Union — visible across all member clubs.
const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';

// Legacy club IDs kept only for rake routing fallback (seatHorse clubId param)
const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const JAQK_CLUB_ID = 'a0000000-0000-0000-0000-000000000001';

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
    // V23: the fleet's first STRADDLE game — gives the V18 straddle brain
    // layer live traffic and the lobby an action table.
    name: 'NLH Straddle 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 9,
    horsesPerTable: 6,
    gameVariant: 'nlh',
    straddleEnabled: true,
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

/**
 * How many live tables a single config may have: the original plus two
 * demand-spawned overflows.
 *
 * This used to be a local inside spawnOverflowTables, so it was a ceiling on
 * CREATING tables and nothing else — nothing ever counted the other way.
 * Production reached 121 rows named 'NLH 1.00/2.00'. It is now also the number
 * retireSurplusTables() drains back down to, and the two must be the same
 * number or the fleet spawns and retires in a loop.
 */
const MAX_TABLES_PER_CONFIG = 3;

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
  private seeding = false; // Prevents concurrent seeding
  private overrunTicks = 0; // 30s ticks dropped because the previous cycle was still running
  private clubIndex = 0;
  /* Last time a failed fleet-state publish was reported. The engine can ship
     before the World Hub migration that creates fn_ca_fleet_state_upsert, and
     an unthrottled report would file one Sentry event and one console line
     every 30 seconds for ever, which is how a real signal becomes noise. */
  private lastStatePublishReportAt = 0;
  private clubIds = [SHARK_CLUB_ID, JAQK_CLUB_ID];

  private getNextClubId(): string {
    const id = this.clubIds[this.clubIndex % this.clubIds.length];
    this.clubIndex++;
    return id;
  }

  // ─────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[HorseFleet] Already running');
      return;
    }

    this.isRunning = true;
    console.log('[HorseFleet] Starting fleet manager...');

    // Ensure all tables exist (fast — just inserts)
    await this.ensureAllTablesExist();

    // Kick off initial seeding in background — DON'T block the server
    this.seedAllTables()
      .then(() => {
        console.log('[HorseFleet] Initial seeding complete');
      })
      .catch((err) => {
        reportError(err, 'HorseFleet.Initial_seeding_error');
      });

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
      this.seedAllTables().catch((err) => reportError(err, 'HorseFleet.Seed_cycle_error'));
    }, 30000);

    console.log('[HorseFleet] Running - seeding in background, checking every 30s');
  }

  stop(): void {
    this.isRunning = false;
    if (this.seedInterval) {
      clearInterval(this.seedInterval);
      this.seedInterval = null;
    }
    console.log('[HorseFleet] Stopped');
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
      const { data, error } = await supabase
        .from('table_waitlist')
        .select('table_id, user_id, status')
        .in('status', ['waiting', 'notified']);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        const r = row as { table_id?: string; user_id?: string };
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
      const { data, error } = await supabase
        .from('table_waitlist')
        .select('id, user_id, status')
        .in('status', ['waiting', 'notified']);
      if (error) throw new Error(error.message);
      const excess = (data ?? [])
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

    for (const config of DEFAULT_TABLES) {
      try {
        // FIX 201: Check for table by name in ANY status (not just waiting/running).
        // If a closed table exists, reactivate it instead of creating a duplicate.
        //
        // 2026-08-19: this used .maybeSingle() and threw the error away —
        // `const { data: existing } = ...`. PostgREST answers .maybeSingle()
        // with PGRST116 when MORE THAN ONE row matches, so the moment a second
        // row with the same name existed, `existing` came back null and the
        // code below created a THIRD. Every boot after that added another, and
        // every one it added made the next boot certain to add one more.
        //
        // It ran for months. 120 copies of 'NLH 1.00/2.00', 120 of
        // 'NLH 2.00/5.00', 83 PLO4, 83 PLO5, 81 PLO6 — 487 duplicate cash
        // tables in the lobby. The three configs that never got a second row
        // (PLO8, Short Deck, Pineapple) still had exactly one each, which is
        // what a self-amplifying bug looks like from the outside.
        //
        // .limit(1) cannot error on multiplicity, and the error is now checked:
        // on ANY read failure this SKIPS the config rather than inserting.
        // Inserting when you could not find out whether the row exists is the
        // whole bug, not the .maybeSingle() call.
        /**
         * A SOFT-DELETED ROW CAN NEVER BE THE FLEET'S TABLE (2026-08-30).
         *
         * This picked the OLDEST row carrying the config's name. For 8 of the 9
         * cash configs that row was `is_deleted = true`, and a deleted row
         * cannot be revived: `fn_block_deleted_table_revival` is a BEFORE
         * UPDATE trigger that silently puts the status back --
         *
         *   IF COALESCE(OLD.is_deleted,false) AND NEW.status IN
         *      ('running','waiting','active','open') THEN
         *     NEW.status := OLD.status; NEW.is_deleted := true;
         *
         * -- and RAISES NOTHING. So the UPDATE below "succeeded", this logged
         * `[HorseFleet] Reactivated table: X (was closed)`, and `continue`
         * skipped the insert because a row HAD been found. Every cycle, for
         * ever. The table never came back and the log said that it had.
         *
         * Measured 2026-08-30: 8 of 9 cash configs had ZERO open rows, their
         * unrevivable stand-in re-touched at 20:28 on each boot. The only
         * config still on the felt, `NLH Straddle 1.00/2.00`, was the only one
         * whose oldest row was not deleted - a clean natural control.
         *
         * ONE change: exclude soft-deleted rows. They are unrevivable by
         * construction, so treating one as "the table exists" is always wrong
         * and silently starves the lobby. The oldest-first ordering is kept
         * deliberately - it is what makes the choice stable across cycles, and
         * `HorseFleetNoDuplicateTables` pins the single-row contract.
         *
         * Deliberately NOT ordering by status to "prefer an open row": status
         * is text, so ascending sorts 'closed' < 'running' < 'waiting' and
         * would prefer a CLOSED row - the exact opposite - while descending
         * would only work by alphabetical accident. With the deleted rows
         * excluded there is at most one usable row per name anyway.
         *
         * If nothing usable remains, `existing` is null and the insert below
         * creates a fresh table - the correct outcome, and the one this bug
         * was suppressing.
         */
        const { data: matches, error: lookupError } = await supabase
          .from('tables')
          .select(
            'id, status, union_id, game_variant, small_blind, big_blind, straddle_enabled, min_buy_in, max_buy_in, settings'
          )
          .eq('name', config.name)
          /* THE FLEET'S TABLES ARE THE UNION'S TABLES (2026-09-03).
             This matched on NAME ALONE, platform-wide, and then reopened
             whatever it found and stamped MIDWAY_UNION_ID onto it - leaving
             club_id pointing at the original owner, so rake would route to one
             club and discovery to another. It also undoes a closure: a club
             that retires a stake is fought by this every boot.

             Nothing had gone wrong only because no user club happens to name a
             table the way DEFAULT_TABLES does (checked across production the
             day this was written: every one of the thirteen config names
             resolves to a Midway row, and Deep Stack Society uses a different
             convention entirely). That is a coincidence of naming, not a rule.
             One club creating "NLH 1.00/2.00" would have had its table annexed.

             The fleet only ever creates union tables (see the insert below), so
             it may only ever adopt one. */
          .eq('union_id', MIDWAY_UNION_ID)
          .is('tournament_id', null)
          .not('is_deleted', 'is', true)
          .order('created_at', { ascending: true })
          .limit(1);

        if (lookupError) {
          reportError(lookupError, 'HorseFleet.table_lookup_failed');
          continue;
        }

        const existing = matches?.[0] ?? null;

        if (existing) {
          // Table exists — ensure it's active and at Union level
          const updates: Record<string, any> = {};
          /* A RETIRED TABLE STAYS RETIRED. Reopening a closed table is right
             for a table the fleet closed as surplus and now wants back; it is
             wrong for one a club deliberately retired (2026-09-03, "close any
             tables over 2/5"), which would otherwise be reopened on the next
             boot and re-seeded. */
          /* A RETIRED TABLE STAYS RETIRED; A PARKED ONE COMES BACK IN THE
             MORNING. The night park drains and closes a thin table exactly as
             a retirement does, but it is meant to be lifted - so boot reopens
             it, unless we are still inside the night window, in which case
             reopening would simply undo the parking every hour when the
             engine restarts. This is the second, independent way a parked
             table gets its life back: the executor lifts the flag every cycle
             after 08:00, and this catches the case where the executor is
             switched off entirely. */
          const parkedForNight = isNightParkedTable(existing as { settings?: unknown });
          const stillNight = isNightWindow(chicagoNow().hour);
          if (
            existing.status === 'closed' &&
            !isRetiringTable(existing as { settings?: unknown }) &&
            !(parkedForNight && stillNight)
          )
            updates.status = 'waiting';
          if (existing.union_id !== MIDWAY_UNION_ID) updates.union_id = MIDWAY_UNION_ID;
          // V3: legacy rows can drift from the config (e.g. an old
          // 'ofc_pineapple' row under the crazy-pineapple table name). The
          // config is authoritative — resync variant and blinds on reuse.
          if (existing.game_variant !== config.gameVariant)
            updates.game_variant = config.gameVariant;
          if (Number(existing.small_blind) !== config.smallBlind)
            updates.small_blind = config.smallBlind;
          if (Number(existing.big_blind) !== config.bigBlind) updates.big_blind = config.bigBlind;
          // Dan 2026-08-28: buy-ins resync WITH the blinds. This branch used
          // to carry stale chip buy-ins forever after a blind bump — bump a
          // config from 1/2 to 25/50 and the reactivated row kept a 40BB
          // band computed against the OLD big blind (the exact shape of the
          // "25/50 with buy-in 100-200" bug). 40BB-200BB, always.
          //
          // ROUNDED TO CENTS on purpose. bigBlind * 40 on a fractional stake
          // can land off an exact cent in IEEE754; if a numeric(…,2) column
          // then rounds it on write, read-back never equals the recomputed
          // value, this comparison stays true forever, and the update path
          // below resets current_players every cycle — the exact standing
          // hazard the V23 note documents. Chips are cents; compare cents.
          const wantMinBuyIn = Math.round(config.bigBlind * 40 * 100) / 100;
          const wantMaxBuyIn = Math.round(config.bigBlind * 200 * 100) / 100;
          if (Number((existing as { min_buy_in?: number }).min_buy_in) !== wantMinBuyIn)
            updates.min_buy_in = wantMinBuyIn;
          if (Number((existing as { max_buy_in?: number }).max_buy_in) !== wantMaxBuyIn)
            updates.max_buy_in = wantMaxBuyIn;
          // V23: a straddle config re-straddles a reused row. Compared, not
          // written blind — an unconditional write would make `updates`
          // non-empty every cycle, and the update path resets
          // current_players to 0, which would strand a live table.
          if (
            (existing as { straddle_enabled?: boolean }).straddle_enabled !==
            (config.straddleEnabled === true)
          ) {
            updates.straddle_enabled = config.straddleEnabled === true;
            // Keep the POST in step with the permission - see the note on
            // auto_utg_straddle in the insert above.
            updates.auto_utg_straddle = config.straddleEnabled === true;
          }
          if (Object.keys(updates).length > 0) {
            updates.current_players = 0;
            await supabase.from('tables').update(updates).eq('id', existing.id);
            console.log(`[HorseFleet] Reactivated table: ${config.name} (was ${existing.status})`);
          }
          continue;
        }

        // FIX 201: Tables belong to a club BUT are inside the Union.
        // Set both club_id (for rake routing) AND union_id (for Union-level discovery).
        const clubId = this.getNextClubId();
        const { error } = await supabase.from('tables').insert({
          club_id: clubId,
          union_id: MIDWAY_UNION_ID,
          name: config.name,
          game_type: 'cash',
          game_variant: config.gameVariant,
          stakes: `${config.smallBlind}/${config.bigBlind}`,
          small_blind: config.smallBlind,
          big_blind: config.bigBlind,
          min_buy_in: config.bigBlind * 40,
          max_buy_in: config.bigBlind * 200,
          // The law is enforced HERE, not only in the config above, so a
          // future config edit cannot put an illegal table in the database.
          max_players: clampSeatsForVariant(config.gameVariant, config.maxPlayers),
          current_players: 0,
          status: 'waiting',
          // ALL-CASH INSURANCE 2026-08-26 (Dan: "publish this for all cash
          // games") - fleet cash tables are born with insurance on; the
          // 20260827 migration flipped the existing fleet.
          insurance_enabled: true,
          // V23: straddle tables are born straddling (see TableConfig).
          straddle_enabled: config.straddleEnabled === true,
          // ═══ 2026-08-28: ENABLED IS NOT THE SAME AS HAPPENING ═══════════
          // MEASURED: the V23 straddle table went live, seated 8 horses and
          // dealt 107 hands in two hours - and v18_straddle telemetry stayed
          // at ZERO. straddle_enabled only means players MAY straddle; the
          // post itself comes from StraddleEngine, which needs either a
          // player who toggled auto-straddle or mandatoryUtg. Horses never
          // toggle anything, so nobody ever straddled and the V18 brain
          // layer had nothing to read. auto_utg_straddle makes the UTG
          // straddle mandatory, which is what a "straddle table" means.
          auto_utg_straddle: config.straddleEnabled === true,
        });

        if (error) {
          reportError(error, 'HorseFleet.Failed_to_create_table_confign');
        } else {
          console.log(
            `[HorseFleet] Created table: ${config.name} (club: ${clubId}, union: ${MIDWAY_UNION_ID})`
          );
        }
      } catch (err: any) {
        reportError(err, 'HorseFleet.Error_creating_table_confignam');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SEED ALL TABLES — Fill empty seats with available horses
  // ─────────────────────────────────────────────────────────────────────

  private async seedAllTables(): Promise<void> {
    // THE FREEZE IS TOTAL (Dan 2026-09-03): seeding is a seat INSERT and a buy-in.
    // start() runs this once immediately; a boot inside the break must not.
    if (isMaintenanceFrozen()) return;
    if (this.seeding) return; // Prevent concurrent seeding
    this.seeding = true;
    const cycleStartedAt = Date.now();
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
      rows: [],
    };
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
      }>(
        (cursor, want) => {
          let q = supabase
            .from('tables')
            .select(
              'id, name, max_players, small_blind, big_blind, game_variant, club_id, union_id, min_buy_in, max_buy_in, current_players, created_at, settings'
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
      const tables = tablePage.rows;

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
       */
      const horseExposure = new Map<string, number>();
      for (const seat of allActiveSeats) {
        if (!horseTables.has(seat.user_id)) horseTables.set(seat.user_id, new Set());
        horseTables.get(seat.user_id)!.add(seat.table_id);
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

      // Tables past MAX_TABLES_PER_CONFIG for their config. They are not
      // seeded — they are being drained — and retireSurplusTables() closes
      // each one as it empties. Ordered oldest-first so the table that gets
      // KEPT is the same one ensureAllTablesExist() treats as canonical.
      const surplusTableIds = new Set<string>();
      for (const config of DEFAULT_TABLES) {
        const family = tables
          .filter((t) => t.name === config.name || t.name.startsWith(`${config.name} #`))
          .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
        for (const t of family.slice(MAX_TABLES_PER_CONFIG)) surplusTableIds.add(t.id);
      }
      /* A table marked `settings.retire_when_empty` is surplus by declaration
         (Dan 2026-09-03, "close any tables over 2/5"): it gets no new horses,
         HorseSessionRotator walks its horses out, and retireSurplusTables()
         closes it once it is empty. This is how a RUNNING table above a
         club's stake cap is closed without cashing seats out under a hand.
         See isRetiringTable. */
      let retiring = 0;
      let parked = 0;
      for (const t of tables) {
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
      // (horse_status is never flipped for cash play). Tournament seats are
      // not in allActiveSeats, so this UNDERCOUNTS "playing" and the floor is
      // conservative — it can only over-deliver. When the seated fraction
      // drops under a third, every non-empty table wants one more seat this
      // cycle, which lifts the floor without thrashing any single game.
      const seatedHorseCount = new Set(
        allActiveSeats.filter((s) => horseIdSet.has(s.user_id)).map((s) => s.user_id)
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

      // V8: tables with a short-handed HUMAN seed first (never leave a human
      // stranded); everything else keeps its natural order.
      const humanShort = (t: any): boolean => {
        const seats = allActiveSeats.filter((x) => x.table_id === t.id);
        return seats.some((x) => !horseIdSet.has(x.user_id)) && seats.length < 4;
      };
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
      const orderedTables = [...tables].sort(
        (a, b) =>
          Number(humanShort(b)) - Number(humanShort(a)) || String(a.id).localeCompare(String(b.id))
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
      for (const seat of allActiveSeats) {
        const t = tableById.get(seat.table_id);
        if (!t || !seat.club_id) continue;
        const scope = tableScope(t);
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
            seatBudget
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
      let firstTableWithheld: string | null = null;
      for (const table of tablesToSeed) {
        try {
          // A draining table gets no new horses. Without this the surplus can
          // never empty, and so can never be retired.
          if (surplusTableIds.has(table.id)) continue;

          // Determine currently occupied seats for THIS table from our in-memory map
          const tableOccupiedSeats = allActiveSeats.filter((s) => s.table_id === table.id);
          const occupiedNumbers = new Set(tableOccupiedSeats.map((s) => s.seat_number));
          const currentCount = occupiedNumbers.size;

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
            continue;
          }
          if (seatBudget <= 0) {
            beat.withheldTables++;
            if (firstTableWithheld === null) firstTableWithheld = 'max_horses_reached';
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
          const seatsAllowed = capBySeatedCount(seatTarget, currentCount, policy.maxPerTable);
          if (seatsAllowed <= 0) continue;
          let seatsNeeded = seatsAllowed;

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
          /* The fleet-wide cap, spent down as the floor fills. Last, so it
             cannot be undone by anything above it. */
          seatsNeeded = Math.min(seatsNeeded, seatBudget);
          if (seatsNeeded <= 0) continue;

          // Find empty seat numbers
          const emptySeats: number[] = [];
          for (let s = 1; s <= table.max_players && emptySeats.length < seatsNeeded; s++) {
            if (!occupiedNumbers.has(s)) emptySeats.push(s);
          }
          if (emptySeats.length === 0) continue;

          // Find candidate horses:
          // 1. Not already at this table
          // 2. Not exceeding 4 max tables
          const MAX_TABLES_PER_HORSE = 4;
          const candidateHorses = validHorses.filter((h) => {
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
            const stakeOk = tagAllowsStake(tag, Number(table.big_blind));
            if (stakeOk === false && !humanNeedsRescue) {
              tagDropped++;
              return false;
            }
            if (stakeOk === undefined && !stakeBandAllows(h.id, table.big_blind)) return false;

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
            if (!tablesForHorse) return true;
            /* THE HORSE'S OWN CEILING, never above the platform's four. A
               grinder carries four, a mixer one; before the tag was read every
               horse carried four. */
            if (tablesForHorse.size >= tagMaxTables(tag, MAX_TABLES_PER_HORSE)) return false;
            if (tablesForHorse.has(table.id)) return false;
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
          let pool = candidateHorses.filter((h) => isActiveNow(h.id, hourUTC));
          if (pool.length < emptySeats.length && humanNeedsRescue) pool = candidateHorses;

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

          if (selectedHorses.length === 0) {
            if (emptySeats.length > 0) {
              // Name the band. A strict band means a stake level CAN run out of
              // horses, and when that happens it must be legible in the logs
              // rather than looking like the fleet is broken.
              console.log(
                `[HorseFleet] No available horses for "${table.name}" (need ${emptySeats.length}, band ${stakeBandForBigBlind(table.big_blind)})`
              );
            }
            continue;
          }

          // Seat each horse at an ACTUAL empty seat
          let seated = 0;
          for (let i = 0; i < selectedHorses.length; i++) {
            const horse = selectedHorses[i];
            const seatNumber = emptySeats[i];
            // V8 BUY-IN VARIANCE, in ONE place. Shared with claimOfferedSeats,
            // so a horse answering a seat call brings exactly what it would
            // have brought to a seat it was seeded into. See computeHorseBuyIn.
            /* The wallet this seat draws from - the same club the candidate
               filter gated on, the same club the buy-in is sized against, and
               the club handed to atomic_table_buyin as p_club_id so the
               database honours it rather than hashing its own choice. */
            const seatClub = this.resolveSeatClub(membership, table, horse.id);
            if (seatClub === null) continue;
            const buyIn = this.computeHorseBuyIn(
              table,
              horse.id,
              bankrolls,
              bankrollsLoaded,
              seatClub
            );
            if (buyIn <= 0) continue;

            /**
             * THE AGGREGATE CEILING, and the reason it is a separate check.
             * Everything above reasons about ONE table. `canOpenAnotherTable`
             * is the only rule that can see the horse's whole position, and
             * without it the per-table share silently multiplies by the table
             * count. Three single-table shares is the ceiling: enough to
             * multi-table normally, short of the point where one bad run
             * across four seats is the bankroll.
             *
             * Fails open with the rest of the layer: an unreadable roll gets
             * no aggregate opinion either, because a gate that refuses on a
             * value it could not read is the bug that emptied the cash floor.
             */
            if (bankrollsLoaded) {
              const roll = seatClub ? bankrolls.get(`${seatClub}:${horse.id}`) : undefined;
              if (
                roll !== undefined &&
                !canOpenAnotherTable({
                  bankroll: roll,
                  liveExposure: horseExposure.get(horse.id) ?? 0,
                  nextBuyIn: buyIn,
                  policy: bankrollPolicyFor(horse.id),
                })
              ) {
                bankrollEvent('seat_refused_aggregate_exposure');
                continue;
              }
            }

            /* ══ THE MUTEX (Operation Stable Hand section 11) ══════════════
               `evaluateSit` is the single gate every Stable Hand seat is
               supposed to pass, and until today NOTHING CALLED IT. It was
               written, covered by 75 tests, and unreachable - so the 20
               buy-in licence, the 50% session-commit cap, the per-key daily
               sit cap and one-body-one-club were all unenforced on the live
               floor. `atomic_table_buyin` checks that the wallet can COVER
               the buy-in and knows none of the rest (recon section 6.4).

               ONLY WHEN THE HORSE IS FULLY KNOWN. It needs a persona and the
               day's counters to answer, and `maySitOnKey(null, n)` is FALSE by
               design - a tourney-only horse takes no cash sits. Calling it on
               an untagged horse would therefore refuse every one of them,
               which is fail-CLOSED and the exact shape of the bug that emptied
               the cash floor on 2026-08-31. No tag or no state: this block
               does not run and the gates above are the whole rule. */
            const sitTag = seatClub ? book?.tags.get(tagKey(horse.id, seatClub)) : undefined;
            const sitState = book?.states.get(horse.id);
            /* `seatClub` is named in the condition rather than assumed: it is
               undefined when the membership map did not load, and that branch
               is the one the whole file fails open on. */
            if (seatClub && sitTag && sitState && sitTag.personaCash) {
              const key = gameKey({
                hostId: String((table as any).club_id ?? ''),
                template: String(table.name ?? ''),
                variant: String(table.game_variant ?? ''),
                sb: Number(table.small_blind) || 0,
                bb: Number(table.big_blind) || 0,
              });
              const balance = bankrolls.get(`${seatClub}:${horse.id}`) ?? 0;
              const verdict = evaluateSit({
                activeClubId: activeClubOf.get(horse.id) ?? null,
                activeHostId: activeHostOf.get(horse.id) ?? null,
                activeSeatCount: horseTables.get(horse.id)?.size ?? 0,
                maxTables: tagMaxTables(sitTag, MAX_TABLES_PER_HORSE),
                clubId: seatClub,
                tableHostId: String((table as any).club_id ?? ''),
                bb: Number(table.big_blind) || 0,
                available: balance,
                /* The session-start balance is what the 50% cap is measured
                   against, so that winning mid-session does not raise it and
                   losing does not retroactively void a table that already
                   passed. An unknown one falls back to the balance now, which
                   is the same number on the first sit of a session. */
                sessionStartBalance: sitState.sessionStartBalance ?? balance,
                currentCommit: horseExposure.get(horse.id) ?? 0,
                buyIn,
                persona: sitTag.personaCash,
                sitsOnKeyToday: sitsOnKeyToday(sitState, key, todayKey),
                isRestDay: isRestDayFor(sitState, chicagoWeekday),
                killed: stableHandKilled(),
              });
              if (verdict !== 'ok') {
                mutexRefused.set(verdict, (mutexRefused.get(verdict) ?? 0) + 1);
                continue;
              }
              sitKeyOf.set(`${horse.id}:${table.id}`, key);
            }

            const success = await this.seatHorse(
              table.id,
              horse.id,
              seatNumber,
              buyIn,
              table.name,
              seatClub ?? null
            );
            if (success) {
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
                  /* A SESSION STARTS when a horse with nothing open sits down.
                     The 50% commit cap is measured against the balance at that
                     moment, so winning later does not raise it. */
                  ...((horseTables.get(horse.id)?.size ?? 0) === 0 && seatClub
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
            }
          }

          if (seated > 0) {
            tablesSeeded++;
            // NOTE: We do NOT update current_players here.
            // atomic_seat_horse already recalculates current_players authoritatively from table_seats.
            // Manually overwriting would cause race conditions with stale local counters.
            if (currentCount + seated >= 2) {
              await supabase
                .from('tables')
                .update({ status: 'running' })
                .eq('id', table.id)
                .neq('status', 'running');
            }
          }
        } catch (err: any) {
          reportError(err, 'HorseFleet.Error_seeding_table_tablename');
        }
      }

      /* ── WHAT THE CONSOLE WILL SEE ─────────────────────────────────────
         Built from what this cycle already read - no extra query. `reason` is
         only set when nothing was seated, because that is the question the
         Health panel exists to answer: a quiet floor with no reason attached
         is indistinguishable from a broken engine. */
      beat.tablesSeen = tables.length;
      beat.tablesSeeded = tablesSeeded;
      beat.seatsFilled += totalSeated;
      beat.horsesTotal = validHorses.length;
      beat.horsesSeated = seatedHorseCount;
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
      if (tagDropped > 0 || restDayDropped > 0 || dailyCapDropped > 0) {
        console.log(
          `[HorseFleet] tags: ${tagDropped} horse/table pair(s) excluded by the horse's own ` +
            `game, stake or lane; ${restDayDropped} on a rest day; ${dailyCapDropped} at their ` +
            `daily cap. A human short-handed at the table bypasses all three.`
        );
      }
      if (mutexRefused.size > 0) {
        console.log(
          '[HorseFleet] Stable Hand mutex refused: ' +
            [...mutexRefused].map(([r, n]) => `${r}=${n}`).join(' ')
        );
      }
      if (hostCapRefused > 0) {
        console.log(
          `[HorseFleet] ${hostCapRefused} horse/table pairs held back by the Stable Hand ` +
            `per-host cap - the host is at its occupancy curve, so no NEW body took a seat ` +
            `there. Nobody was stood up by this.`
        );
      }

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

      // V8 DEMAND RESPONSE: when every table of a config is effectively full,
      // spawn an overflow table so arriving humans always find a seat.
      await this.spawnOverflowTables(tables, allActiveSeats || []);
      await this.openPlannedTables(tables, bodiesOnHost, stableHandCaps);

      // ...and the other direction, which never existed until 2026-08-19.
      // Note it now skips any table carrying `auto_extension` — see there.
      await this.retireSurplusTables(tables, surplusTableIds, allActiveSeats || []);

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
          const t = tableById.get(seat.table_id) as any;
          if (!t) continue;
          const key = gameKey({
            hostId: String(t.club_id ?? ''),
            template: String(t.name ?? ''),
            variant: String(t.game_variant ?? ''),
            sb: Number(t.small_blind) || 0,
            bb: Number(t.big_blind) || 0,
          });
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

         It does NOT catch a dead engine, and is not meant to: engine-watchdog
         and the deploy watchdogs own that from outside the box. Said plainly,
         because a watchdog whose limits are not written down gets trusted for
         things it never covered. */
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
        } else if (controllerEnabled() && stateMutations.length > 0 && !book) {
          console.warn(
            `[HorseFleet] ${stateMutations.length} Stable Hand counter update(s) DROPPED - ` +
              `the tag book was unread this cycle`
          );
        }
      } catch (err) {
        reportError(err, 'HorseFleet.stableHandBookkeeping');
      }

      // The same two directions for a HOST's own table, from the switches on
      // the table creation page: Auto Restart reopens a closed one, Auto
      // Create Table opens a sibling when it fills. The fleet's own spawn and
      // retire above only know DEFAULT_TABLES; this knows every table that
      // carries the flag, which is what makes a host's switch mean anything.
      await this.runTableLifecyclePass();
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
      if (this.overrunTicks > 0 || cycleSeconds > 60) {
        console.warn(
          `[HorseFleet] Seeding cycle took ${cycleSeconds}s and ${this.overrunTicks} 30s tick(s) ` +
            'were dropped while it ran - the floor was not refilled for that long.'
        );
      } else {
        console.log(`[HorseFleet] Seeding cycle took ${cycleSeconds}s`);
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
          detail: {
            reason: beat.reason,
            withheld_tables: beat.withheldTables,
            overrun_ticks: this.overrunTicks,
          },
        },
      });
      if (error) throw new Error(error.message || 'fn_ca_fleet_state_upsert failed');
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

  /**
   * Close surplus tables once they are empty.
   *
   * The fleet could only ever ADD tables. spawnOverflowTables() capped
   * creation at MAX_TABLES_PER_CONFIG and a comment promised that "the
   * stale-table lifecycle owns closing" — a component that was never written.
   * Nothing anywhere closed an idle cash table, so when ensureAllTablesExist()
   * started duplicating rows on every boot, the count only went one way: 121
   * rows named 'NLH 1.00/2.00', 495 fleet tables in total.
   *
   * Empty means EMPTY: no live seat rows, no counted players, and not mid-hand.
   * A table with anyone at it is left alone and retired on a later cycle, so a
   * horse — or a human who wandered in — is never closed out from under.
   *
   * status = 'closed' rather than DELETE: the DB trigger
   * trg_auto_cashout_on_table_close cashes out any remaining human seat, and a
   * delete would bypass it and strand chips. It also keeps the row's history.
   */
  private async retireSurplusTables(
    tables: Array<{ id: string; name: string; current_players?: number | null }>,
    surplusTableIds: Set<string>,
    allActiveSeats: Array<{ table_id: string }>
  ): Promise<void> {
    if (surplusTableIds.size === 0) return;
    const occupied = new Set(allActiveSeats.map((s) => s.table_id));
    const retirable = tables.filter(
      (t) =>
        surplusTableIds.has(t.id) && !occupied.has(t.id) && Number(t.current_players ?? 0) === 0
    );
    if (retirable.length === 0) return;

    try {
      // .in('status', [...]) guards the race where the table filled between the
      // seat fetch and this update: a table that went 'playing' is skipped.
      const { error } = await supabase
        .from('tables')
        .update({ status: 'closed' })
        .in(
          'id',
          retirable.map((t) => t.id)
        )
        .is('tournament_id', null)
        /* AUTO EXTENSION (Dan 2026-08-25, table-creation parity). The toggle
           says "Extend table automatically" and had no reader at all. This is
           what it extends: the table's LIFE. A host who switched it on is
           saying "do not close my table just because it went quiet", so an
           empty table carrying the flag is skipped here and stays open for
           business. `.not(...)` rather than a filter on the JS side because
           this is the query that does the closing - a check anywhere else
           could be raced past. */
        /* ...EXCEPT A TABLE MARKED FOR RETIREMENT (2026-09-03). auto_extension
           is a host saying "do not close my table just because it went
           quiet". A retirement is the club saying this stake is not offered
           any more, and that outranks it - otherwise the table is drained to
           empty by the rotator, refused a re-seat forever by surplusTableIds,
           and then skipped here: permanently empty, permanently open, and
           invisible to every sweep. The 2026-09-03 batch all carry
           auto_extension = false, so this is the trap closing before anyone
           falls into it. */
        .or(
          'auto_extension.is.null,auto_extension.eq.false,' +
            'settings->>retire_when_empty.eq.true,settings->>night_parked.eq.true'
        )
        .in('status', ['waiting', 'running']);
      if (error) {
        reportError(error, 'HorseFleet.retireSurplusTables_failed');
        return;
      }
      console.log(
        `[HorseFleet] Retired ${retirable.length} empty surplus table(s): ` +
          `${retirable
            .map((t) => t.name)
            .slice(0, 5)
            .join(', ')}${retirable.length > 5 ? ' ...' : ''}`
      );
    } catch (err: any) {
      reportError(err, 'HorseFleet.retireSurplusTables_error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // V8 DEMAND-BASED TABLE SPAWNING
  // ─────────────────────────────────────────────────────────────────────

  /**
   * If EVERY live table of a config is within one seat of full, create one
   * overflow table ("<name> #2", "#3" — capped at 3 per config). Overflow
   * tables are seeded by the normal cycle on the next pass; empty overflow
   * tables simply idle (the stale-table lifecycle owns closing).
   */
  /**
   * AUTO RESTART and AUTO CREATE TABLE (Dan 2026-08-25, table-creation
   * parity). Two more switches that had tooltips and no readers.
   *
   * The rules live in `fn_table_lifecycle_pass` rather than here for the same
   * reason spawnOverflowTables below could not simply be widened: THAT method
   * only knows the fleet's own DEFAULT_TABLES, matched by name prefix. A
   * host's table is not in that list and never could be. The SQL pass asks the
   * question of every table that carries the flag, which is the only way a
   * host's own switch can mean anything.
   *
   * Idempotent, so it is safe on every cycle, and it reports what it did so
   * this can log it rather than guess.
   */
  private async runTableLifecyclePass(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_table_lifecycle_pass');
      if (error) {
        reportError(error, 'HorseFleet.tableLifecyclePass_failed');
        return;
      }
      if (!Array.isArray(data) || data.length === 0) return;
      for (const row of data as Array<{ action?: string; table_name?: string }>) {
        console.log(`[HorseFleet] lifecycle: ${row.action} "${row.table_name}" (host switch)`);
      }
    } catch (err) {
      reportError(err, 'HorseFleet.tableLifecyclePass_error');
    }
  }

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
    const existing = new Set(
      tables.map((t) => `${String(t.club_id ?? '')}|${String(t.name ?? '').toLowerCase()}`)
    );

    for (const order of orders) {
      try {
        if (openedThisCycle.has(order.hostId)) continue;
        const cap = caps.get(order.hostId);
        if (cap !== undefined && (bodiesOnHost.get(order.hostId)?.size ?? 0) >= cap) continue;

        const stake = stakeForBand(order.band);
        if (!stake) continue;
        const variant = String(order.variant ?? 'nlh').toLowerCase();
        const name = `${variantLabel(variant)} ${stake.sb.toFixed(2)}/${stake.bb.toFixed(2)}`;
        if (existing.has(`${order.hostId}|${name.toLowerCase()}`)) continue;

        const { error } = await supabase.from('tables').insert({
          club_id: order.hostId,
          // The union's own board carries both, which is how every club in
          // that union has always found these games. A standalone club has no
          // union and must not be given one.
          union_id: order.hostId === MIDWAY_UNION_ID ? MIDWAY_UNION_ID : null,
          name,
          game_type: 'cash',
          game_variant: variant,
          stakes: `${stake.sb}/${stake.bb}`,
          small_blind: stake.sb,
          big_blind: stake.bb,
          min_buy_in: Math.round(stake.bb * 40 * 100) / 100,
          max_buy_in: Math.round(stake.bb * 200 * 100) / 100,
          max_players: clampSeatsForVariant(variant, 9),
          current_players: 0,
          status: 'waiting',
          insurance_enabled: true,
        });
        if (error) {
          // A name race between cycles is expected and harmless.
          if (!(error.message || '').includes('duplicate')) {
            reportError(error, 'HorseFleet.openPlannedTable_failed');
          }
          continue;
        }
        openedThisCycle.add(order.hostId);
        console.log(
          `[HorseFleet] Stable Hand opened "${name}" on host ${order.hostId.slice(0, 8)} - ` +
            `the ${order.band} band had no ${variant} game and the floor is under its curve`
        );
      } catch (err) {
        reportError(err, 'HorseFleet.openPlannedTables_error');
      }
    }
  }

  private async spawnOverflowTables(
    tables: Array<{ id: string; name: string; max_players: number }>,
    allActiveSeats: Array<{ table_id: string }>
  ): Promise<void> {
    for (const config of DEFAULT_TABLES) {
      try {
        const family = tables.filter(
          (t) => t.name === config.name || t.name.startsWith(`${config.name} #`)
        );
        if (family.length === 0 || family.length >= MAX_TABLES_PER_CONFIG) continue;
        const allNearFull = family.every((t) => {
          const occ = allActiveSeats.filter((s) => s.table_id === t.id).length;
          return occ >= t.max_players - 1;
        });
        if (!allNearFull) continue;

        const name = `${config.name} #${family.length + 1}`;
        const clubId = this.getNextClubId();
        const { error } = await supabase.from('tables').insert({
          club_id: clubId,
          union_id: MIDWAY_UNION_ID,
          name,
          game_type: 'cash',
          game_variant: config.gameVariant,
          stakes: `${config.smallBlind}/${config.bigBlind}`,
          small_blind: config.smallBlind,
          big_blind: config.bigBlind,
          min_buy_in: config.bigBlind * 40,
          max_buy_in: config.bigBlind * 200,
          // The law is enforced HERE, not only in the config above, so a
          // future config edit cannot put an illegal table in the database.
          max_players: clampSeatsForVariant(config.gameVariant, config.maxPlayers),
          current_players: 0,
          status: 'waiting',
          // ALL-CASH INSURANCE 2026-08-26: overflow cash tables too.
          insurance_enabled: true,
          // 2026-08-28: overflow tables inherit the CONFIG'S IDENTITY. The
          // first straddle overflow ("NLH Straddle 1.00/2.00 #2") went live
          // with straddle_enabled FALSE - a table named for a game it was
          // not running, because this insert never learned about the flag
          // the primary insert had just gained.
          straddle_enabled: config.straddleEnabled === true,
          auto_utg_straddle: config.straddleEnabled === true,
        });
        if (error) {
          // Unique-name races between cycles are expected and harmless.
          if (!(error.message || '').includes('duplicate')) {
            reportError(error, 'HorseFleet.spawnOverflowTable_failed');
          }
        } else {
          console.log(`[HorseFleet] Demand overflow: created "${name}"`);
        }
      } catch (err: any) {
        reportError(err, 'HorseFleet.spawnOverflowTables_error');
      }
    }
  }

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
    budget: number = Number.POSITIVE_INFINITY
  ): Promise<number> {
    let claimed = 0;
    try {
      const tableById = new Map<string, any>(tables.map((t: any) => [t.id as string, t]));

      const { data: offers, error } = await supabase
        .from('table_waitlist')
        .select('id, table_id, user_id, notified_at, hold_expires_at')
        .eq('status', 'notified');
      if (error) throw new Error(error.message);

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
        const buyIn = this.computeHorseBuyIn(
          table,
          offer.user_id,
          bankrolls,
          bankrollsLoaded,
          seatClub
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
    seatClub: string | null | undefined
  ): number {
    const minB = Number(table.min_buy_in) || table.big_blind * 40;
    const maxB = Number(table.max_buy_in) || table.big_blind * 200;
    // V9: humans buy in for ROUND numbers, never 227.40. Snap to a 5bb step,
    // then clamp to the table's real limits.
    const step = table.big_blind * 5;
    const raw = table.big_blind * buyInBBFor(horseId);
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
        bankrollEvent('seat_refused_share_below_min');
        return 0;
      }
      if (capped < buyIn) bankrollEvent('buyin_capped');
      const snapped = Math.round(capped / step) * step;
      buyIn = Math.round(Math.max(minB, Math.min(capped, snapped)) * 100) / 100;
    }
    return buyIn;
  }

  private async seatHorse(
    tableId: string,
    horseId: string,
    seatNumber: number,
    buyIn: number,
    tableName: string,
    clubId: string | null
  ): Promise<boolean> {
    // THE FREEZE IS TOTAL (Dan 2026-09-03): a cycle that began before :53 stops at
    // the first seat after it (a cycle has run for 47 minutes before).
    if (isMaintenanceFrozen()) return false;
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
        return false;
      }

      // Log a tableName-aware description on top of the RPC's generic
      // "Cash game buy-in at table" string so audit reconciliation can
      // match human-readable table names.
      void tableName; // RPC writes its own description; this comment is the trail

      return true;
    } catch (err: any) {
      reportError(err, 'HorseFleet.seatHorse_error');
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
    } catch {
      return { total: 0, available: 0, seated: 0, stuck: 0 };
    }
  }
}
