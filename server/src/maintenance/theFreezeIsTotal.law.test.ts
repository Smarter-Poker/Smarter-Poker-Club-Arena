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
 * end to end; each one reads the file and asserts the gate is where the
 * write is.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

/** Index of `needle` in `hay`, or throws with a readable message. */
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

/** The gate must appear in the `window` characters before `index`. */
function gatedBefore(hay: string, index: number, window: number, label: string) {
  const before = hay.slice(Math.max(0, index - window), index);
  expect(
    before,
    `${label} is not gated on isMaintenanceFrozen() within ${window} chars before it`
  ).toMatch(/isMaintenanceFrozen\(\)/);
}

describe('the break is adopted before anything that can seat a player (GameServer boot order)', () => {
  const gs = read('GameServer.ts');
  const startBody = gs.slice(at(gs, 'async start(): Promise<void> {', 'GameServer.start'));

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
    const i = at(gs, 'for (const tournament of registering || []) {', 'discovery loop');
    const body = gs.slice(i, i + 700);
    expect(body).toMatch(/isMaintenanceFrozen\(\)\)\s*break;/);
  });

  it('both seat-first start loops check the freeze at their top', () => {
    const loops = all(gs, 'for (const t of seatFirstRows) {');
    expect(loops.length, 'the discovery pass and the fast lane').toBe(2);
    for (const i of loops) {
      expect(gs.slice(i, i + 400)).toMatch(/isMaintenanceFrozen\(\)\)\s*break;/);
    }
  });
});

describe('every horse buy-in RPC call is gated on the freeze', () => {
  it('TournamentRecurringService: each seat / register RPC has a gate right before it', () => {
    const src = read('services/TournamentRecurringService.ts');
    for (const rpc of [
      "'fn_seat_horse_in_seat_first_game'",
      "'fn_register_horse_for_tournament'",
    ]) {
      const sites = all(src, `rpc(\n          ${rpc}`).concat(all(src, `rpc(\n            ${rpc}`));
      expect(sites.length, `${rpc} call sites`).toBeGreaterThan(0);
      for (const i of sites) gatedBefore(src, i, 450, `${rpc} at ${i}`);
    }
  });

  it('TournamentRecurringService: every launcher and the top-up gate themselves, not only their interval', () => {
    const src = read('services/TournamentRecurringService.ts');
    for (const m of [
      'private async checkAndLaunchTournaments(): Promise<void> {',
      'private async checkAndLaunchSNGs(): Promise<void> {',
      'private async checkAndLaunchSpins(): Promise<void> {',
      'private async checkAndLaunchXMTTs(): Promise<void> {',
    ]) {
      const i = at(src, m, m);
      expect(src.slice(i, i + 700), `${m} does not gate itself`).toMatch(
        /isMaintenanceFrozen\(\)\)\s*return;/
      );
    }
    const t = at(src, 'async topUpWithHorses(', 'topUpWithHorses');
    expect(src.slice(t, t + 500)).toMatch(/isMaintenanceFrozen\(\)\)\s*return 0;/);
  });

  it('HorseFleetManager: the seeding cycle and the seat itself are gated', () => {
    const src = read('services/HorseFleetManager.ts');
    const seed = at(src, 'private async seedAllTables(): Promise<void> {', 'seedAllTables');
    expect(src.slice(seed, seed + 400)).toMatch(/isMaintenanceFrozen\(\)\)\s*return;/);
    const buy = at(src, "rpc('atomic_table_buyin'", 'atomic_table_buyin');
    gatedBefore(src, buy, 1800, 'atomic_table_buyin');
  });

  it('ScheduledTournamentService: the poll gates itself', () => {
    const src = read('services/ScheduledTournamentService.ts');
    const p = at(src, 'private async poll(): Promise<void> {', 'poll');
    expect(src.slice(p, p + 400)).toMatch(/isMaintenanceFrozen\(\)\)\s*return;/);
  });
});

describe('the break is idle before the first table is woken (MaintenanceBreak.end)', () => {
  it("phase = 'idle' precedes resumeEveryEngine() inside end()", () => {
    const src = read('maintenance/MaintenanceBreak.ts');
    const end = src.slice(at(src, 'async end(): Promise<void> {', 'end()'));
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
    const fn = sql.slice(
      at(sql, 'CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()', 'guard fn'),
      at(sql, 'COMMENT ON FUNCTION public.fn_refuse_new_entries_while_frozen()', 'guard comment')
    );
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
    expect(existsSync(resolve(dir, orig!))).toBe(true);
  });
});
