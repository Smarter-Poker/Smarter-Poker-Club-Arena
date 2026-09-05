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
import { selectInChunks } from './supabase/chunkedIn.js';
import { cashTableFill, isActiveNow, isRetiringTable, wantsTableChange } from './HorseBehavior.js';
import {
  bankrollPolicyFor,
  referenceBuyIn,
  sessionVerdict,
  topUpAllowance,
} from './HorseBankroll.js';
import { bankrollEvent } from './HorseBankrollTelemetry.js';

const CYCLE_MS = 90_000; // examine the floor every 90s
const GLOBAL_DEPARTURES_PER_CYCLE = 4;

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
  leaveTable(
    userId: string
  ):
    | { success: boolean; error?: string; immediate?: boolean }
    | Promise<{ success: boolean; error?: string; immediate?: boolean }>;
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
          'table_id, user_id, seat_number, stack, joined_at, club_id, tables!inner(id, big_blind, tournament_id, status, settings, cluster_id)'
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
      const horseSeatIds = seats.map((s) => s.user_id);
      if (horseSeatIds.length > 0) {
        /* CHUNKED, AND AN INCOMPLETE READ IS NOT AN EMPTY WALLET (2026-09-03).
           Same ceiling as the horse read above, and the consequence here is a
           money one rather than a quiet one: with `rolls` empty, `roll` is
           undefined at the top-up below, topUpAllowance() is skipped entirely,
           and the horse reloads the full desired amount with NO bankroll cap.
           An unreadable roll now leaves both maps empty AND says so, and the
           rules below already degrade to the pre-bankroll behaviour - which
           refuses the top-up rather than uncapping it. */
        const memRead = await selectInChunks<{
          user_id: string;
          club_id: string;
          chip_balance: unknown;
        }>(
          horseSeatIds,
          (batch) =>
            supabase
              .from('club_members')
              .select('user_id, club_id, chip_balance')
              .in('user_id', batch),
          'HorseSessionRotator.bankrollRolls'
        );
        const mem = memRead.complete ? memRead.rows : [];
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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  WHO IS A HORSE - IN CHUNKS, AND NEVER GUESSED (2026-09-03)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This was ONE `.in()` over every seated user id and it discarded its
     * error, and both halves of that were fatal together.
     *
     * PostgREST puts the id list in the URL. Measured on production the day
     * this was written: the largest `.in()` it will accept on this table is
     * 675 ids (~25 KB of URL); this pass was handing it 713 and getting HTTP
     * 400 Bad Request. The error went into a discarded `error` field, `horses`
     * came back null, and `horseIds` was therefore EMPTY - which does not read
     * as "the query failed", it reads as "nobody at any table is a horse".
     *
     * Every rule below is keyed on that set, so the whole service went quiet
     * without one line of log: no session ends, no breaks, no top-ups, no
     * table changes, and no retirement drain. `humanPresent` was true at every
     * table in the room, which is the most protective answer possible and so
     * looked like nothing to fix. It had been inert since the room crossed 675
     * seated players, which happened as the fleet grew during 2026-09-03.
     *
     * Two changes, and the second matters more than the first. The read is
     * CHUNKED, like every other id list this repo sends (HorseFleetManager
     * chunks at 200, the elimination sweep at its own idsForChunk). And a
     * failed chunk DECLINES THE PASS: an unreadable horse set is not an empty
     * one, and a pass that cannot tell a horse from a person must do nothing
     * rather than something. That is the same fail-closed rule the seat read
     * above already follows.
     */
    const userIds = seats.map((s) => s.user_id);
    const horseRead = await selectInChunks<{ id: string }>(
      userIds,
      (batch) => supabase.from('profiles').select('id').in('id', batch).eq('is_horse', true),
      'HorseSessionRotator.horseIds'
    );
    if (!horseRead.complete) return; // an unreadable horse set is not an empty one
    const horseIds = new Set(horseRead.rows.map((h) => h.id));
    const hourUTC = new Date().getUTCHours();

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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A TABLE MARKED FOR RETIREMENT IS WALKED OUT, ONE HORSE A CYCLE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Dan 2026-09-03: "CLOSE ANY TABLES OVER 2/5." Deep Stack Society's ladder
     * ran to $50/$100; the empty rungs closed in SQL, but a dozen fixed-limit
     * $3/$6 and $4/$8 tables had horses in hands. A table cannot be closed
     * from outside while its engine is mid-hand - the seats would be cashed
     * out under the pot - so a running table is closed the way a real room
     * closes one: `settings.retire_when_empty` is set on the row, the fleet
     * stops seating anyone there (it joins surplusTableIds in
     * HorseFleetManager.seedAllTables), this pass asks one horse a cycle to
     * stand up through the engine's own leaveTable() (folds if mid-hand,
     * cashes out at the end of the hand), and retireSurplusTables() closes
     * the row once nobody is left.
     *
     * These departures sit OUTSIDE the realism cap below on purpose: the cap
     * keeps a healthy floor from thinning itself, and a retiring table is not
     * a healthy floor - twelve tables at one horse per cycle would otherwise
     * queue behind four discretionary departures for the better part of an
     * hour. One horse per table per cycle keeps the last hand dealing for the
     * others while the table empties over a few minutes.
     */
    for (const [tableId, tableSeats] of byTable) {
      const t = (tableSeats[0] as any)?.tables;
      /* A CLUSTER TABLE IS NEVER RETIRED BY THE FLEET (2026-09-05). Its life
         is its game's controller's: it breaks and moves its players itself.
         A stale `retire_when_empty` flag on one (the old Stable Hand executor
         wrote 25 of them) used to have this loop walk its horses out every
         cycle while the fleet seeded them straight back. */
      if (t?.cluster_id) continue;
      if (!isRetiringTable(t)) continue;
      /* A PERSON OUTRANKS THE CLOSURE (2026-09-03).
         Every other departure rule in this file protects a human's game -
         never thin it below five, halve the leave pressure, hold the floor -
         and the first draft of this loop had none of them: it took the first
         horse it found, once a cycle, human or not. On a nine-handed table
         that empties the person's game in twelve minutes and then strands
         them, because retireSurplusTables refuses to close an occupied table
         and the fleet refuses to re-seat a retiring one. Worse, every horse
         that cashes out calls notifyWaitlistSeatOpen, so the drain would
         offer the freed seats to MORE people.

         A retiring table with a person at it simply stops draining. The
         fleet still seats nobody new there, so it empties as its horses
         leave for their own reasons, and it closes when the last player
         stands up. A table nobody is playing closes in minutes; a table
         somebody IS playing closes when they are done, which is the same
         courtesy a real room extends. */
      if (tableSeats.some((x) => !horseIds.has(x.user_id))) continue;
      const engine = this.getEngine(tableId);
      if (!engine) continue;
      const horseSeat = tableSeats.find((x) => horseIds.has(x.user_id));
      if (!horseSeat) continue;
      try {
        const result = await engine.leaveTable(horseSeat.user_id);
        if (result.success) {
          this.breaks.delete(HorseSessionRotator.breakKey(tableId, horseSeat.user_id));
          console.log(
            `[SessionRotator] horse=${horseSeat.user_id.slice(0, 8)} leaving table=${tableId.slice(0, 8)} ` +
              `- the table is retiring (${tableSeats.length} seated)`
          );
        }
      } catch (err) {
        reportError(err, 'HorseSessionRotator.retireLeave');
      }
    }

    let departures = 0;
    let breakTaken = false;
    for (const [tableId, tableSeats] of byTable) {
      if (departures >= GLOBAL_DEPARTURES_PER_CYCLE) break;
      // A retiring table was handled above; nothing discretionary happens on
      // it - no top-ups into a table that is closing, no breaks.
      if (isRetiringTable((tableSeats[0] as any)?.tables)) continue;
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

      const engine = this.getEngine(tableId);
      if (!engine) continue; // no live engine — not our business

      // One candidate per table per cycle, chosen by highest leave pressure.
      let best: { seat: (typeof tableSeats)[number]; p: number } | null = null;
      for (const seat of tableSeats) {
        if (!horseIds.has(seat.user_id)) continue;
        // Somebody is waiting: certain departure, one per cycle, no hazard
        // math. The seat this frees is offered to the head of the queue by
        // fn_offer_open_seat, exactly as it would be for any other departure.
        if (releaseWanted > 0) {
          best = { seat, p: Number.POSITIVE_INFINITY };
          break;
        }
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
        // V8: outside the horse's daily activity window, sessions end sooner.
        if (!isActiveNow(seat.user_id, hourUTC)) p *= 1.6;
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
          const result = await engine.leaveTable(best.seat.user_id);
          if (result.success) {
            departures++;
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
