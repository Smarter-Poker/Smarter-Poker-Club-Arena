/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE FLEET POLICY - the engine's read side of the Fleet Command Center
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 3 gives an operator a way to say how many horses take seats, where and
 * when. This module is the ENGINE half of that: it reads
 * `fn_ca_fleet_policy_effective(p_club_id)` (the global row merged with the
 * club row, club winning field by field), caches the answer for 60 seconds,
 * and hands HorseFleetManager a fully-populated policy object it can trust
 * without a null check on every field.
 *
 * ── THE SAFETY RULE THAT OUTRANKS EVERYTHING HERE ─────────────────────────
 * PHASE3-CONTRACTS section 0, binding: THE FLEET KEEPS RUNNING EXACTLY AS IT
 * DOES TODAY UNTIL A POLICY ROW SAYS OTHERWISE.
 *
 * So `FLEET_POLICY_DEFAULTS` is not a set of sensible-looking numbers. Every
 * field is the value that reproduces TODAY'S behaviour byte for byte, and the
 * whole module is written so that every failure path lands on it:
 *
 *   enabled: true            the fleet seeds today, so the default seeds
 *   pauseNewSeatings: false  nothing pauses seating today
 *   maxHorses: null          no fleet-wide cap exists today
 *   maxPerTable: null        the only per-table ceiling today is the table's
 *                            own max_players and occupancyTargetFor's target
 *   occupancyBias: 1.0       1.0 returns occupancyTargetFor's target unchanged
 *   minHumansToSeat: 0       today a table with zero humans is seeded freely
 *   stakeBands: null         today every band is eligible (a horse's OWN band
 *                            still gates it - see stakeBandAllows, untouched)
 *   variants: null           today all nine DEFAULT_TABLES variants are seeded
 *   schedule: null           today seeding runs every 30s, every hour
 *
 * A read that fails returns exactly those defaults with `degraded: true`, and
 * the manager publishes that flag on the cycle's heartbeat so the console can
 * say the fleet is running unmanaged rather than quietly obeying a policy
 * nobody set. Failing OPEN is deliberate and is the contract's choice: a
 * database blip must never be able to empty the floor, which is the exact
 * failure this codebase has already paid for twice (the bankroll gate that
 * read an unknown roll as zero and emptied every cash table for 40 minutes on
 * 2026-08-31, and the truncated table list that starved 134 tables on
 * 2026-09-02). The cost of the choice is that a kill switch does not survive
 * an unreadable database; `degraded` on the heartbeat is what makes that
 * visible instead of silent.
 *
 * ── WHAT THIS MODULE CANNOT DO ────────────────────────────────────────────
 * Nothing here can remove a seated horse, shorten a timer, end a session or
 * cancel a hand. Every knob can only reduce how many NEW seats the manager
 * fills this cycle. A stopped fleet drains through the paths that already
 * exist (HorseSessionRotator, the human-waiting release, bust-outs), and
 * `capBySeatedCount` is written so that a cap already exceeded returns zero
 * rather than a negative number that could ever read as "stand somebody up".
 * HORSES ARE PLAYERS (CLAUDE.md 10.5): a seated horse is treated identically
 * to a seated human, before this file and after it.
 *
 * ── WHY THE HELPERS ARE PURE AND EXPORTED ─────────────────────────────────
 * The manager and its tests use the SAME arithmetic. Two copies of one number
 * is the shape of bug this codebase keeps paying for - src/lib/cashBuyIn.ts
 * exists because four layers disagreed about one buy-in - so the decisions
 * live here as pure functions with no clock and no IO, and HorseFleetManager
 * calls them rather than restating them.
 *
 * NEVER refer to the horses as "bots" - they are HORSES only.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** A UTC hour window during which seating may happen. `end` is EXCLUSIVE. */
export interface FleetScheduleWindow {
  startHourUTC: number;
  endHourUTC: number;
}

export interface FleetPolicy {
  /** false stops NEW seatings. It never removes a seated horse. */
  enabled: boolean;
  /** true stops NEW seatings without disabling the fleet (a softer switch). */
  pauseNewSeatings: boolean;
  /** Fleet-wide ceiling on horses holding seats, or null for no ceiling. */
  maxHorses: number | null;
  /** Ceiling on seats one table may hold, or null for no ceiling. */
  maxPerTable: number | null;
  /** Scales occupancyTargetFor's target. 1.0 changes nothing. */
  occupancyBias: number;
  /** A table with fewer humans than this is not seeded. 0 changes nothing. */
  minHumansToSeat: number;
  /** Stake bands eligible for seating, or null for every band. */
  stakeBands: string[] | null;
  /** Game variants eligible for seating, or null for every variant. */
  variants: string[] | null;
  /** UTC windows in which seating happens, or null for every hour. */
  schedule: FleetScheduleWindow[] | null;
  /** true when the read failed and these are the fallback defaults. */
  degraded: boolean;
  /**
   * `updated_at` of the effective row, sent to the heartbeat as
   * `policy_version`. null when the RPC did not carry one - the heartbeat
   * sends that null through rather than inventing a version.
   */
  version: string | null;
  /** The RPC's `source` map naming which row supplied each value. */
  source: Record<string, string> | null;
}

/** Everything `withheldReason` can look at. Every field is optional: a caller */
/** that does not know a value gets no verdict about it, rather than a guess. */
export interface FleetPolicyContext {
  /** UTC hour of this cycle, for the schedule check. */
  nowUTCHour?: number;
  /** Horses already holding seats fleet-wide, for `maxHorses`. */
  seatedHorses?: number;
  /** Seats already held at this table, for `maxPerTable`. */
  seatedAtTable?: number;
  /** Humans already seated at this table, for `minHumansToSeat`. */
  humansAtTable?: number;
  /** This table's stake band, for `stakeBands`. */
  stakeBand?: string | null;
  /** This table's game variant, for `variants`. */
  variant?: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFAULTS - TODAY'S BEHAVIOUR, WRITTEN DOWN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The fallback, and the seed of the single global policy row.
 *
 * Every value here is chosen to reproduce the engine's behaviour on the day
 * this module was added, so that reading the policy - or failing to read it -
 * changes nothing at all. See the module header for the line-by-line reason
 * each field has the value it has. If you change one of these, you are
 * changing the fleet's behaviour for every club that has no policy row, which
 * is all of them until an operator says otherwise.
 *
 * Frozen so a caller cannot mutate the fallback that every other caller then
 * receives: a policy object handed out on a failed read is shared, and one
 * accidental write to it would persist for the life of the process.
 */
export const FLEET_POLICY_DEFAULTS: Readonly<FleetPolicy> = Object.freeze({
  enabled: true,
  pauseNewSeatings: false,
  maxHorses: null,
  maxPerTable: null,
  occupancyBias: 1.0,
  minHumansToSeat: 0,
  stakeBands: null,
  variants: null,
  schedule: null,
  degraded: false,
  version: null,
  source: null,
} as FleetPolicy);

/** The defaults, marked as the fallback they are. */
function degradedDefaults(): FleetPolicy {
  return { ...FLEET_POLICY_DEFAULTS, degraded: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARSING - every field defensive, every unreadable field falls back
// ═══════════════════════════════════════════════════════════════════════════════

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === true || v === false) return v;
  return fallback;
}

/** A positive whole-number cap, or null. Null covers absent, malformed and */
/** negative: `fn_ca_fleet_set_policy` refuses a negative cap, so one arriving */
/** here is bad data, and bad data must mean "no opinion", never "seat nobody". */
function asCap(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function asNonNegativeInt(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function asBias(v: unknown): number {
  if (v === null || v === undefined) return FLEET_POLICY_DEFAULTS.occupancyBias;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return FLEET_POLICY_DEFAULTS.occupancyBias;
  return n;
}

/**
 * A list of eligible values, or null for "no restriction".
 *
 * An EMPTY array is read as no restriction, not as "nothing is eligible". The
 * column's own no-restriction value is NULL, so an empty array reaches here
 * from a console form where nothing was ticked, and reading that as a fleet
 * kill switch would stop the floor by accident. The kill switch is `enabled`,
 * and it is the only thing that should ever read like one.
 */
function asList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x) => typeof x === 'string')
    .map((x) => (x as string).trim().toLowerCase())
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : null;
}

/** One end of a window. Accepts 0-24 so a window may end at midnight. */
function asHour(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const h = Math.floor(n);
  if (h < 0 || h > 24) return null;
  return h;
}

/**
 * The schedule, normalised to `{ startHourUTC, endHourUTC }`.
 *
 * The contract calls it "an array of UTC hour ranges" and the column is
 * jsonb, so the shape a console writes is not fixed by a type. Four spellings
 * are accepted rather than one, because a schedule that silently fails to
 * parse becomes `null`, `null` means "seat at every hour", and an operator who
 * asked for a night-time-only fleet would get a round-the-clock one with
 * nothing anywhere saying why. Anything genuinely unparseable is dropped and
 * the remaining windows still apply.
 */
function asSchedule(v: unknown): FleetScheduleWindow[] | null {
  if (!Array.isArray(v)) return null;
  const out: FleetScheduleWindow[] = [];
  for (const raw of v) {
    let start: number | null = null;
    let end: number | null = null;
    if (Array.isArray(raw) && raw.length >= 2) {
      start = asHour(raw[0]);
      end = asHour(raw[1]);
    } else if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      start = asHour(o.start_hour_utc ?? o.startHourUTC ?? o.start ?? o.from);
      end = asHour(o.end_hour_utc ?? o.endHourUTC ?? o.end ?? o.to);
    }
    if (start === null || end === null) continue;
    out.push({ startHourUTC: start, endHourUTC: end });
  }
  return out.length > 0 ? out : null;
}

/** The RPC's jsonb, turned into a policy with every field populated. */
function parsePolicy(raw: unknown): FleetPolicy {
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') return { ...FLEET_POLICY_DEFAULTS };
  return {
    enabled: asBool(row.enabled, FLEET_POLICY_DEFAULTS.enabled),
    pauseNewSeatings: asBool(
      row.pause_new_seatings ?? row.pauseNewSeatings,
      FLEET_POLICY_DEFAULTS.pauseNewSeatings
    ),
    maxHorses: asCap(row.max_horses ?? row.maxHorses),
    maxPerTable: asCap(row.max_per_table ?? row.maxPerTable),
    occupancyBias: asBias(row.occupancy_bias ?? row.occupancyBias),
    minHumansToSeat: asNonNegativeInt(
      row.min_humans_to_seat ?? row.minHumansToSeat,
      FLEET_POLICY_DEFAULTS.minHumansToSeat
    ),
    stakeBands: asList(row.stake_bands ?? row.stakeBands),
    variants: asList(row.variants),
    schedule: asSchedule(row.schedule),
    degraded: false,
    version: typeof row.updated_at === 'string' ? row.updated_at : null,
    source:
      row.source && typeof row.source === 'object' && !Array.isArray(row.source)
        ? (row.source as Record<string, string>)
        : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE READ - cached 60 seconds per club scope, never throws, never null
// ═══════════════════════════════════════════════════════════════════════════════

/** 60 seconds, per the contract. The seeding cycle is 30s, so a policy change */
/** reaches the floor within two cycles and the RPC is called at most once a */
/** minute per club scope however many tables that club has. */
const POLICY_TTL_MS = 60_000;

/** One report per scope per five minutes. The engine can deploy before the */
/** World Hub migration lands, and a missing RPC would otherwise file a error reporting */
/** event every cycle for ever - which is how a real signal becomes noise. */
const REPORT_EVERY_MS = 5 * 60_000;

const GLOBAL_SCOPE = '@global';

const cache = new Map<string, { at: number; policy: FleetPolicy }>();
const lastReported = new Map<string, number>();

/**
 * The effective policy for a club, or the global policy when `clubId` is null.
 *
 * NEVER THROWS AND NEVER RETURNS NULL. Every caller is inside a seeding cycle
 * whose failure costs the floor 30 seconds of refills, so this returns the
 * defaults rather than propagating anything.
 *
 * A FAILED READ IS NOT CACHED. The successful value is held for 60 seconds;
 * a failure is retried on the next cycle, so the fleet comes back under
 * management as soon as the database does. The cost is one extra RPC per club
 * scope per cycle while the database is unhappy, which is what every other
 * read in HorseFleetManager already does.
 */
export async function getFleetPolicy(clubId: string | null): Promise<FleetPolicy> {
  const key = clubId ?? GLOBAL_SCOPE;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.policy;

  try {
    const { data, error } = await supabase.rpc('fn_ca_fleet_policy_effective', {
      p_club_id: clubId,
    });
    if (error) throw new Error(error.message || 'fn_ca_fleet_policy_effective failed');
    const policy = parsePolicy(data);
    cache.set(key, { at: Date.now(), policy });
    return policy;
  } catch (err) {
    const now = Date.now();
    if (now - (lastReported.get(key) ?? 0) >= REPORT_EVERY_MS) {
      lastReported.set(key, now);
      reportError(err, 'HorseFleetPolicy.policy_read_failed', { scope: key });
    }
    return degradedDefaults();
  }
}

/** Test hook: drop the cache and the report throttle. */
export function _resetFleetPolicyCacheForTests(): void {
  cache.clear();
  lastReported.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PURE HELPERS - the manager and the tests read the same arithmetic
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Is this UTC hour inside a window the policy allows seating in?
 *
 * No schedule means every hour, which is today's behaviour. `end` is EXCLUSIVE
 * so windows tile without overlapping: 0-8 and 8-16 are adjacent, not
 * arguing. A window whose end is not after its start WRAPS MIDNIGHT - 22 to 2
 * is the late-night window an operator means, not an empty set - and a window
 * with equal ends is the whole day, because the safe reading of an ambiguous
 * window is the one that leaves the floor running.
 */
export function seatingAllowedNow(policy: FleetPolicy, nowUTCHour: number): boolean {
  const windows = policy.schedule;
  if (!windows || windows.length === 0) return true;
  const h = Math.floor(Number(nowUTCHour));
  if (!Number.isFinite(h)) return true;
  const hour = ((h % 24) + 24) % 24;
  for (const w of windows) {
    const start = ((Math.floor(w.startHourUTC) % 24) + 24) % 24;
    const end = w.endHourUTC >= 24 ? 24 : ((Math.floor(w.endHourUTC) % 24) + 24) % 24;
    // Equal ends: the whole day. `end` is only ever 24 when it was written as
    // 24, and `start` is always 0-23, so this cannot swallow a 0 to 24 window.
    if (start === end) return true;
    if (start < end) {
      if (hour >= start && hour < end) return true;
    } else if (hour >= start || hour < end) {
      // Wraps midnight: 22 to 2 covers 22, 23, 0 and 1.
      return true;
    }
  }
  return false;
}

/**
 * Scale a seat target by the policy's occupancy bias.
 *
 * CLAMPED AT BOTH ENDS, and the low clamp is a rule rather than defensive
 * programming: Dan's floor for the sparse quarter is ONE seat
 * (occupancyTargetFor, and the pin in HorseOccupancy.test.ts that says a table
 * always has somebody at it), so no bias, not even 0, may take a table below
 * one seat. The high clamp is the table's own seat law - a bias above 1.0
 * cannot conjure a tenth seat at a nine-hander.
 *
 * A bias of exactly 1.0 returns the target unchanged, which is what makes an
 * absent policy indistinguishable from today.
 *
 * Rounds half up, so a bias of 0.5 on a 9-hander asks for 5 rather than 4:
 * the direction that keeps a game playable.
 */
export function applyBias(target: number, bias: number, maxPlayers: number): number {
  const seats = Math.floor(Number(maxPlayers));
  const hi = Number.isFinite(seats) && seats >= 1 ? seats : 1;
  const t = Number(target);
  const b = Number(bias);
  // Bad data means no opinion: an unreadable bias must not resize a table.
  const scaled = Number.isFinite(t) && Number.isFinite(b) && b >= 0 ? Math.round(t * b) : t;
  if (!Number.isFinite(scaled)) return 1;
  return Math.min(hi, Math.max(1, scaled));
}

/**
 * How many MORE seats this table may be filled to, under a per-table cap.
 *
 * Returns a count, never a target, and NEVER A NEGATIVE NUMBER. That is the
 * whole point of taking `seatedNow`: when a table already holds more than the
 * cap allows - an operator lowering the cap under a live game is the ordinary
 * way that happens - the answer is 0, "seat nobody else", and there is no
 * value this function can return that reads as "stand somebody up". Nothing in
 * Phase 3 may remove a seated horse (PHASE3-CONTRACTS section 0), and this is
 * where that guarantee is arithmetic rather than a promise.
 *
 * `maxPerTable` null is no cap, and then the answer is exactly
 * `target - seatedNow` - the number the seeding loop already computed before
 * this module existed.
 *
 * The cap counts EVERY seat at the table, humans included. It is a statement
 * about how full the fleet makes a table look, and counting only horses would
 * let a cap of 5 sit at a nine-handed game. It also keeps a horse and a human
 * counted identically, which is the only way to count them (CLAUDE.md 10.5).
 */
export function capBySeatedCount(
  target: number,
  seatedNow: number,
  maxPerTable: number | null
): number {
  const t = Number.isFinite(Number(target)) ? Number(target) : 0;
  const now = Number.isFinite(Number(seatedNow)) ? Number(seatedNow) : 0;
  const capped = maxPerTable === null ? t : Math.min(t, maxPerTable);
  return Math.max(0, Math.floor(capped - now));
}

/**
 * May a horse be seated in a game of this band and variant?
 *
 * Both lists default to null, which allows everything. A restriction that is
 * present but cannot be matched excludes: if the caller cannot say what band a
 * table is, this cannot say the operator allowed it. That is the narrow,
 * conservative direction, and it is safe here precisely because the
 * no-restriction case is the common one - an unset list is not a restriction
 * that failed to match, it is no restriction at all.
 *
 * This narrows WHICH TABLES the fleet seeds. It says nothing about how a
 * seated horse is treated, and it never overrides `stakeBandAllows`, which is
 * the horse's OWN earned band and still gates every candidate.
 */
function allowedByList(allowed: readonly string[] | null, value: unknown): boolean {
  if (!allowed) return true;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 && allowed.includes(normalized);
}

export function horseAllowedByPolicy(
  policy: FleetPolicy,
  ctx: { stakeBand?: string | null; variant?: string | null }
): boolean {
  return (
    allowedByList(policy.stakeBands, ctx.stakeBand) && allowedByList(policy.variants, ctx.variant)
  );
}

/**
 * WHY NOTHING IS BEING SEATED, in one short string, or null when nothing is
 * withholding seating.
 *
 * This is what reaches the console as `detail.reason` on the heartbeat. A
 * stopped fleet that cannot say why it stopped looks exactly like a broken
 * one, and the whole point of the Health panel is telling those two apart.
 *
 * The order is the contract's order (PHASE3-CONTRACTS section 2): the kill
 * switch, then the pause, then the caps, then the minimum humans, then band
 * and variant eligibility, then the schedule. First cause wins, so an operator
 * who disabled the fleet is told that, not told it is outside its schedule.
 *
 * Every context field is optional and a cause whose field is absent is
 * skipped, which is what lets one function serve both scopes: the cycle asks
 * with the hour and the fleet-wide seated count, a single table asks with its
 * own occupancy, humans, band and variant.
 */
export function withheldReason(policy: FleetPolicy, ctx: FleetPolicyContext = {}): string | null {
  if (!policy.enabled) return 'fleet_disabled';
  if (policy.pauseNewSeatings) return 'seating_paused';
  if (policy.maxHorses !== null && ctx.seatedHorses !== undefined) {
    if (ctx.seatedHorses >= policy.maxHorses) return 'max_horses_reached';
  }
  if (policy.maxPerTable !== null && ctx.seatedAtTable !== undefined) {
    if (ctx.seatedAtTable >= policy.maxPerTable) return 'max_per_table_reached';
  }
  if (policy.minHumansToSeat > 0 && ctx.humansAtTable !== undefined) {
    if (ctx.humansAtTable < policy.minHumansToSeat) return 'below_min_humans';
  }
  if (policy.stakeBands && ctx.stakeBand !== undefined) {
    if (!allowedByList(policy.stakeBands, ctx.stakeBand)) return 'stake_band_excluded';
  }
  if (policy.variants && ctx.variant !== undefined) {
    if (!allowedByList(policy.variants, ctx.variant)) return 'variant_excluded';
  }
  if (ctx.nowUTCHour !== undefined && !seatingAllowedNow(policy, ctx.nowUTCHour)) {
    return 'outside_schedule';
  }
  return null;
}
