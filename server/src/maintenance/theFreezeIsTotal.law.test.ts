/**
 * LAW: THE FREEZE IS TOTAL (Dan, 2026-09-01 / 2026-09-03).
 *
 * "NO BUY INS, NO CHIP MOVEMENTS ... EVERYTHING JUST FREEZES." And, on the
 * 23:55 restart that parked every table yet still seated 228 horses:
 * "THIS SOUNDS LIKE YOU DIDN'T TRULY FREEZE ALL TRANSACTIONS FROM BEING ABLE
 * TO HAPPEN, AND NEED TO FIX THAT!"
 *
 * Every pin below is a path that seated or registered a player during a
 * break on 2026-09-02, or the ordering bug that let it. Source-law pins,
 * because these are call sites in 4,000-line files that no unit test drives
 * end to end; each one slices the STRUCTURE the rule is about (a method body,
 * a loop body) via the shared sourceWindow helpers, never a byte count.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod, sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

/** Index of `needle` in `hay`, or a readable failure. */
function at(hay: string, needle: string, label: string): number {
  const i = hay.indexOf(needle);
  expect(i, `${label}: expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return i;
}

/** Every occurrence index of `needle` in `hay`. */
function all(hay: string, needle: string): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/** The body of the `for (...) {` loop whose header starts at `index`. */
const loopBodyAt = (src: string, index: number, header: string): string =>
  sliceMethod(src.slice(index), header);

const GATE_RETURN = /isMaintenanceFrozen\(\)\)\s*return;/;

/**
 * Offset of the first I/O in a method body: the first `await` that is not the
 * `withBoardTick` wrapper the launchers use to serialise themselves (the gate
 * lives inside that wrapper, on purpose - the tick must still be recorded).
 */
const firstIo = (body: string): number => {
  const m = /await (?!this\.withBoardTick\()/.exec(body);
  return m ? m.index : Number.MAX_SAFE_INTEGER;
};

describe('the break is adopted before anything that can seat a player (GameServer boot order)', () => {
  const gs = read('GameServer.ts');
  const startBody = sliceMethod(gs, 'async start(): Promise<void> {');

  it('maintenanceBreak.start() is awaited before cash-table discovery begins', () => {
    const brk = at(startBody, 'await this.maintenanceBreak.start();', 'break adoption');
    const disc = at(startBody, 'this.discoverCashTables()', 'cash discovery');
    expect(
      brk,
      'the break must be adopted (and the freeze flag set) before discovery'
    ).toBeLessThan(disc);
  });

  it('maintenanceBreak.start() is awaited before the horse fleet, the launcher and the scheduler start', () => {
    const brk = at(startBody, 'await this.maintenanceBreak.start();', 'break adoption');
    for (const svc of [
      'void this.horseFleet',
      'this.tournamentRecurring.start()',
      'this.scheduledTournaments.start()',
    ]) {
      expect(brk, `${svc} starts before the break is adopted`).toBeLessThan(
        at(startBody, svc, svc)
      );
    }
  });
});

describe('every tournament start and top-up decision is gated on the freeze (GameServer)', () => {
  const gs = read('GameServer.ts');

  it('the registering-tournament discovery loop checks the freeze at its top', () => {
    const header = 'for (const tournament of registering || []) {';
    const body = loopBodyAt(gs, at(gs, header, 'discovery loop'), header);
    // The gate is the first statement after the already-running skip.
    const gate = at(body, 'if (isMaintenanceFrozen()) break;', 'freeze gate');
    const firstWrite = at(body, 'topUpWithHorses(', 'top-up');
    expect(gate).toBeLessThan(firstWrite);
  });

  it('both seat-first start loops check the freeze at their top', () => {
    const header = 'for (const t of seatFirstRows) {';
    const loops = all(gs, header);
    expect(loops.length, 'the discovery pass and the fast lane').toBe(2);
    for (const i of loops) {
      const body = loopBodyAt(gs, i, header);
      const gate = at(body, 'if (isMaintenanceFrozen()) break;', `freeze gate in loop at ${i}`);
      const start = at(body, 'new TournamentManager(', `start in loop at ${i}`);
      expect(gate).toBeLessThan(start);
    }
  });
});

describe('every horse buy-in RPC call is gated on the freeze', () => {
  it('TournamentRecurringService: each seat / register RPC sits in a loop body that checks the freeze first', () => {
    const src = read('services/TournamentRecurringService.ts');
    for (const rpc of ['fn_seat_horse_in_seat_first_game', 'fn_register_horse_for_tournament']) {
      const sites = all(src, `'${rpc}'`).filter((i) => /rpc\(\s*$/.test(src.slice(i - 40, i)));
      expect(sites.length, `${rpc} call sites`).toBeGreaterThan(0);
      sites.forEach((i, k) => {
        // The innermost block open at the string literal is the loop body:
        // the rpc(...) argument object opens AFTER the literal.
        const block = sliceEnclosingBlock(src, `'${rpc}'`, k, 1);
        const gate = block.search(/isMaintenanceFrozen\(\)\)\s*(continue|break);/);
        expect(gate, `${rpc} at ${i}: the loop body has no freeze check`).toBeGreaterThan(-1);
        expect(gate, `${rpc} at ${i}: the freeze check comes after the RPC`).toBeLessThan(
          block.indexOf(rpc)
        );
      });
    }
  });

  it('TournamentRecurringService: every launcher and the top-up gate themselves, not only their interval', () => {
    const src = read('services/TournamentRecurringService.ts');
    for (const m of [
      'private async checkAndLaunchTournaments(): Promise<void> {',
      'private async checkAndLaunchSNGs(): Promise<void> {',
      'private async checkAndLaunchSpins(): Promise<void> {',
      'private async checkAndLaunchXMTTs(): Promise<void> {',
      // Added 2026-09-04 with the Free Buy board. It does not seat anyone
      // itself, but the pre-start ramp registers horses into whatever it
      // publishes within 45 seconds, and start() runs it once immediately.
      'private async checkAndCreateFreeBuys(): Promise<void> {',
    ]) {
      const body = sliceMethod(src, m);
      const gate = body.search(GATE_RETURN);
      expect(gate, `${m} does not gate itself`).toBeGreaterThan(-1);
      expect(gate, `${m}: the gate comes after the first I/O`).toBeLessThan(firstIo(body));
    }
    const top = sliceMethod(src, 'async topUpWithHorses(');
    const gate = top.search(/isMaintenanceFrozen\(\)\)\s*return 0;/);
    expect(gate, 'topUpWithHorses does not gate itself').toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstIo(top));
  });

  it('HorseFleetManager: the seeding cycle and the seat itself are gated', () => {
    const src = read('services/HorseFleetManager.ts');
    const seed = sliceMethod(src, 'private async seedAllTables(): Promise<void> {');
    const seedGate = seed.search(GATE_RETURN);
    expect(seedGate, 'seedAllTables does not gate itself').toBeGreaterThan(-1);
    expect(seedGate).toBeLessThan(firstIo(seed));

    const seat = sliceMethod(src, 'private async seatHorse(');
    const seatGate = seat.search(/isMaintenanceFrozen\(\)\)\s*return false;/);
    expect(seatGate, 'seatHorse does not gate itself').toBeGreaterThan(-1);
    expect(seatGate).toBeLessThan(at(seat, "rpc('atomic_table_buyin'", 'atomic_table_buyin'));
  });

  it('StableHandExecutor: the yield cycle gates itself, and again inside the loop', () => {
    // Dan 2026-09-01: "HORSES SHOULD NOT STAND UP OR ROTATE." A yield stands a
    // horse up, so it is a seat movement and the break stops it. The human
    // keeps their place - the wait clock is the waitlist's own created_at,
    // which a break cannot move - and the yield fires on the first cycle after
    // the thaw.
    const src = read('services/StableHandExecutor.ts');
    const cycle = sliceMethod(src, 'async cycle(): Promise<number> {');
    const gate = cycle.search(/isMaintenanceFrozen\(\)\)\s*return 0;/);
    expect(gate, 'StableHandExecutor.cycle does not gate itself').toBeGreaterThan(-1);
    expect(gate, 'the gate comes after the first I/O').toBeLessThan(firstIo(cycle));
    /* And re-checked PER SEAT: a break can begin between the snapshot and the
       last order in it. The pin moved here on 2026-09-04 when the wind-down
       arrived and both order types were routed through one `stand` helper -
       every path to leaveTable now passes this single gate, which is why the
       loop-level check it replaces is gone rather than missing. */
    const stand = sliceMethod(
      src,
      'private async stand(order: StandOrder, nowMs: number, why: string): Promise<boolean> {'
    );
    const seatGate = stand.search(/isMaintenanceFrozen\(\)\)\s*return false;/);
    /* And the stand is AWAITED. leaveTable became async on 2026-09-04 with
       chip continuity; an un-awaited call would return a pending promise,
       which is truthy, and every refused stand would have been counted as a
       success. */
    expect(src, 'the stand must be awaited').toMatch(/await this\.stand\(/);
    expect(seatGate, 'stand() does not re-check the freeze').toBeGreaterThan(-1);
    expect(seatGate).toBeLessThan(at(stand, 'engine.leaveTable(', 'the stand itself'));
    // and there is exactly ONE door to leaveTable, so the gate cannot be
    // bypassed. Comments stripped: the header names the call on purpose.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code.split('engine.leaveTable(').length - 1, 'more than one leaveTable call site').toBe(
      1
    );
  });

  it('ScheduledTournamentService: the poll gates itself', () => {
    const src = read('services/ScheduledTournamentService.ts');
    const poll = sliceMethod(src, 'private async poll(): Promise<void> {');
    const gate = poll.search(GATE_RETURN);
    expect(gate, 'poll does not gate itself').toBeGreaterThan(-1);
    expect(gate).toBeLessThan(poll.indexOf('this.polling = true;'));
  });
});

describe('the break is idle before the first table is woken (MaintenanceBreak.end)', () => {
  it("phase = 'idle' precedes resumeEveryEngine() inside end()", () => {
    const src = read('maintenance/MaintenanceBreak.ts');
    const end = sliceMethod(src, 'async end(): Promise<void> {');
    const idle = at(end, "this.phase = 'idle';", 'phase idle');
    const resume = at(end, 'this.resumeEveryEngine()', 'resume');
    expect(
      idle,
      'a staggered batch checks phase === idle; it must be idle before any batch can fire'
    ).toBeLessThan(resume);
  });
});

describe('the database backstop exists and exempts no role', () => {
  const dir = resolve(SRC, '../../supabase/migrations');
  const file = readdirSync(dir).find((f) => f.includes('the_freeze_is_total'));

  it('the migration is present', () => {
    expect(file, 'supabase/migrations/*the_freeze_is_total*.sql').toBeTruthy();
  });

  it('guards all three doors and never mentions service_role inside the guard', () => {
    const sql = readFileSync(resolve(dir, file!), 'utf8');
    const fnStart = at(
      sql,
      'CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()',
      'guard fn'
    );
    const fnEnd = at(
      sql,
      'COMMENT ON FUNCTION public.fn_refuse_new_entries_while_frozen()',
      'guard comment'
    );
    const fn = sql.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/service_role/);
    expect(fn).toMatch(/fn_freeze_bypass_active\(\)/);
    expect(fn).toMatch(/fn_platform_frozen\(\)/);
    expect(sql).toMatch(/BEFORE INSERT ON public\.table_seats/);
    expect(sql).toMatch(/BEFORE INSERT ON public\.tournament_players/);
    expect(sql).toMatch(/BEFORE UPDATE OF status ON public\.tournaments/);
  });

  it('the seven-door guard still exempts the engine (settlement of a hand in flight must never be refused)', () => {
    // The backstop is deliberately narrow: new seats, registrations, launches.
    // Stack UPDATEs from the last hand's settlement stay allowed for the
    // engine. If someone widens the original guard, this is the line to read.
    const orig = readdirSync(dir).find((f) => f.includes('the_platform_freezes_at_the_tables'));
    expect(orig).toBeTruthy();
    expect(readFileSync(resolve(dir, orig!), 'utf8')).toMatch(/'service_role'/);
  });
});
