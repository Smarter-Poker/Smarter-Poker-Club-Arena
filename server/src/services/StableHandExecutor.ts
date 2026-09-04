/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - the executor, and it only does ONE thing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `planFloor` decides everything: seat, stand, open, close. This executes the
 * two kinds of `stand` order - `human_yield` and `occupancy_wind_down` - and
 * deliberately ignores seat, open and close.
 *
 * WHY ONLY STANDS. The seating loop in HorseFleetManager is exercised every 30
 * seconds against real money and survived three separate incidents to reach
 * its current shape. The blast radius of a bug in a new controller DRIVING it
 * is the whole cash floor; the 2026-08-31 outage emptied that floor for forty
 * minutes from a change smaller than this one. A stand order cannot overshoot
 * occupancy, cannot open a table and cannot spend a chip. Seat, open and close
 * stay reported-only in GET /stable-hand.
 *
 * THE TWO ORDERS ARE NOT THE SAME URGENCY, and are handled separately:
 *
 *   human_yield         somebody is waiting. It runs even when the kill
 *                       switch is on, and its clock starts when the human
 *                       joined the list.
 *   occupancy_wind_down nobody is waiting; the floor is simply above its
 *                       curve. Rate-limited per host so the room walks onto
 *                       the curve over minutes instead of dropping onto it,
 *                       and absent entirely when killed - planFloor does not
 *                       emit it on a killed snapshot.
 *
 * WHY A WIND-DOWN NEEDS THE SEEDER'S AGREEMENT. Standing a horse up here and
 * letting HorseFleetManager reseat that seat thirty seconds later is not a
 * wind-down, it is a cash-out and a buy-in per horse per cycle - expensive,
 * and the loudest tell a floor can have. The seeding cycle carries the same
 * curve now (`stableHandHostCaps`), so a seat freed here is not refilled past
 * the cap. The two halves only work together; shipping this one alone would
 * have produced exactly that churn.
 *
 * HOW A HORSE IS STOOD UP. Through `engine.leaveTable(userId)` - the SAME
 * door a human's Leave Table button opens. It auto-folds if the horse is mid
 * hand, flags the seat `leave_pending`, and cashes out at settlement through
 * `atomic_seat_cashout_locked`. This module NEVER touches `table_seats`, never
 * calls `atomicCashout` directly, and never deletes a seat row: deleting one
 * skips the refund and destroys the chips (CLAUDE.md 11.5 rule 3). If a table
 * has no live engine it is skipped, exactly as HorseSessionRotator does.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). A yield is not a punishment and not a
 * horse-only mechanism - it is the room making space, and the horse leaves
 * through the same door, at the same hand boundary, with the same cash-out as
 * anybody else. The stagger below exists for the same reason: a table that
 * empties the instant a human joins the list tells every watching player which
 * seats were horses.
 */

import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { reportError } from './errorReporter.js';
import { supabase } from './supabase.js';
import { selectInChunks } from './supabase/chunkedIn.js';
import { controllerEnabled, isNightWindow, MIDWAY_UNION_ID, DSS_CLUB_ID } from './StableHand.js';
import {
  chicagoNow,
  planFloor,
  type FloorPlan,
  type FloorSnapshot,
  type StandOrder,
} from './StableHandController.js';
import { buildFloorSnapshot } from './StableHandSnapshot.js';
import { buildBeats, writeBeats, bankVerdict, type BankVerdict } from './StableHandBeats.js';
import { publishPlan } from './StableHandPlanBus.js';
import { dailyGuaranteePerHost } from './FreeBuy.js';

/**
 * The engine surface a stand needs. Matches ServerTableEngine.
 *
 * CHIP CONTINUITY (Operation Table Stakes, landed on main 2026-09-04): a cash
 * player who is AHEAD of the money they put in stays seated until a stay clock
 * runs down, and `leaveTable` answers `LEAVE_LOCKED` with the milliseconds
 * remaining. `forced` bypasses it and IS DELIBERATELY NOT PASSED HERE - horses
 * are players, and a horse let out of a stay clock a human is held to is
 * exactly the "equal outcome by a different mechanism" exemption Dan rejected
 * outright (CLAUDE.md 10.5). A locked horse waits, like anybody else.
 */
export interface YieldEngine {
  leaveTable(
    userId: string,
    opts?: { forced?: boolean }
  ): Promise<{
    success: boolean;
    error?: string;
    immediate?: boolean;
    code?: 'LEAVE_LOCKED';
    stay_remaining_ms?: number;
  }>;
}

export const STABLE_HAND_CYCLE_MS = 30_000;

/**
 * How long a yield order for the same (table, horse) is not re-issued.
 *
 * `leaveTable` on a horse that is mid-hand does not free the seat: it flags
 * the row `leave_pending` and settlement finishes the job. The horse is still
 * seated in the next snapshot, so the plan asks for the same yield again.
 * Re-issuing would queue another auto_fold every cycle for as long as the hand
 * runs. Two minutes is comfortably longer than any cash hand.
 */
export const YIELD_COOLDOWN_MS = 120_000;

/**
 * Yields executed in one cycle, across the whole estate.
 *
 * NOT a rationing of humans - `yieldCount` already caps a single table at
 * humans_waiting + 1, and anything held back here is re-planned 30 seconds
 * later, so nobody is stranded. It is a circuit breaker: if a bug ever makes
 * the planner ask for two hundred stands at once, this is what stops it from
 * happening all at once, and the log line says it happened.
 */
export const MAX_YIELDS_PER_CYCLE = 12;

/**
 * Wind-down stands per host per cycle.
 *
 * The room already sees up to four departures every 90 seconds from ordinary
 * session ends (HorseSessionRotator), so four per 30-second cycle per host is
 * a few times the natural rhythm - brisk, not a stampede. The planner already
 * picks at most ONE victim per table, so no single table ever loses more than
 * one seat per cycle whatever this number is; it only bounds how much of the
 * floor moves at once. At four, a host 129 bodies above its curve reaches it
 * in about sixteen minutes.
 */
export const MAX_WIND_DOWN_PER_HOST_PER_CYCLE = 4;

/**
 * Table flag writes per cycle.
 *
 * The first cycle after this ships has ~89 tables to mark for retirement and,
 * overnight, a hundred or so to park. Every cycle after that has none, because
 * a table already carrying its flag is skipped. The cap keeps that first tick
 * short rather than rationing anything: what is not written now is written
 * thirty seconds later.
 */
export const MAX_TABLE_FLAG_WRITES_PER_CYCLE = 25;

/** How often the guarantee banks are read. Two indexed single-row reads. */
export const BANK_CHECK_EVERY_MS = 15 * 60_000;

/**
 * THE TWO FLAGS, AND WHY THEY MUST NEVER BE THE SAME ONE.
 *
 * `retire_when_empty` is the estate's existing, proven retirement mechanism
 * (Dan 2026-09-03, "close any tables over 2/5"): HorseFleetManager stops
 * seeding the table, HorseSessionRotator walks its horses out, and
 * retireSurplusTables closes it once it is GENUINELY EMPTY - a table with
 * anybody at it is left alone and retired on a later cycle. That is exactly
 * "drain first, never kick anyone", and it is what the permanent exotic and
 * limit trim uses.
 *
 * It is also PERMANENT BY DESIGN. ensureAllTablesExist reopens a closed table
 * unless it carries this flag, specifically so a deliberate retirement is not
 * undone on the next boot. Using it for a nightly consolidation would delete
 * the floor: one quiet night and eighty tables never come back, and for Deep
 * Stack Society - whose tables the fleet does not create at all - nothing
 * would ever recreate them.
 *
 * So the night uses its own flag, with its own lifetime, lifted every morning.
 */
export const RETIRE_FLAG = 'retire_when_empty';
export const NIGHT_PARK_FLAG = 'night_parked';

export interface YieldRequest {
  order: StandOrder;
  /** When the longest-waiting human at that table joined the list, in ms. */
  waitingSinceMs: number;
}

export function yieldKey(o: StandOrder): string {
  return `${o.tableId}:${o.horseId}`;
}

/**
 * PURE. Which yield requests are ripe right now.
 *
 * A request is ripe when the human has been waiting at least the horse's own
 * staggered delay (2-5 minutes, a sha256 of horse, table and list, so the same
 * horse always waits the same amount and a re-planned tick cannot change its
 * mind) and no order for the same seat was issued inside the cooldown.
 *
 * A request whose table reported no join time is treated as ripe IMMEDIATELY
 * rather than skipped. A missing timestamp is a read that failed, not a human
 * who is not waiting, and the failure a waiting human must never hit is the
 * one where nobody stands up at all.
 */
export function ripeYields(
  requests: YieldRequest[],
  nowMs: number,
  holdUntil: ReadonlyMap<string, number>,
  opts: { max?: number } = {}
): { execute: YieldRequest[]; heldByCooldown: number; heldByCap: number } {
  const max = opts.max ?? MAX_YIELDS_PER_CYCLE;
  let heldByCooldown = 0;
  const ready: YieldRequest[] = [];

  for (const r of requests) {
    if (r.order.reason !== 'human_yield') continue;
    const until = holdUntil.get(yieldKey(r.order));
    if (until !== undefined && nowMs < until) {
      heldByCooldown++;
      continue;
    }
    const waited = Number.isFinite(r.waitingSinceMs) ? nowMs - r.waitingSinceMs : Infinity;
    if (waited < r.order.delayMs) continue;
    ready.push(r);
  }

  // Longest-waiting human first, so a cap can never starve the person who has
  // been queuing the longest.
  ready.sort((a, b) => a.waitingSinceMs - b.waitingSinceMs);
  return {
    execute: ready.slice(0, max),
    heldByCooldown,
    heldByCap: Math.max(0, ready.length - max),
  };
}

/** PURE. Every human_yield order in a plan, paired with its table's wait clock. */
export function yieldRequestsFor(snap: FloorSnapshot): YieldRequest[] {
  return standOrdersFor(snap).yields;
}

export interface WindDownRequest {
  order: StandOrder;
  hostId: string;
}

export interface FloorStandOrders {
  yields: YieldRequest[];
  windDowns: WindDownRequest[];
  alerts: string[];
  /** The whole plan, so a caller does not run the planner twice. */
  plan: FloorPlan;
}

/** PURE. Both kinds of stand order, from ONE pass of the planner. */
export function standOrdersFor(snap: FloorSnapshot): FloorStandOrders {
  const waitSince = new Map<string, number>();
  const hostOfTable = new Map<string, string>();
  for (const host of snap.hosts) {
    for (const t of host.tables) {
      hostOfTable.set(t.tableId, host.hostId);
      if (t.waitlistOldestJoinedAtMs !== undefined) {
        waitSince.set(t.tableId, t.waitlistOldestJoinedAtMs);
      }
    }
  }
  const plan = planFloor(snap);
  return {
    yields: plan.stand
      .filter((o) => o.reason === 'human_yield')
      .map((order) => ({ order, waitingSinceMs: waitSince.get(order.tableId) ?? NaN })),
    windDowns: plan.stand
      .filter((o) => o.reason === 'occupancy_wind_down')
      .map((order) => ({ order, hostId: hostOfTable.get(order.tableId) ?? '' })),
    alerts: plan.alerts,
    plan,
  };
}

/**
 * PURE. Which wind-down stands run this cycle.
 *
 * There is no delay to serve - nobody is waiting - so the only gates are the
 * cooldown (a seat ordered to stand while a hand finishes must not be ordered
 * again) and the per-host ceiling. Anything held back is re-planned in thirty
 * seconds, so the floor walks down rather than dropping.
 */
export function ripeWindDowns(
  requests: WindDownRequest[],
  nowMs: number,
  holdUntil: ReadonlyMap<string, number>,
  opts: { maxPerHost?: number } = {}
): { execute: WindDownRequest[]; heldByCooldown: number; heldByCap: number } {
  const maxPerHost = opts.maxPerHost ?? MAX_WIND_DOWN_PER_HOST_PER_CYCLE;
  let heldByCooldown = 0;
  let heldByCap = 0;
  const perHost = new Map<string, number>();
  const execute: WindDownRequest[] = [];

  for (const r of requests) {
    if (r.order.reason !== 'occupancy_wind_down') continue;
    const until = holdUntil.get(yieldKey(r.order));
    if (until !== undefined && nowMs < until) {
      heldByCooldown++;
      continue;
    }
    const taken = perHost.get(r.hostId) ?? 0;
    if (taken >= maxPerHost) {
      heldByCap++;
      continue;
    }
    perHost.set(r.hostId, taken + 1);
    execute.push(r);
  }
  return { execute, heldByCooldown, heldByCap };
}

export class StableHandExecutor {
  private handle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;
  /**
   * `${tableId}:${horseId}` -> the moment this seat may be ordered again.
   *
   * A NOT-BEFORE rather than a last-ordered-at, because the wait is no longer
   * one number. An ordinary stand settles inside the cooldown; a stand refused
   * by the chip-continuity stay clock knows EXACTLY when it can be retried,
   * and re-asking every thirty seconds until then is thirty pointless refusals
   * per minute per seat.
   */
  private readonly holdUntil = new Map<string, number>();
  /** Stands skipped this cycle because the table had no live engine. */
  private noEngine = 0;
  /** Stands held this cycle by a chip-continuity stay clock. Expected, not a
   *  failure: the horse is ahead of its buy-in and stays, like anybody else. */
  private stayLocked = 0;
  /** Stands that actually LANDED this cycle, per host, for the heartbeat. The
   *  gap between planned and executed is the only way to see a controller that
   *  decides correctly and cannot act. */
  private readonly executedYields = new Map<string, number>();
  private readonly executedWindDowns = new Map<string, number>();
  /** When the guarantee banks were last read, and what they last said. */
  private lastBankCheckAt = 0;
  private readonly lastBankVerdict = new Map<string, BankVerdict>();

  /**
   * Write one settings flag onto the tables that do not already carry it.
   *
   * Reads first and skips the ones already flagged, so the steady state is
   * zero writes: this is loud on the first cycle and silent forever after.
   * `settings` is MERGED, never replaced - a table's straddle, auto-extension
   * and every other setting live in the same column.
   */
  private async setTableFlag(ids: string[], flag: string, budget: number): Promise<number> {
    if (ids.length === 0 || budget <= 0) return 0;
    const rows = await selectInChunks<{ id: string; settings: unknown }>(
      ids,
      (batch) => supabase.from('tables').select('id, settings').in('id', batch),
      `StableHand.readSettings.${flag}`
    );
    // A partial read is not "none of them are flagged": writing on a failed
    // read would re-flag rows every cycle forever. Wait for a clean read.
    if (!rows.complete) return 0;

    let written = 0;
    for (const row of rows.rows) {
      if (written >= budget) break;
      const settings =
        row.settings && typeof row.settings === 'object'
          ? (row.settings as Record<string, unknown>)
          : {};
      if (settings[flag] === true) continue;
      const { error } = await supabase
        .from('tables')
        .update({ settings: { ...settings, [flag]: true } })
        .eq('id', row.id);
      if (error) {
        reportError(error, `StableHandExecutor.setTableFlag.${flag}`);
        continue;
      }
      written++;
    }
    return written;
  }

  /**
   * Morning. Lift every night park: clear the flag, and reopen the table if
   * the drain closed it while it was parked.
   *
   * Runs on EVERY cycle outside the night window, not once at 08:00, because
   * a park that is only ever lifted by a single scheduled moment is a park
   * that survives an engine restart at 07:59. It is idempotent and costs one
   * indexed read when there is nothing to lift.
   */
  private async unparkTables(): Promise<number> {
    const { data, error } = await supabase
      .from('tables')
      .select('id, status, settings')
      .in('club_id', [MIDWAY_UNION_ID, DSS_CLUB_ID])
      .is('tournament_id', null)
      .eq(`settings->>${NIGHT_PARK_FLAG}`, 'true');
    if (error) {
      reportError(error, 'StableHandExecutor.unparkTables_read');
      return 0;
    }
    let lifted = 0;
    for (const row of (data ?? []) as Array<{ id: string; status: string; settings: unknown }>) {
      const settings =
        row.settings && typeof row.settings === 'object'
          ? { ...(row.settings as Record<string, unknown>) }
          : {};
      delete settings[NIGHT_PARK_FLAG];
      const patch: Record<string, unknown> = { settings };
      // Reopen it. A parked table that emptied was closed by the fleet's
      // retirement pass; nothing else will bring it back, and for Deep Stack
      // Society nothing else could.
      if (String(row.status) === 'closed') patch.status = 'waiting';
      const { error: updErr } = await supabase.from('tables').update(patch).eq('id', row.id);
      if (updErr) {
        reportError(updErr, 'StableHandExecutor.unparkTables_write');
        continue;
      }
      lifted++;
    }
    if (lifted > 0) console.log(`[StableHand] morning: unparked ${lifted} table(s)`);
    return lifted;
  }

  /**
   * ── THE BANK THAT FUNDS THE GUARANTEES ─────────────────────────────────
   *
   * The Free Buy board commits 1,500 chips a day per host in guarantees, and
   * `fn_ca_fund_overlay_on_lock` draws the shortfall from `union_wallets` for
   * a union-owned event and from `clubs.chip_treasury` for a standalone one.
   * Nothing anywhere said how much runway was left, so the first anybody would
   * have known is an event refusing to start.
   *
   * MEASURED IN DAYS, NOT CHIPS. A chip threshold has to be re-chosen every
   * time the board changes; a runway does not.
   *
   * Alerts ON CHANGE only. A warning re-filed every thirty seconds is a
   * warning somebody mutes, and the row stays open until it is resolved.
   */
  private async checkBanks(snap: FloorSnapshot, nowMs: number): Promise<void> {
    if (nowMs - this.lastBankCheckAt < BANK_CHECK_EVERY_MS) return;
    this.lastBankCheckAt = nowMs;
    const daily = dailyGuaranteePerHost();

    for (const host of snap.hosts) {
      try {
        let bank: number | null = null;
        let store = '';
        if (host.hostId === MIDWAY_UNION_ID) {
          const { data } = await supabase
            .from('union_wallets')
            .select('chip_balance')
            .eq('union_id', host.hostId)
            .maybeSingle();
          if (data) {
            bank = Number((data as { chip_balance?: unknown }).chip_balance) || 0;
            store = 'union_wallets.chip_balance';
          }
        } else {
          const { data } = await supabase
            .from('clubs')
            .select('chip_treasury')
            .eq('id', host.hostId)
            .maybeSingle();
          if (data) {
            bank = Number((data as { chip_treasury?: unknown }).chip_treasury) || 0;
            store = 'clubs.chip_treasury';
          }
        }
        // An unreadable bank is not an empty one.
        if (bank === null) continue;

        const verdict = bankVerdict({ bank, dailyGuarantee: daily });
        const previous = this.lastBankVerdict.get(host.hostId);
        this.lastBankVerdict.set(host.hostId, verdict);
        if (verdict === 'ok' || verdict === previous) continue;

        const days = daily > 0 ? (bank / daily).toFixed(1) : 'unbounded';
        await supabase.rpc('fn_raise_server_financial_alert', {
          p_severity: verdict === 'critical' ? 'critical' : 'warning',
          p_source: 'StableHandExecutor.checkBanks',
          p_message:
            `The bank that funds guarantees for host ${host.hostId} holds ${bank} chips in ` +
            `${store}, which is ${days} days of the board's own ${daily} a day. Refill it ` +
            `before an event refuses to start.`,
          p_context: {
            kind: 'stable_hand_bank_runway',
            host_id: host.hostId,
            store,
            bank,
            daily_guarantee: daily,
            runway_days: Number(days),
            verdict,
          },
          p_entity_id: host.hostId,
        });
        console.warn(
          `[StableHand] bank ${verdict}: host ${host.hostId.slice(0, 8)} holds ${bank} in ` +
            `${store} - ${days} days of guarantees`
        );
      } catch (err) {
        reportError(err, 'StableHandExecutor.checkBanks');
      }
    }
  }

  /** Both table-flag passes for one cycle. */
  private async applyTableFlags(plan: FloorPlan, night: boolean): Promise<void> {
    let budget = MAX_TABLE_FLAG_WRITES_PER_CYCLE;

    /* THE PERMANENT TRIM FIRST. Dan 2026-09-04: "yes close all those tables.
       drain first, and never kick anyone." Marking the flag IS the drain: the
       fleet stops seeding it, the rotator walks its horses out, and the
       retirement pass closes it only once it is genuinely empty. Nothing here
       cashes a seat out. */
    const retired = await this.setTableFlag(plan.close, RETIRE_FLAG, budget);
    budget -= retired;
    if (retired > 0) {
      console.log(
        `[StableHand] marked ${retired} table(s) to retire when empty ` +
          `(${plan.close.length} on the plan; they drain first and nobody is moved)`
      );
    }

    if (night) {
      const parked = await this.setTableFlag(plan.park, NIGHT_PARK_FLAG, budget);
      if (parked > 0) {
        console.log(
          `[StableHand] parked ${parked} thin table(s) for the night ` +
            `(${plan.park.length} on the plan; lifted again in the morning)`
        );
      }
      return;
    }
    await this.unparkTables();
  }

  /**
   * Stand ONE horse up, through the same door a human's Leave Table button
   * opens. Mid-hand it auto-folds and defers the cash-out to settlement;
   * between hands it cashes out immediately. Either way the chips go back to
   * the wallet through atomic_seat_cashout_locked, and this module never
   * touches a seat row itself.
   */
  private async stand(order: StandOrder, nowMs: number, why: string): Promise<boolean> {
    /* Re-checked per seat: a break can begin between the snapshot and the last
       order in it. */
    if (isMaintenanceFrozen()) return false;
    const engine = this.getEngine(order.tableId);
    if (!engine) {
      this.noEngine++;
      return false;
    }
    /* NO `forced`. Chip continuity holds a player who is ahead of their buy-in
       in the seat until a stay clock runs down, and a horse is held to it like
       anybody else - a horse let out of a clock a human cannot escape is the
       "equal outcome by a different mechanism" exemption Dan rejected. */
    const result = await engine.leaveTable(order.horseId);
    const key = yieldKey(order);

    if (result?.success) {
      this.holdUntil.set(key, nowMs + YIELD_COOLDOWN_MS);
      console.log(
        `[StableHand] ${order.reason}: horse ${order.horseId.slice(0, 8)} stood from table ` +
          `${order.tableId.slice(0, 8)} - ${why} ` +
          `(${result.immediate ? 'immediate' : 'at the end of the hand'})`
      );
      return true;
    }

    /* A STAY CLOCK IS NOT A FAILURE, and it knows exactly when it lifts. Held
       until then rather than for a flat cooldown: re-asking every thirty
       seconds is thirty refusals a minute for a seat that answers the same way
       every time until the clock reaches zero. */
    if (result?.code === 'LEAVE_LOCKED') {
      const remaining = Math.max(0, Number(result.stay_remaining_ms) || 0);
      this.holdUntil.set(key, nowMs + remaining + 1_000);
      this.stayLocked++;
      return false;
    }

    this.holdUntil.set(key, nowMs + YIELD_COOLDOWN_MS);
    console.warn(
      `[StableHand] ${order.reason} refused for ${order.horseId.slice(0, 8)} at ` +
        `${order.tableId.slice(0, 8)}: ${result?.error ?? 'unknown'}`
    );
    return false;
  }

  constructor(private readonly getEngine: (tableId: string) => YieldEngine | undefined) {}

  start(): void {
    if (this.running) return;
    if (!controllerEnabled()) {
      console.log('[StableHand] Executor disabled by STABLE_HAND_CONTROLLER - planning only');
      return;
    }
    this.running = true;
    this.handle = setInterval(() => {
      void this.cycle();
    }, STABLE_HAND_CYCLE_MS);
    console.log(
      `[StableHand] Executor running - human yield only, every ${STABLE_HAND_CYCLE_MS / 1000}s`
    );
  }

  stop(): void {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  async cycle(): Promise<number> {
    /* THE FREEZE IS TOTAL (Dan 2026-09-01): "HORSES SHOULD NOT STAND UP OR
       ROTATE, EVERYTHING JUST FREEZES." A seat changing hands under a break
       screen is also the loudest possible horse tell. The human keeps their
       place on the list and the yield fires on the first cycle after the thaw
       - the wait clock is the list's own created_at, which the break cannot
       move, so nothing is lost by waiting. */
    if (isMaintenanceFrozen()) return 0;
    // The kill switch stops NEW sits and the wind-down, never a yield: a kill
    // switch that strands a waiting human is not a safety feature, it is a
    // second outage. planFloor runs its yield pass on a killed snapshot and
    // emits no occupancy order at all, so both rules are already served by the
    // snapshot and neither is re-decided here.
    if (!controllerEnabled()) return 0;
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const snap = await buildFloorSnapshot();
      const orders = standOrdersFor(snap);
      const now = Date.now();

      /* SEAT AND OPEN GO TO THE SEEDER, not to this module. Choosing which
         horse, from which wallet, for how much, against a bankroll, a tag, a
         mutex and a club membership is one implementation and it lives in
         HorseFleetManager. Publishing is how the shape reaches it without
         becoming a second answer to "may this horse sit here". */
      publishPlan(orders.plan, now);

      /* YIELDS FIRST, ALWAYS. Somebody is waiting for one of these seats and
         nobody is waiting for a wind-down, so a yield never queues behind the
         shape of the floor. */
      const yields = ripeYields(orders.yields, now, this.holdUntil);
      if (yields.heldByCap > 0) {
        console.warn(
          `[StableHand] yield cap hit: ${yields.heldByCap} ripe yield(s) deferred to the next ` +
            `cycle (ceiling ${MAX_YIELDS_PER_CYCLE})`
        );
      }
      const winds = ripeWindDowns(orders.windDowns, now, this.holdUntil);

      const hostOfTable = new Map<string, string>();
      for (const h of snap.hosts) for (const t of h.tables) hostOfTable.set(t.tableId, h.hostId);

      let stood = 0;
      for (const r of yields.execute) {
        const waited = Math.round((now - r.waitingSinceMs) / 1000);
        if (
          await this.stand(
            r.order,
            now,
            `after ${Number.isFinite(waited) ? waited : 0}s of human wait`
          )
        ) {
          stood++;
          const host = hostOfTable.get(r.order.tableId);
          if (host) this.executedYields.set(host, (this.executedYields.get(host) ?? 0) + 1);
        }
      }
      for (const r of winds.execute) {
        if (
          await this.stand(
            r.order,
            now,
            `host ${r.hostId.slice(0, 8)} is above its occupancy curve`
          )
        ) {
          stood++;
          this.executedWindDowns.set(r.hostId, (this.executedWindDowns.get(r.hostId) ?? 0) + 1);
        }
      }
      if (this.stayLocked > 0) {
        console.log(
          `[StableHand] ${this.stayLocked} stand(s) held by a stay clock - those horses are ` +
            `ahead of their buy-in and stay seated, like anybody else`
        );
        this.stayLocked = 0;
      }

      /* The table flags. Not stands and not money: this marks a table so the
         fleet's own drain stops seeding it and its own retirement pass closes
         it once EMPTY. Run after the stands so the plan the flags come from is
         the same one that was just acted on. */
      await this.applyTableFlags(orders.plan, isNightWindow(chicagoNow().hour));

      /* ══ THE HEARTBEAT ═══════════════════════════════════════════════════
         Written after the work, so it records what was actually DONE and not
         what was merely intended - the gap between the two is the only way to
         see a controller that decides correctly and cannot act.

         THIS CALL WENT MISSING ONCE. A refactor on 2026-09-04 rewrote the
         block above it and took the beat write and the bank check with it. The
         imports stayed, `checkBanks` stayed defined, typecheck stayed clean,
         5,371 tests stayed green - and `stable_hand_beats` held ZERO rows for
         four hours of live running while every other order executed normally.
         The feature that exists to notice silence was itself silent. Two pins
         in StableHandExecutor.test.ts now assert both calls by name. */
      await writeBeats(
        buildBeats(snap, orders.plan, {
          yieldsByHost: this.executedYields,
          windDownsByHost: this.executedWindDowns,
        }),
        now
      );
      this.executedYields.clear();
      this.executedWindDowns.clear();

      await this.checkBanks(snap, now);

      if (this.noEngine > 0) {
        console.warn(
          `[StableHand] ${this.noEngine} stand(s) skipped - no live engine for the table, ` +
            `retried next cycle`
        );
        this.noEngine = 0;
      }
      if (winds.execute.length > 0 || winds.heldByCap > 0) {
        console.log(
          `[StableHand] wind-down: ${winds.execute.length} stood, ${winds.heldByCap} deferred to ` +
            `the next cycle, ${orders.windDowns.length} wanted by the plan`
        );
      }
      if (
        yields.heldByCooldown > 0 &&
        stood === 0 &&
        yields.execute.length === 0 &&
        winds.execute.length === 0
      ) {
        // Nothing acted on and everything held: worth one line, not a storm.
        console.log(
          `[StableHand] ${yields.heldByCooldown} yield(s) still settling from a previous cycle`
        );
      }
      return stood;
    } catch (err) {
      reportError(err, 'StableHandExecutor.cycle');
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}
