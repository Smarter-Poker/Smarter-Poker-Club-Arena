/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP CONTINUITY IS HOUSE LAW ON EVERY CASH TABLE (Operation Table Stakes,
 *  Slice 0 - OPORD 1.3 section 6, OPORD 1.4 section 2.5). 2026-09-04.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three rules, all cash, no flag, no badge:
 *   I1  chips that hit the table stay on the table until the player leaves;
 *   I5  a player ahead of the money they put in stays seated until a
 *       10-minute stay clock reaches zero;
 *   I7  a player who leaves a game with chips returns to the same game in the
 *       same club within 2 hours with at least the stack they left with.
 *
 * The database owns the clock and the floor (migration
 * 20260904120000_chip_continuity_slice_0). This file pins the ENGINE side:
 * the mirror that renders the countdown, the one door a voluntary leave goes
 * through, the settlement step that reports every stack, and the absence of
 * any way to take chips off a seat. Every pin below is a leak that would
 * otherwise ship silently.
 *
 * A0.x numbers refer to the OPORD 1.3 section 6.7 scoreboard. The database
 * halves of those scenarios (A0.2-A0.13, A0.15-A0.17) were run in a rolled-
 * back transaction against production on 2026-09-04 - see
 * scripts/dev/probe-chip-continuity.sql and the changelog for the transcript.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChipContinuityTracker,
  isLeaveLocked,
  leaveLabel,
  stayRemainingMs,
} from './ChipContinuity.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';
import type { CashSessionRow } from '../services/supabase/cashSessions.js';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const SEATING = read('src/engine/ServerTableEngineSeating.ts');
const SETTLEMENT = read('src/engine/ServerTableEngineSettlement.ts');
const BASE = read('src/engine/ServerTableEngineBase.ts');
const ENGINE = read('src/engine/ServerTableEngine.ts');
const ROUTER = read('src/router.ts');
const SEATS = read('src/services/supabase/seats.ts');
const MIGRATION = read('../supabase/migrations/20260904120000_chip_continuity_slice_0.sql');

const row = (over: Partial<CashSessionRow> = {}): CashSessionRow => ({
  user_id: 'u1',
  baseline: 100,
  stack: 180,
  stay_remaining_ms: 600_000,
  stay_running: true,
  stay_last_tick_at: new Date(1_000_000).toISOString(),
  stay_clock_ms: 600_000,
  leave_locked: true,
  ...over,
});

describe('the stay clock the engine renders is the one the database keeps', () => {
  it('counts down from the last tick only while running (A0.2, A0.5)', () => {
    expect(stayRemainingMs(row(), 1_000_000 + 120_000)).toBe(480_000);
    expect(stayRemainingMs(row({ stay_running: false }), 1_000_000 + 120_000)).toBe(600_000);
    expect(stayRemainingMs(row(), 1_000_000 + 900_000)).toBe(0);
  });

  it('never resets to 10:00 on dip-and-recover: the remainder is whatever the row says (A0.3, A0.4)', () => {
    const recovered = row({
      stay_remaining_ms: 480_000,
      stay_running: true,
      stay_last_tick_at: new Date(5_000).toISOString(),
    });
    expect(stayRemainingMs(recovered, 5_000)).toBe(480_000);
  });

  it('locks iff ahead of the baseline AND time remains, running or not (I5, A0.5)', () => {
    expect(isLeaveLocked(row(), 180, 1_000_000)).toBe(true);
    expect(isLeaveLocked(row({ stay_running: false }), 180, 1_000_000)).toBe(true);
    expect(isLeaveLocked(row(), 90, 1_000_000)).toBe(false);
    expect(isLeaveLocked(row(), 100, 1_000_000)).toBe(false); // equal is not ahead
    expect(isLeaveLocked(row({ stay_remaining_ms: 0 }), 180, 1_000_000)).toBe(false);
  });

  it('the only copy while locked is "Leave Available In M:SS" (section 6.1)', () => {
    expect(leaveLabel(372_000)).toBe('Leave Available In 6:12');
    expect(leaveLabel(600_000)).toBe('Leave Available In 10:00');
    expect(leaveLabel(999)).toBe('Leave Available In 0:01');
    expect(leaveLabel(0)).toBe('Leave Available In 0:00');
  });
});

describe('the tracker reports transitions and renders answers', () => {
  const make = (evaluate = vi.fn(async () => [] as any[]), frozen = false, cash = true) =>
    new ChipContinuityTracker({
      tableId: 't1',
      isCash: () => cash,
      isFrozen: () => frozen,
      evaluate,
      report: vi.fn(),
    });

  it('sends everyone once after a restart, then only the players whose presence changed', async () => {
    const evaluate = vi.fn(async (_t: string, entries: any[]) =>
      entries.map((e) => row({ user_id: e.user_id }))
    );
    const t = make(evaluate);
    const players = [{ user_id: 'a' }, { user_id: 'b' }];
    await t.sweepPresence(players, () => true);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][1].map((e: any) => e.user_id)).toEqual(['a', 'b']);

    await t.sweepPresence(players, () => true);
    expect(evaluate).toHaveBeenCalledTimes(1); // nothing changed, nothing sent

    await t.sweepPresence(players, (id) => id !== 'b');
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[1][1]).toEqual([{ user_id: 'b', active: false }]);
  });

  it('never evaluates during the maintenance freeze (CLAUDE.md s13 rule 5)', async () => {
    const evaluate = vi.fn(async () => []);
    const t = make(evaluate, true);
    await t.evaluate([{ user_id: 'a', stack: 100, active: true }]);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('is inert on a tournament table', async () => {
    const evaluate = vi.fn(async () => []);
    const t = make(evaluate, false, false);
    await t.evaluate([{ user_id: 'a', stack: 100, active: true }]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(t.leaveLock('a', 100)).toEqual({ locked: false, remainingMs: 0 });
  });

  it('answers POST /leave from the mirror and forgets a seat that left', async () => {
    const evaluate = vi.fn(async () => [
      row({ user_id: 'a', stay_last_tick_at: new Date(Date.now()).toISOString() }),
    ]);
    const t = make(evaluate);
    await t.evaluate([{ user_id: 'a', stack: 180, active: true }]);
    expect(t.leaveLock('a', 180).locked).toBe(true);
    expect(t.leaveLock('a', 90).locked).toBe(false);
    expect(t.seatFields('a', 180).leave_locked).toBe(true);
    expect(t.seatFields('a', 180).session_baseline).toBe(100);
    t.forget('a');
    expect(t.leaveLock('a', 180).locked).toBe(false);
    expect(t.seatFields('a', 180)).toEqual({
      session_baseline: 0,
      stay_remaining_ms: 0,
      stay_running: false,
      leave_locked: false,
    });
  });

  it('trusts a refusal from the door over its own mirror', async () => {
    const evaluate = vi.fn(async () => [
      row({
        user_id: 'a',
        stay_remaining_ms: 1_000,
        stay_last_tick_at: new Date(Date.now()).toISOString(),
      }),
    ]);
    const t = make(evaluate);
    await t.evaluate([{ user_id: 'a', stack: 180, active: true }]);
    t.noteRefusal('a', 300_000);
    expect(t.leaveLock('a', 180).remainingMs).toBeGreaterThan(290_000);
  });
});

describe('the engine wiring (source pins - each one is a leak that shipped once already elsewhere)', () => {
  it('leaveTable refuses a locked cash player with the label and LEAVE_LOCKED (A0.2)', () => {
    const body = sliceMethod(SEATING, 'public async leaveTable(');
    expect(body).toContain('this.chipContinuity.leaveLock(userId, player.stack)');
    expect(body).toContain("code: 'LEAVE_LOCKED'");
    expect(body).toContain('leaveLabel(lock.remainingMs)');
    // The lock is checked AFTER the tournament branch returns: tournaments have no stay clock.
    expect(body.indexOf('if (this.isTournamentTable())')).toBeLessThan(
      body.indexOf('chipContinuity.leaveLock')
    );
    // A forced (kick) exit skips the mirror check and cashes out with leaveMode forced.
    expect(body).toContain('if (!opts.forced) {');
    expect(body).toContain("leaveMode: 'forced'");
  });

  it('the between-hands answer IS the database answer: awaited, seat_left only after the money, no fallback (A0.16)', () => {
    const body = sliceMethod(SEATING, 'public async leaveTable(');
    expect(body).toContain(
      'await atomicCashoutVoluntary(userId, this.tableId, player.seat_number)'
    );
    expect(blankNonCode(body)).not.toContain('markSeatAsLeft');
    const emit = body.indexOf('const emitSeatLeft = () =>');
    const voluntary = body.indexOf('await atomicCashoutVoluntary(');
    const emitAfter = body.indexOf('emitSeatLeft();', voluntary);
    expect(emit).toBeGreaterThan(-1);
    expect(emitAfter).toBeGreaterThan(voluntary);
    expect(body).toContain("if (res.code === 'LEAVE_LOCKED') {");
    expect(body.slice(body.indexOf("if (res.code === 'LEAVE_LOCKED') {"))).toContain(
      "code: 'LEAVE_LOCKED',"
    );
  });

  it('a leave refused at settlement is held by the clock and released by the heartbeat', () => {
    expect(sliceMethod(BASE, 'protected onLeaveRefusedAtSettlement(')).toContain(
      'this.leaveHeldByClock.add(userId)'
    );
    expect(sliceMethod(BASE, 'protected isContinuityActive(userId: string)')).toContain(
      'if (this.leaveHeldByClock.has(userId)) return true;'
    );
    const release = sliceMethod(BASE, 'protected async releaseLeavesHeldByClock()');
    expect(release).toContain('atomicCashoutVoluntary(userId, this.tableId, seated.seat_number)');
    expect(sliceMethod(BASE, 'protected scheduleHeartbeatCheck()')).toContain(
      'releaseLeavesHeldByClock()'
    );
    expect(sliceMethod(SEATING, 'public sitOut(')).toContain(
      'this.leaveHeldByClock.delete(userId)'
    );
  });

  it('the leave handler answers a lawful refusal with 200, and the admin kick is forced', () => {
    const LEAVE = read('src/handlers/leave.ts');
    expect(LEAVE).toContain("result.success || result.code === 'LEAVE_LOCKED' ? 200 : 400");
    expect(LEAVE).toContain('await engine.leaveTable(userId)');
    const ADMIN = read('src/handlers/admin.ts');
    expect(ADMIN).toContain('await engine.leaveTable(targetUserId, { forced: true })');
    const ROTATOR = read('src/services/HorseSessionRotator.ts');
    // Four doors, all the human one: the retirement drain, the session end,
    // (2026-09-05, no lone horse) the lone-table stand in standLoneHorses, and
    // (2026-09-06) the stand for an imminent tournament booking in
    // leaveCashForTournaments - a horse leaving cash the way a person with a
    // tournament in an hour does. Every one of them is engine.leaveTable.
    expect((ROTATOR.match(/await engine\.leaveTable\(/g) ?? []).length).toBe(4);
    expect(ROTATOR).toContain('private async leaveCashForTournaments(');
  });

  it('there is no partial cash-out: no withdrawChips, no /withdrawchips route (A0.1)', () => {
    expect(blankNonCode(SEATING)).not.toContain('withdrawChips');
    expect(blankNonCode(SEATING)).not.toContain('atomic_table_withdraw');
    expect(blankNonCode(ROUTER)).not.toContain('withdrawchips');
    expect(blankNonCode(ROUTER)).not.toContain('handleWithdrawchips');
  });

  it('settlement reports every stack to the database BEFORE any departure is judged', () => {
    const body = sliceMethod(SETTLEMENT, 'protected async postHandTasks(');
    expect(body).toMatch(
      /protected async postHandTasks\(\s*players: SeatedPlayer\[\],\s*persistenceGeneration: number\s*\)/
    );
    const step = body.indexOf("runStep('chip_continuity'");
    expect(step).toBeGreaterThan(body.indexOf("runStep('sync_stacks'"));
    expect(step).toBeGreaterThan(body.indexOf("runStep('pending_addons'"));
    expect(step).toBeGreaterThan(body.indexOf("runStep('horse_rebuys'"));
    expect(step).toBeLessThan(body.indexOf("runStep('horse_cashouts'"));
    expect(step).toBeLessThan(body.indexOf("runStep('leave_pending'"));
    expect(body).toContain('this.chipContinuity.evaluate(');
  });

  it('a horse at its profit target leaves through the same door a human does (CLAUDE.md 10.5)', () => {
    const body = sliceMethod(SETTLEMENT, 'protected async postHandTasks(');
    expect(body).toMatch(
      /protected async postHandTasks\(\s*players: SeatedPlayer\[\],\s*persistenceGeneration: number\s*\)/
    );
    const horse = body.slice(
      body.indexOf("runStep('horse_cashouts'"),
      body.indexOf("runStep('deferred_sitouts'")
    );
    expect(horse).toContain(
      'atomicCashoutVoluntary(horse.user_id, this.tableId, horse.seat_number)'
    );
    expect(blankNonCode(horse)).not.toContain('markSeatAsLeft');
    expect(horse).toContain("exit.code === 'LEAVE_LOCKED'");
  });

  it('a leave_pending seat is cashed out through the guarded door and a refusal keeps the seat', () => {
    const body = sliceMethod(SEATS, 'export async function processLeavePending(');
    expect(body).toContain("forcedUserIds?.has(seat.user_id) ? 'forced' : 'voluntary'");
    expect(body).toContain('leave_pending: false');
    expect(body).toContain('onLocked?.(');
  });

  it('sit-out and sit-in report to the clock; presence is swept from the heartbeat tick', () => {
    const sitOut = sliceMethod(SEATING, 'public sitOut(');
    expect(sitOut).toContain('this.chipContinuity');
    const hb = sliceMethod(BASE, 'protected scheduleHeartbeatCheck()');
    expect(hb).toContain('sweepPresence(');
    expect(hb.indexOf('checkStaleHeartbeats')).toBeLessThan(hb.indexOf('sweepPresence('));
    const active = sliceMethod(BASE, 'protected isContinuityActive(userId: string)');
    for (const gate of ['pendingSitOut.has', 'isSittingOut', 'isConnected', 'isAway']) {
      expect(active).toContain(gate);
    }
  });

  it('all three state payloads carry the same stay-clock fields (the two-out-of-three bug)', () => {
    // Two hand-state builders judge on the roster stack (a bet is not a loss
    // yet); the idle builder's roster IS the hand roster.
    const rosterSpreads =
      ENGINE.match(
        /\.\.\.this\.chipContinuity\.seatFields\(p\.user_id, this\.continuityStack\(p\.user_id, p\.stack\)\)/g
      ) ?? [];
    const idleSpreads =
      ENGINE.match(/\.\.\.this\.chipContinuity\.seatFields\(p\.user_id, p\.stack\)/g) ?? [];
    expect(rosterSpreads.length).toBe(2);
    expect(idleSpreads.length).toBe(1);
    for (const sig of [
      'public getTableState(',
      'protected broadcastCurrentState()',
      'protected publishIdleState()',
    ]) {
      expect(sliceMethod(ENGINE, sig)).toContain('chipContinuity.seatFields(p.user_id,');
    }
  });
});

describe('the migration is the one this engine was written against', () => {
  it('opens the session with the seat and applies the one floor at buy-in (I7, I8)', () => {
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS public.cash_player_session');
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS public.cash_rejoin_constraints');
    expect(MIGRATION).toContain(
      'PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);'
    );
    expect(MIGRATION).toContain('BUYIN_BELOW_FLOOR');
    // The key: club + variant + sb + bb. Never the table, never the template.
    const floor = MIGRATION.slice(
      MIGRATION.indexOf('FUNCTION public.fn_cash_rejoin_floor'),
      MIGRATION.indexOf('FUNCTION public.fn_cash_effective_buyin')
    );
    for (const k of [
      'c.club_id  = t.club_id',
      'c.variant  = t.game_variant',
      'c.sb       = t.small_blind',
      'c.bb       = t.big_blind',
    ]) {
      expect(floor).toContain(k);
    }
    expect(floor).not.toContain('source_table_id =');
  });

  it('the cash-out door enforces the clock for browsers always and for the engine when voluntary', () => {
    expect(MIGRATION).toContain('p_leave_mode text DEFAULT NULL::text');
    expect(MIGRATION).toContain(
      "AND (NOT public.fn_caller_is_engine() OR p_leave_mode = 'voluntary')"
    );
    expect(MIGRATION).toContain("RAISE EXCEPTION 'LEAVE_LOCKED:%'");
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.atomic_seat_cashout_locked(uuid, uuid, integer);'
    );
  });

  it('going south is dropped, the baseline follows applied chips, and the thaw gives the clock its minutes back', () => {
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.atomic_table_withdraw(uuid, uuid, numeric, boolean, text);'
    );
    expect(MIGRATION).toContain('BUYIN_ABOVE_MAX');
    expect(
      (MIGRATION.match(/fn_cash_session_add_baseline\(/g) ?? []).length
    ).toBeGreaterThanOrEqual(4);
    expect(MIGRATION).toContain("'cash_stay_last_tick_at'");
    expect(MIGRATION).toContain("'cash_rejoin_expires_at'");
  });

  it('is horse-blind: nothing in it reads is_horse', () => {
    expect(MIGRATION).not.toContain('is_horse');
  });
});
