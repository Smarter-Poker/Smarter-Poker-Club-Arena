/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE SESSION ROTATOR — Humanlike Session Rhythms (V7 — 2026-07-24)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Before V7, horses sat down and never stood up: the fleet seeded seats and
 * only the 4-hour stale-seat cleanup ever emptied one. Real players play
 * SESSIONS — they rack up after a big win, quit after a rough stretch, or
 * simply leave when it is late. This service gives the fleet those rhythms.
 *
 * Every cycle it examines seated horses (cash tables only) and, with a small
 * probability shaped by session length and stack swing, has one stand up:
 *  - the longer the session, the likelier the departure (mean session ~75min)
 *  - doubling the buy-in makes "racking up" likelier; losing most of it
 *    makes "calling it a night" likelier
 *  - at most ONE departure per table per cycle and a global cap per cycle,
 *    so tables never drain — the HorseFleetManager reseeds a DIFFERENT horse
 *    within its 30s cycle, which is exactly the player-turnover a real room
 *    shows.
 *
 * V8 (2026-07-24) SESSION BEHAVIOR upgrades:
 *  - TOP-UPS: short-stacked horses reload toward a fresh buy-in through the
 *    engine's hand-boundary-safe addChips() (wallet-debited, queued if
 *    mid-hand). Wallet-empty horses silently keep playing the short stack —
 *    itself a human pattern.
 *  - SHORT BREAKS: occasionally one horse steps away for 2-5 minutes via the
 *    engine's deferred sit-out, then sits back in. Only at well-populated
 *    tables.
 *  - HUMAN-TABLE PROTECTION: tables with a human present are never thinned
 *    below 5 and absorb half the usual rotation pressure — horse-only tables
 *    do most of the rotating.
 *  - ACTIVITY WINDOWS: outside a horse's daily window (HorseBehavior) its
 *    session-end hazard rises, so the floor population follows daily rhythms.
 *
 * SAFETY: departures go through the SAME path a human uses —
 * ServerTableEngine.leaveTable() — which auto-folds if mid-hand and cashes
 * out at the end of the hand (leave_pending). No direct DB seat surgery, no
 * mid-pot corruption, ever. If a table has no live engine, it is skipped.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { reportError } from './errorReporter.js';
import { cashTableFill, horseHash, wantsTableChange } from './HorseBehavior.js';
import {
  attendanceTarget,
  bedtimeLeaveProbability,
  chicagoMinuteOfDay,
  departuresBudget,
  isAwake,
  mayYieldNow,
  minutesPastBedtime,
  sleepPriority,
} from './HorseAttendance.js';
import { fetchAllRows } from './supabase/pagination.js';
import {
  bankrollPolicyFor,
  referenceBuyIn,
  sessionVerdict,
  topUpAllowance,
} from './HorseBankroll.js';
import { bankrollEvent } from './HorseBankrollTelemetry.js';

const CYCLE_MS = 90_000; // examine the floor every 90s
const GLOBAL_DEPARTURES_PER_CYCLE = 4;
/* ATTENDANCE (Dan 2026-09-03). How often the club rosters are re-read for the
   curve, and the most horses one club sends to bed in one pass over and above
   its over-target budget - the organic bedtime quits are probabilistic and
   this keeps a coincidence from reading as a wave. */
const ROSTER_TTL_MS = 10 * 60_000;
const MAX_BEDTIME_EXTRA_PER_CLUB = 4;
/* A horse that only just sat down does not go to bed. Ten minutes is short
   enough that the wind-down still moves; it exists so that an arrival and a
   departure are never the same horse in consecutive cycles. */
const MIN_MINUTES_BEFORE_BED = 10;
const MIN_SESSION_MINUTES = 20; // nobody hit-and-runs a 5-minute session
const MEAN_SESSION_MINUTES = 75;
// V8: session-behavior knobs
const TOPUP_MIN_MINUTES = 8; // no instant top-ups after sitting down
const TOPUP_STACK_FRAC = 0.45; // top up when below 45% of a standard buy-in
const TOPUP_PROB = 0.25; // per eligible horse per cycle
const BREAK_PROB = 0.35; // chance ONE horse somewhere takes a short break per cycle
const BREAK_MIN_MS = 2 * 60_000;
const BREAK_MAX_MS = 5 * 60_000;

/** Minimal engine surface the rotator needs (matches ServerTableEngine). */
export interface RotatorEngine {
  leaveTable(userId: string): { success: boolean; error?: string; immediate?: boolean };
  /** V8: hand-boundary-safe top-up (queued mid-hand; wallet-debited). */
  addChips?(
    userId: string,
    amount: number
  ): Promise<{ success: boolean; error?: string; queued?: boolean; applied?: number }>;
  /** V8: hand-boundary-safe sit-out/sit-back (folds deferred to hand end). */
  sitOut?(userId: string, sitOut: boolean): { success: boolean; error?: string };
}

export class HorseSessionRotator {
  private isRunning = false;
  private handle: ReturnType<typeof setInterval> | null = null;
  /**
   * V8: horses currently on a short break -> when to sit back in.
   *
   * 2026-08-19 MULTI-TABLE FIX: keyed by `${tableId}:${userId}`, NOT userId.
   * Horses multi-table (up to 4 tables). Keyed by user alone, a break started
   * at table B OVERWROTE a live break record at table A — table A's deferred
   * sit-out was then never sat back in, so the horse sat out at A forever
   * (until it happened to leave, or the process restarted). A session-end
   * departure at one table likewise deleted the break record belonging to a
   * DIFFERENT table, orphaning that sit-out the same way. The value carries
   * userId so the sit-back pass knows who to seat.
   */
  private breaks = new Map<string, { tableId: string; userId: string; sitBackAt: number }>();

  /* ATTENDANCE: club id -> active horse roster size, refreshed every ROSTER_TTL_MS. */
  private roster: { at: number; byClub: Map<string, number> } | null = null;

  /* YIELDING TO A PERSON (Dan 2026-09-03): per table, when a human was first
     seen waiting and when a horse last stood up for the queue. Cleared the
     moment the queue is empty, so a later human starts a fresh clock. */
  private yieldClock = new Map<string, { since: number; lastYieldAt: number | null }>();

  private static breakKey(tableId: string, userId: string): string {
    return `${tableId}:${userId}`;
  }

  constructor(private getEngine: (tableId: string) => RotatorEngine | undefined) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.handle = setInterval(() => {
      // THE FREEZE (Dan 2026-09-01): "HORSES SHOULD NOT STAND UP OR ROTATE."
      // A seat changing hands under a break screen is also the loudest
      // possible horse tell (CLAUDE.md 10.5: timing is part of the treatment).
      if (isMaintenanceFrozen()) return;
      this.rotate().catch((err) => reportError(err, 'HorseSessionRotator.cycle'));
    }, CYCLE_MS);
    console.log(`[SessionRotator] Running - humanlike departures every ${CYCLE_MS / 1000}s cycle`);
  }

  stop(): void {
    this.isRunning = false;
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /**
   * Active horse membership per club, for the attendance curve. Two paged
   * reads (horse ids, then memberships) every ten minutes; a failed or partial
   * read keeps the previous answer, and with no previous answer the curve is
   * simply not applied this cycle - fail open, like the fleet's gates.
   */
  private async rosterByClub(): Promise<Map<string, number> | null> {
    const now = Date.now();
    if (this.roster && now - this.roster.at < ROSTER_TTL_MS) return this.roster.byClub;
    try {
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
        { label: 'SessionRotator.horseIds', maxRows: 50_000 }
      );
      if (!idPage.complete) return this.roster?.byClub ?? null;
      const horse = new Set(idPage.rows.map((r) => r.id));
      const memPage = await fetchAllRows<{ id: string; user_id: string; club_id: string }>(
        (cursor, want) => {
          let q = supabase
            .from('club_members')
            .select('id, user_id, club_id')
            .in('status', ['active', 'approved'])
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'SessionRotator.rosters', maxRows: 200_000 }
      );
      if (!memPage.complete) return this.roster?.byClub ?? null;
      const byClub = new Map<string, number>();
      for (const m of memPage.rows) {
        if (!horse.has(m.user_id)) continue;
        byClub.set(m.club_id, (byClub.get(m.club_id) ?? 0) + 1);
      }
      this.roster = { at: now, byClub };
      return byClub;
    } catch (err) {
      reportError(err, 'HorseSessionRotator.roster');
      return this.roster?.byClub ?? null;
    }
  }

  /**
   * ═══ GOING HOME FOR THE NIGHT (Dan 2026-09-03) ═══════════════════════════
   * "HORSES START ORGANICALLY QUITTING AND GOING TO SLEEP FOR THE NIGHT."
   *
   * Per club: how many horses are seated against how many the curve wants at
   * this Chicago minute. Anyone over the target goes home, a budget's worth a
   * cycle (HorseAttendance.departuresBudget - proportional, so the room walks
   * down rather than dropping), earliest bedtime first. Independently of the
   * count, a horse PAST its own bedtime racks up with a probability that
   * rises the later it gets, whether the room is over target or not - that
   * is the organic part, and it is why the wind-down is made of individuals
   * rather than a quota.
   *
   * Going home means leaving EVERY seat the horse holds in the club: a
   * player who logs off does not stay in three of their four games. Each
   * departure goes through the engine's leaveTable, hand-boundary safe,
   * exactly as every other departure here does. A horse whose seats cannot
   * all be released this cycle (a human's game that would go short, a table
   * with no live engine) is passed over for the next name; it stays up.
   *
   * Returns the set of horses sent home so the table loop below leaves their
   * seats alone.
   */
  private sendSleepersHome(
    seats: Array<{ table_id: string; user_id: string; club_id: string | null; joined_at: string }>,
    allSeats: Array<{ user_id: string; club_id: string | null }>,
    horseIds: Set<string>,
    rosterByClub: Map<string, number> | null,
    chicagoMinute: number
  ): Set<string> {
    const home = new Set<string>();
    if (!rosterByClub || rosterByClub.size === 0) return home;
    const now = Date.now();

    const seatsByHorse = new Map<string, typeof seats>();
    const humansAtTable = new Map<string, number>();
    const seatsAtTable = new Map<string, number>();
    for (const s of seats) {
      seatsAtTable.set(s.table_id, (seatsAtTable.get(s.table_id) ?? 0) + 1);
      if (!horseIds.has(s.user_id)) {
        humansAtTable.set(s.table_id, (humansAtTable.get(s.table_id) ?? 0) + 1);
        continue;
      }
      if (!seatsByHorse.has(s.user_id)) seatsByHorse.set(s.user_id, []);
      seatsByHorse.get(s.user_id)!.push(s);
    }

    /* The COUNT is every seat the horse holds in the club, tournaments
       included - that is what "members playing" means and it is the number
       the fleet manager gates arrivals on. Only CASH seats are candidates to
       leave; a horse in a tournament finishes it. */
    const seatedByClub = new Map<string, Set<string>>();
    for (const s of allSeats) {
      if (!horseIds.has(s.user_id) || !s.club_id) continue;
      if (!seatedByClub.has(s.club_id)) seatedByClub.set(s.club_id, new Set());
      seatedByClub.get(s.club_id)!.add(s.user_id);
    }

    const summary: string[] = [];
    for (const [clubId, seatedSet] of seatedByClub) {
      const roster = rosterByClub.get(clubId);
      if (!roster) continue;
      const target = attendanceTarget(clubId, roster);
      const budget = departuresBudget(seatedSet.size, target);
      const ranked = [...seatedSet].sort(
        (a, b) =>
          sleepPriority(b, chicagoMinute) - sleepPriority(a, chicagoMinute) ||
          horseHash(a) - horseHash(b)
      );
      let overTargetSent = 0;
      let bedtimeSent = 0;
      for (const horseId of ranked) {
        if (overTargetSent >= budget && bedtimeSent >= MAX_BEDTIME_EXTRA_PER_CLUB) break;
        const mine = (seatsByHorse.get(horseId) ?? []).filter((s) => s.club_id === clubId);
        if (mine.length === 0) continue;
        const newest = Math.max(...mine.map((s) => new Date(s.joined_at).getTime() || 0));
        if ((now - newest) / 60_000 < MIN_MINUTES_BEFORE_BED) continue;

        const past = minutesPastBedtime(horseId, chicagoMinute);
        const byQuota = overTargetSent < budget;
        const byBedtime =
          !byQuota &&
          past > 0 &&
          bedtimeSent < MAX_BEDTIME_EXTRA_PER_CLUB &&
          Math.random() < bedtimeLeaveProbability(past, CYCLE_MS / 60_000);
        if (!byQuota && !byBedtime) continue;

        // Every seat must be releasable, or the horse stays up this cycle.
        const engines = mine.map((s) => ({ s, engine: this.getEngine(s.table_id) }));
        const blocked = engines.some(({ s, engine }) => {
          if (!engine) return true;
          const humans = humansAtTable.get(s.table_id) ?? 0;
          return humans > 0 && (seatsAtTable.get(s.table_id) ?? 0) <= 5;
        });
        if (blocked) continue;

        let left = 0;
        for (const { s, engine } of engines) {
          try {
            const r = engine!.leaveTable(horseId);
            if (r.success) {
              left++;
              this.breaks.delete(HorseSessionRotator.breakKey(s.table_id, horseId));
              seatsAtTable.set(s.table_id, (seatsAtTable.get(s.table_id) ?? 1) - 1);
            }
          } catch (err) {
            reportError(err, 'HorseSessionRotator.sleep');
          }
        }
        if (left === 0) continue;
        home.add(horseId);
        if (byQuota) overTargetSent++;
        else bedtimeSent++;
        console.log(
          `[SessionRotator] horse=${horseId.slice(0, 8)} going home (${byQuota ? 'over target' : `${past}m past bedtime`}, ${left} seat(s), club=${clubId.slice(0, 8)})`
        );
      }
      summary.push(
        `${clubId.slice(0, 8)} ${seatedSet.size}/${target} of ${roster} -${overTargetSent + bedtimeSent}`
      );
    }
    if (summary.length > 0) {
      const hh = String(Math.floor(chicagoMinute / 60)).padStart(2, '0');
      const mm = String(chicagoMinute % 60).padStart(2, '0');
      console.log(`[SessionRotator] Attendance (Chicago ${hh}:${mm}): ${summary.join(' | ')}`);
    }
    return home;
  }

  private async rotate(): Promise<void> {
    // Seated horses at CASH tables with enough table population to spare one.
    /* ═══ NO CEILING. IT PAGES UNTIL IT HAS THE WHOLE ROOM ═══════════════
       Dan 2026-08-27: "there should never be a cap on the amount of players
       in the club, union or anywhere else."

       To be exact about what was here: the `.limit(400)` was never a cap on
       PLAYERS - nobody was stopped from joining, sitting or playing by it. It
       was a page size on one background maintenance read. But it capped what
       this pass could SEE, which caps what it can do, and that is a
       distinction without a difference once the room outgrows it: measured
       2026-08-27 the room held 348 live seats, 87% of the ceiling, and past
       400 Postgres would have returned an ARBITRARY 400 with no error and no
       log - tables silently never rotating.

       Raising the number would only move the day it happens, so there is no
       number now. This pages through every live seat, ordered so the paging
       is stable (an unordered .range() can serve a row twice or skip it
       between pages, which is the defect the club_members house rule in the
       client suite exists to catch). The loop ends when a short page says it
       has reached the end; the guard below is an anti-infinite-loop assert,
       NOT a data cap - it throws rather than quietly returning a partial
       room. */
    const PAGE = 1000;
    const seats: any[] = [];
    for (let page = 0; ; page++) {
      if (page > 10_000) {
        reportError(
          new Error('[HorseSessionRotator] seat paging did not terminate; aborting the pass'),
          'HorseSessionRotator.seat_paging_runaway'
        );
        return;
      }
      const { data: chunk, error } = await supabase
        .from('table_seats')
        .select(
          'table_id, user_id, seat_number, stack, joined_at, club_id, tables!inner(id, big_blind, tournament_id, status)'
        )
        .is('left_at', null)
        .order('table_id', { ascending: true })
        .order('seat_number', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      // A failed page means an INCOMPLETE room, and rotating against half a
      // room is how a table gets picked that should not have been. Decline
      // the pass; it runs again on the next cycle.
      if (error || !chunk) return;
      seats.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    /**
     * BANKROLL CONTEXT (Dan 2026-08-31). Two rules below need money facts the
     * seat row does not carry:
     *
     *  - the ROLL, to decide whether a reload is affordable at all;
     *  - what this seat has ALREADY cost, to know whether the session is a
     *    winner worth booking or a loser worth leaving.
     *
     * The second is read from `chip_ledger` rather than a new column on
     * `table_seats`, deliberately: the ledger already records every buy-in
     * and top-up with a table_id and a timestamp, so the exact figure is
     * available without touching a money path to write it.
     *
     * Both are loaded ONCE per cycle. A failure leaves the maps empty, and
     * every rule below degrades to the pre-bankroll behaviour rather than
     * guessing — a rotator that mistakes "I could not read the ledger" for
     * "this horse is stuck" would empty the floor.
     */
    const rolls = new Map<string, number>();
    const investedBySeat = new Map<string, number>();
    try {
      const horseSeatIds = [...new Set(seats.map((s) => s.user_id))];
      if (horseSeatIds.length > 0) {
        const { data: mem } = await supabase
          .from('club_members')
          .select('user_id, club_id, chip_balance')
          .in('user_id', horseSeatIds);
        for (const m of mem ?? []) {
          const v = Number((m as { chip_balance: unknown }).chip_balance);
          if (Number.isFinite(v)) {
            rolls.set(
              `${(m as { club_id: string }).club_id}:${(m as { user_id: string }).user_id}`,
              v
            );
          }
        }
        const oldest = seats.reduce(
          (acc, x) => Math.min(acc, new Date(x.joined_at).getTime()),
          Date.now()
        );
        const { data: led } = await supabase
          .from('chip_ledger')
          .select('to_entity_id, from_entity_id, table_id, amount, category, created_at')
          .gte('created_at', new Date(oldest - 60_000).toISOString())
          .not('table_id', 'is', null)
          .limit(20_000);
        for (const r of led ?? []) {
          const row = r as {
            from_entity_id: string | null;
            table_id: string | null;
            amount: unknown;
          };
          // A buy-in or top-up moves chips FROM the player, so the player is
          // the `from` side. Anything moving TO them is a cash-out and is not
          // money they put at risk.
          if (!row.from_entity_id || !row.table_id) continue;
          const amt = Number(row.amount);
          if (!Number.isFinite(amt) || amt <= 0) continue;
          const k = `${row.table_id}:${row.from_entity_id}`;
          investedBySeat.set(k, (investedBySeat.get(k) ?? 0) + amt);
        }
      }
    } catch (err) {
      reportError(err, 'HorseSessionRotator.bankroll_context');
    }

    // Group by table; only consider cash tables with 4+ occupied seats so a
    // departure never threatens the game.
    const byTable = new Map<string, typeof seats>();
    for (const s of seats) {
      const t = (s as any).tables;
      if (!t || t.tournament_id || t.status === 'closed') continue;
      const arr = byTable.get(s.table_id) || [];
      arr.push(s);
      byTable.set(s.table_id, arr);
    }

    // Verify horse identity in one query.
    const userIds = [...new Set(seats.map((s) => s.user_id))];
    const { data: horses } = await supabase
      .from('profiles')
      .select('id')
      .in('id', userIds)
      .eq('is_horse', true);
    const horseIds = new Set((horses || []).map((h) => h.id));
    const chicagoMinute = chicagoMinuteOfDay();

    /* WHO IS WAITING FOR A SEAT (Dan 2026-09-02). The one reason a horse
       stands up off a full table. Counted per table, humans only - horses do
       not queue any more, and a horse in the count would make a horse stand up
       for a horse.

       Fails CLOSED at an empty map: if the queue cannot be read, nobody is
       released. A person then waits one more 90-second cycle. Failing the
       other way would stand a horse up off every table on the floor because
       one query timed out. */
    const humansWaiting = new Map<string, number>();
    try {
      const { data: queued, error: qErr } = await supabase
        .from('table_waitlist')
        .select('table_id, user_id, status')
        .in('status', ['waiting', 'notified']);
      if (qErr) throw new Error(qErr.message);
      for (const row of queued ?? []) {
        const r = row as { table_id?: string; user_id?: string };
        if (!r.table_id || !r.user_id || horseIds.has(r.user_id)) continue;
        humansWaiting.set(r.table_id, (humansWaiting.get(r.table_id) ?? 0) + 1);
      }
    } catch (err) {
      reportError(err, 'HorseSessionRotator.humansWaiting');
      humansWaiting.clear();
    }

    // V8: end any due short breaks FIRST — sitting a horse back in is never
    // rate-limited.
    for (const [key, info] of [...this.breaks]) {
      if (Date.now() < info.sitBackAt) continue;
      this.breaks.delete(key);
      try {
        this.getEngine(info.tableId)?.sitOut?.(info.userId, false);
      } catch (err) {
        reportError(err, 'HorseSessionRotator.sitBack');
      }
    }

    /* ATTENDANCE: who goes home for the night, before the per-table pass, so
       the pass below does not also pick one of them. Cash seats only - the
       byTable map already excludes tournament tables. */
    const cashSeats = [...byTable.values()].flat();
    const goneHome = this.sendSleepersHome(
      cashSeats,
      seats,
      horseIds,
      await this.rosterByClub(),
      chicagoMinute
    );

    let departures = 0;
    let breakTaken = false;
    for (const [tableId, tableSeats] of byTable) {
      if (departures >= GLOBAL_DEPARTURES_PER_CYCLE) break;
      // V8: tables with a HUMAN present are protected harder — never thin a
      // human's game below 5, and horse-only tables absorb most rotation.
      const humanPresent = tableSeats.some((x) => !horseIds.has(x.user_id));

      /* ── A HORSE GETS UP FOR A PERSON, AND FOR NOTHING ELSE ──────────────
         Dan 2026-09-02: "HORSES CAN FILL ALL SEATS, AND ONLY 'GET UP' WHEN A
         REAL HUMAN IS ON THE WAITING LIST FOR 75% OF ALL GAMES."

         `releaseWanted` is how many seats this table owes to people standing
         in its queue right now. When it is above zero the departure is
         CERTAIN, one per cycle, exactly like the held-empty drain this
         replaced - somebody is waiting, so somebody stands up, and the 4-seat
         floor below does not apply because making room is the point.

         On a FULL table with nobody waiting, the discretionary departures are
         skipped entirely further down: no table-hopping, no session-end
         hazard. That is the other half of Dan's sentence, and without it the
         floor drains itself back out of the seats this fills. The bankroll
         departures - book a win, stop a loss - are NOT skipped: those are
         money decisions, and a horse that plays past its stop-loss is a bug in
         a different law. */
      const releaseWanted = humansWaiting.get(tableId) ?? 0;
      const fill = cashTableFill(tableId);
      if (releaseWanted === 0 && tableSeats.length < (humanPresent ? 5 : 4)) continue;

      /* NOT RIGHT AWAY (Dan 2026-09-03): "A HORSE SHOULD CASH OUT, TO MAKE A
         SEAT FOR THE HUMAN (BUT NOT RIGHT AWAY, AFTER A COUPLE HANDS)... A
         COUPLE HORSES SHOULD BE LEAVING THE TABLE (SLOWLY, WITHIN A COUPLE
         MINUTES OF EACH OTHER)... IT CAN'T BE OBVIOUS."

         The queue still decides HOW MANY stand up (releaseWanted); this clock
         decides WHEN. First yield two to four minutes after the person
         appears, each further yield one and a half to three minutes after
         the last, jittered per table so no two tables keep the same beat. */
      let yieldNow = false;
      if (releaseWanted > 0) {
        const clock = this.yieldClock.get(tableId) ?? { since: Date.now(), lastYieldAt: null };
        this.yieldClock.set(tableId, clock);
        yieldNow = mayYieldNow(tableId, clock, Date.now());
      } else {
        this.yieldClock.delete(tableId);
      }

      const engine = this.getEngine(tableId);
      if (!engine) continue; // no live engine — not our business

      // One candidate per table per cycle, chosen by highest leave pressure.
      let best: { seat: (typeof tableSeats)[number]; p: number } | null = null;
      for (const seat of tableSeats) {
        if (!horseIds.has(seat.user_id)) continue;
        // Already on the way home this cycle - not a candidate for anything.
        if (goneHome.has(seat.user_id)) continue;
        // Somebody is waiting and the clock says now: certain departure, one
        // per cycle, no hazard math. The seat this frees is offered to the
        // head of the queue by fn_offer_open_seat, exactly as it would be for
        // any other departure. While the clock is still running nothing on
        // this table leaves for any discretionary reason (holdsFull below).
        if (yieldNow) {
          best = { seat, p: Number.POSITIVE_INFINITY };
          break;
        }
        if (releaseWanted > 0) continue;
        const t = (seat as any).tables;
        const bb = Number(t?.big_blind) || 2;
        const buyIn = bb * 100;
        const minutes = (Date.now() - new Date(seat.joined_at).getTime()) / 60000;

        // V8 TOP-UPS: humans reload when short — so do (some) horses. Only
        // between-hands-safe engine path; wallet-empty horses silently skip,
        // which is itself a human pattern (the broke guy plays the short
        // stack). Never while on a break.
        const stackNow = Number(seat.stack) || 0;
        if (
          engine.addChips &&
          !this.breaks.has(HorseSessionRotator.breakKey(tableId, seat.user_id)) &&
          minutes >= TOPUP_MIN_MINUTES &&
          stackNow > 0 &&
          stackNow < buyIn * TOPUP_STACK_FRAC &&
          Math.random() < TOPUP_PROB
        ) {
          // V9: humans reload to ROUND figures (a fresh $200, "make it 150"),
          // so the top-up TARGET snaps to a 10bb step before the delta is
          // computed. The engine caps at the table max buy-in on its side.
          const step = bb * 10;
          const target = Math.round((buyIn * (0.85 + Math.random() * 0.3)) / step) * step;
          let amount = Math.round((target - stackNow) * 100) / 100;

          /**
           * A RELOAD IS A FRESH COMMITMENT TO A TABLE THAT IS ALREADY LOSING
           * (Dan 2026-08-31). This was the one path with no bankroll opinion
           * at all: every 90s cycle, any horse under 45% of a buy-in reloaded
           * to a full one, wallet-funded, forever. That is precisely "risking
           * more of their stack than they should", and it is how a bankroll
           * dies one top-up at a time.
           *
           * topUpAllowance holds it to a stricter test than the original
           * seat: the roll must still cover the stake AFTER paying, total
           * exposure to this table cannot walk past the single-buy-in share
           * one reload at a time, and a horse already down its stop-loss does
           * not reload at all — it leaves, through the hazard below.
           */
          const roll = rolls.get(`${(seat as { club_id?: string }).club_id ?? ''}:${seat.user_id}`);
          const desiredTopUp = amount;
          if (roll !== undefined) {
            amount = topUpAllowance({
              bankroll: roll,
              investedThisTable: investedBySeat.get(`${tableId}:${seat.user_id}`) ?? 0,
              desired: amount,
              refBuyIn: buyIn,
              minBuyIn: bb * 40,
              maxBuyIn: bb * 200,
              policy: bankrollPolicyFor(seat.user_id),
            });
          }
          if (amount >= bb) {
            engine
              .addChips(seat.user_id, amount)
              .catch((err) => reportError(err, 'HorseSessionRotator.topUp'));
          } else if (desiredTopUp >= bb) {
            /**
             * The reload the old code would have paid, and the policy did
             * not. Counted rather than merely not-done: this is the one
             * bankroll decision that shows up as an ABSENCE - a short stack
             * that stays short - so without a counter it is indistinguishable
             * from the top-up path being broken.
             */
            bankrollEvent('topup_refused');
          }
        }

        // ── V14 TABLE CHANGE (Dan 2026-08-23) ──────────────────────────
        // "HORSES SHOULD BE RANDOMLY LEAVING GAMES, AND GOING TO OTHERS."
        //
        // The hazard below models a SESSION ENDING — the horse is done for
        // now. That is only half of what a floor looks like. The other half
        // is a player who is still playing but does not want THIS game: the
        // table went quiet, or they just fancy a change, so they pick up and
        // sit somewhere else. Without it the only movement on the floor is
        // arrivals and quitters, and the same faces sit at the same table
        // until they log off.
        //
        // A table change leaves through the same leaveTable() path as any
        // other departure, so it is hand-boundary safe and cashes out
        // properly; the fleet manager then seats them somewhere else on its
        // next cycle, which is exactly the "and going to others" half.
        // Short-handed games shed players fastest, which is how a dying
        // table actually dies.
        /* A FULL TABLE DOES NOT SHED PLAYERS (Dan 2026-09-02). Both of the
           discretionary departures below - fancying a change of game, and the
           session simply ending - are skipped on the 75% of tables that are
           meant to sit full when nobody is queued for a seat. They still run
           on the sparse quarter, which is where the floor's visible churn now
           lives, and they still run the moment somebody is waiting (that path
           is certain and returns above). */
        const holdsFull = fill === 'full' && releaseWanted === 0;

        if (
          !holdsFull &&
          minutes >= MIN_SESSION_MINUTES / 2 &&
          wantsTableChange(seat.user_id, tableId, tableSeats.length, minutes)
        ) {
          best = { seat, p: Number.POSITIVE_INFINITY };
          break;
        }

        if (minutes < MIN_SESSION_MINUTES) continue;

        // Base hazard: exponential session with ~MEAN_SESSION_MINUTES mean,
        // expressed per 90s cycle.
        let p = CYCLE_MS / 60000 / MEAN_SESSION_MINUTES;
        const stack = stackNow;

        /**
         * BOOK THE WIN, STOP THE LOSS (Dan 2026-08-31).
         *
         * The swing curve below reads `stack / (bb * 100)` — an ASSUMED
         * buy-in. A horse that sat down short and doubled its money does not
         * register as a winner, and one that bought in deep and is stuck
         * looks perfectly healthy. Session P&L is the honest measure:
         * everything this seat has cost, against what is in front of it now.
         *
         * When the ledger gives us that figure, the policy decides and the
         * departure is CERTAIN rather than probabilistic — booking a win is
         * a decision a player makes, not a coin they flip. Without the
         * figure we fall through to the original swing heuristic unchanged.
         */
        const invested = investedBySeat.get(`${tableId}:${seat.user_id}`);
        if (invested !== undefined && invested > 0) {
          const verdict = sessionVerdict(
            stack - invested,
            referenceBuyIn(bb, bb * 40, bb * 200),
            bankrollPolicyFor(seat.user_id)
          );
          if (verdict !== 'play_on') {
            bankrollEvent(verdict === 'book_win' ? 'session_book_win' : 'session_stop_loss');
            best = { seat, p: Number.POSITIVE_INFINITY };
            break;
          }
        }

        const swing = stack / buyIn;
        if (swing >= 2)
          p *= 2.2; // doubled up — racking up is human
        else if (swing <= 0.35) p *= 1.8; // felted-ish — calling it a night
        if (minutes > 150) p *= 1.6; // long sessions wind down
        // Outside the horse's waking hours (HorseAttendance chronotype),
        // sessions end sooner. Bedtime proper is sendSleepersHome's job.
        if (!isAwake(seat.user_id, chicagoMinute)) p *= 1.6;
        // V8: rotation prefers horse-only tables — humans keep a stable game.
        if (humanPresent) p *= 0.5;

        /* The session-end half of the 2026-09-02 hold. Zeroing the hazard
           rather than skipping the seat keeps the loop's shape - the seat is
           still the break candidate below, so a full table can still send
           somebody for a five-minute break; it just does not send them
           home. */
        if (holdsFull) p = 0;

        if (!best || p > best.p) best = { seat, p };
      }

      if (best && Math.random() < best.p) {
        try {
          const result = engine.leaveTable(best.seat.user_id);
          if (result.success) {
            departures++;
            if (yieldNow) {
              const clock = this.yieldClock.get(tableId);
              if (clock) clock.lastYieldAt = Date.now();
            }
            // Only THIS table's break record — a break at another table is
            // still live and must still sit back in over there.
            this.breaks.delete(HorseSessionRotator.breakKey(tableId, best.seat.user_id));
            console.log(
              `[SessionRotator] horse=${best.seat.user_id.slice(0, 8)} leaving table=${tableId.slice(0, 8)} ` +
                `after session (stack=${best.seat.stack})`
            );
          }
        } catch (err) {
          reportError(err, 'HorseSessionRotator.leave');
        }
      } else if (
        // V8 SHORT BREAKS: at most ONE horse anywhere per cycle steps away
        // for 2-5 minutes (dealt out via the engine's deferred sit-out, then
        // sits back in). Only at well-populated tables so the game never
        // suffers, and never the table's only action.
        !breakTaken &&
        engine.sitOut &&
        best &&
        // Not already on break at THIS table (re-setting would silently
        // extend the sit-out and reset the sit-back clock).
        !this.breaks.has(HorseSessionRotator.breakKey(tableId, best.seat.user_id)) &&
        tableSeats.length >= (humanPresent ? 6 : 5) &&
        this.breaks.size < 2 &&
        Math.random() < BREAK_PROB / Math.max(1, byTable.size)
      ) {
        try {
          const res = engine.sitOut(best.seat.user_id, true);
          if (res.success) {
            breakTaken = true;
            this.breaks.set(HorseSessionRotator.breakKey(tableId, best.seat.user_id), {
              tableId,
              userId: best.seat.user_id,
              sitBackAt: Date.now() + BREAK_MIN_MS + Math.random() * (BREAK_MAX_MS - BREAK_MIN_MS),
            });
            console.log(
              `[SessionRotator] horse=${best.seat.user_id.slice(0, 8)} short break at table=${tableId.slice(0, 8)}`
            );
          }
        } catch (err) {
          reportError(err, 'HorseSessionRotator.break');
        }
      }
    }
  }
}
