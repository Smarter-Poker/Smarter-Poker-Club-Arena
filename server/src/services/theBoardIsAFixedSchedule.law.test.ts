/**
 * THE BOARD IS A FIXED SCHEDULE (Dan, 2026-10-15, BINDING).
 *
 * Dan, verbatim: "TOURNAMENTS CAN NEVER FAIL, AND MUST ALWAYS RUN AND SPAWN,
 * INSTEAD OF RANDOMLY SPAWNING THEM, PUT THEM ON A HARD CODED SCHEDULE", then
 * "THESE SAME CORRECTIONS NEED TO BE MADE INSIDE OF THE DIAMOND ARENA AS WELL."
 *
 * On 2026-10-13 the engine's board timers stopped for ~34 hours: 2 of 5 Free
 * Buys ran on the 13th, 1 of 5 on the 14th, and ~90 lobby MTTs never existed,
 * while every tournament_schedules row kept spawning on time. The Midway
 * Union's Free Buys, lobby MTTs and union MTTs are now schedule rows at fixed
 * Chicago times for the Midway Union AND the Diamond Arena, built by the same
 * builders the timers used, and the timers stand down for them.
 *
 * These pin that: every name the migration schedules resolves to a real row,
 * the row is the event the timer used to make, the timers no longer publish a
 * second copy, and a Diamond Arena occurrence is priced at its real total.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedBoardRow } from './ScheduledTournamentService.js';
import {
  MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE,
  fixedBoardTemplate,
  fixedBoardTemplateNames,
  fixedFreeBuyRow,
  recurringMttRow,
} from './TournamentRecurringService.js';
import { FREE_BUY_SLOTS, freeBuyBoardName } from './FreeBuy.js';
import { diamondSpawnConfig } from './diamondScheduledSpawn.js';

const MIDWAY = 'fade0000-0000-0000-0000-000000000001';
const ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';
const START = new Date('2026-10-17T01:00:00.000Z'); // 20:00 Chicago, 2026-10-16

const migrationsDir = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const migrationFile = readdirSync(migrationsDir).find((f) =>
  f.includes('the_midway_board_and_the_diamond_arena_board_are_a_fixed_sch')
);
const migration = migrationFile ? readFileSync(join(migrationsDir, migrationFile), 'utf8') : '';
const scheduledNames = [...migration.matchAll(/^\s+\('([^']+)', ARRAY\[([^\]]*)\]::text\[\], (\d+)\)/gm)];

const midwaySchedule = (name: string) => ({
  id: '11111111-1111-1111-1111-111111111111',
  club_id: MIDWAY,
  union_id: MIDWAY,
  name,
});
const arenaSchedule = (name: string) => ({
  id: '22222222-2222-2222-2222-222222222222',
  club_id: ARENA,
  union_id: null,
  name,
});

describe('the migration schedules the whole board', () => {
  it('exists and carries 25 templates, 53 fixed starts a day', () => {
    expect(migrationFile).toBeTruthy();
    expect(scheduledNames.length).toBe(25);
    const starts = scheduledNames.reduce((n, m) => n + m[2].split(',').length, 0);
    expect(starts).toBe(53);
  });

  it('schedules all five Free Buys at their Chicago hours', () => {
    for (const slot of FREE_BUY_SLOTS) {
      const row = scheduledNames.find((m) => m[1] === freeBuyBoardName(slot));
      expect(row, freeBuyBoardName(slot)).toBeTruthy();
      expect(row![2]).toBe(`'${String(slot.chicagoHour).padStart(2, '0')}:00'`);
    }
  });

  it('schedules every lobby and union template the timers used to launch', () => {
    const names = new Set(scheduledNames.map((m) => m[1]));
    for (const name of fixedBoardTemplateNames()) expect(names.has(name), name).toBe(true);
  });

  it('is on a wall clock that survives daylight saving, for both clubs', () => {
    expect(migration).toContain("'America/Chicago'");
    expect(migration).toContain(MIDWAY);
    expect(migration).toContain(ARENA);
    // A type the previous engine refuses, so no old binary ever builds one.
    expect(migration).toContain("'type', 'fixed_board'");
  });
});

describe('every scheduled name builds the event the timer used to make', () => {
  it('resolves each name to a row at the scheduled time, for both clubs', () => {
    for (const m of scheduledNames) {
      const name = m[1];
      for (const sched of [midwaySchedule(name), arenaSchedule(name)]) {
        const row = fixedBoardRow(sched, { type: 'fixed_board', fixedBoard: name }, START);
        expect(row, name).not.toBeNull();
        expect(row!.name).toBe(name);
        expect(row!.start_time).toBe(START.toISOString());
        expect(row!.schedule_id).toBe(sched.id);
        expect(row!.club_id).toBe(sched.club_id);
        expect(row!.union_id).toBe(sched.union_id);
      }
    }
  });

  it('a Free Buy is the Free Buy board row, byte for byte', () => {
    const name = 'Prime Time Free Buy (NLH)';
    const sched = midwaySchedule(name);
    const row = fixedBoardRow(sched, { fixedBoard: name }, START)!;
    const board = fixedFreeBuyRow(name, START, {
      clubId: MIDWAY,
      unionId: MIDWAY,
      label: name,
    })!;
    expect(row).toEqual({ ...board, schedule_id: sched.id });
    expect(row.free_buy).toBe(true);
    expect(row.buy_in_amount).toBe(0);
    expect(row.guaranteed_prize).toBe(500);
    expect(row.starting_chips).toBe(3000);
  });

  it('a lobby MTT is the timer row; a union MTT keeps its union flag', () => {
    const lobby = fixedBoardRow(midwaySchedule('Night Owl Special (NLH)'), { fixedBoard: 'Night Owl Special (NLH)' }, START)!;
    const lobbyTemplate = fixedBoardTemplate('Night Owl Special (NLH)')!;
    expect(lobby).toEqual({
      ...recurringMttRow(lobbyTemplate.config, START, { clubId: MIDWAY, unionId: MIDWAY, xmtt: false }),
      schedule_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(lobby.is_xmtt).toBeUndefined();
    expect(lobby.late_reg_levels).toBe(8);

    const union = fixedBoardRow(midwaySchedule('Union Grand Championship (NLH)'), { fixedBoard: 'Union Grand Championship (NLH)' }, START)!;
    expect(union.is_xmtt).toBe(true);
    expect(union.late_reg_levels).toBe(10);
  });

  it('an unknown template is refused, never guessed', () => {
    expect(fixedBoardRow(midwaySchedule('x'), { fixedBoard: 'No Such Event (NLH)' }, START)).toBeNull();
    expect(fixedBoardRow(midwaySchedule('x'), { fixedBoard: '' }, START)).toBeNull();
  });
});

describe('the timers stand down for what the schedule owns', () => {
  const src = readFileSync(join(__dirname, 'TournamentRecurringService.ts'), 'utf8');

  it('the switch is on', () => {
    expect(MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE).toBe(true);
  });

  it('the lobby board, the union board and the Free Buy board each check it', () => {
    expect(src).toMatch(/if \(MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE\) return;/);
    expect(src).toMatch(/MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE && union\.id === MIDWAY_UNION_ID/);
    expect(src).toMatch(/MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE && host\.clubId === MIDWAY_UNION_ID/);
  });
});

describe('the Diamond Arena prices a fixed-board occurrence at its real total', () => {
  it('a paid template is not mistaken for a freeroll', () => {
    const name = 'Night Owl Special (NLH)';
    const row = fixedBoardRow(arenaSchedule(name), { fixedBoard: name }, START)!;
    const total = Number(row.buy_in_amount) + Number(row.buy_in_fee);
    expect(total).toBeGreaterThan(0);
    const mapped = diamondSpawnConfig(row, { type: 'fixed_board', fixedBoard: name }, START);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) expect(mapped.config.buyIn).toBe(total);
  });

  it('a Free Buy stays free', () => {
    const name = 'Midnight Free Buy (NLH)';
    const row = fixedBoardRow(arenaSchedule(name), { fixedBoard: name }, START)!;
    const mapped = diamondSpawnConfig(row, { fixedBoard: name }, START);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.config.buyIn).toBe(0);
      expect(mapped.config.freeBuy).toBe(true);
    }
  });
});
