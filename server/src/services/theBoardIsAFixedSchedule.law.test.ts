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
import {
  fixedBoardRow,
  previousDayKeys,
  resolveTimeChange,
  scheduleTimeChange,
} from './ScheduledTournamentService.js';
import {
  MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE,
  fixedBoardTemplate,
  fixedBoardTemplateNames,
  fixedFreeBuyRow,
  recurringMttRow,
} from './TournamentRecurringService.js';
import { FREE_BUY_SLOTS, freeBuyBoardName } from './FreeBuy.js';
import { DIAMOND_FREEROLL_REBUY_DIAMONDS, diamondSpawnConfig } from './diamondScheduledSpawn.js';
import {
  FIXED_BOARD,
  FIXED_BOARD_CLUBS,
  FIXED_BOARD_RESYNC_MS,
  FIXED_BOARD_TIMES_EFFECTIVE_FROM,
  WEEKLY_EVENT_SLOTS,
  isFixedBoardConfig,
  fixedBoardRowFor,
  planFixedBoardSync,
  type ExistingFixedBoardRow,
} from '../config/fixedBoard.js';

const MIDWAY = 'fade0000-0000-0000-0000-000000000001';
const ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';
const START = new Date('2026-10-17T01:00:00.000Z'); // 20:00 Chicago, 2026-10-16

const migrationsDir = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const migrationFile = readdirSync(migrationsDir).find((f) =>
  f.includes('the_midway_board_and_the_diamond_arena_board_are_a_fixed_sch')
);
const migration = migrationFile ? readFileSync(join(migrationsDir, migrationFile), 'utf8') : '';
const scheduledNames = [
  ...migration.matchAll(/^\s+\('([^']+)', ARRAY\[([^\]]*)\]::text\[\], (\d+)\)/gm),
];

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
    // Dan 2026-10-16: "ALL REBUY ADD ON'S FOR MIDWAY UNION ARE 1 CHIP".
    expect(row.rebuy_cost).toBe(1);
    expect(row.addon_cost).toBe(1);
    expect(row.starting_chips).toBe(3000);
  });

  it('a lobby MTT is the timer row; a union MTT keeps its union flag', () => {
    const lobby = fixedBoardRow(
      midwaySchedule('Night Owl Special (NLH)'),
      { fixedBoard: 'Night Owl Special (NLH)' },
      START
    )!;
    const lobbyTemplate = fixedBoardTemplate('Night Owl Special (NLH)')!;
    expect(lobby).toEqual({
      ...recurringMttRow(lobbyTemplate.config, START, {
        clubId: MIDWAY,
        unionId: MIDWAY,
        xmtt: false,
      }),
      schedule_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(lobby.is_xmtt).toBeUndefined();
    expect(lobby.late_reg_levels).toBe(8);

    const union = fixedBoardRow(
      midwaySchedule('Union Grand Championship (NLH)'),
      { fixedBoard: 'Union Grand Championship (NLH)' },
      START
    )!;
    expect(union.is_xmtt).toBe(true);
    expect(union.late_reg_levels).toBe(10);
  });

  it('an unknown template is refused, never guessed', () => {
    expect(
      fixedBoardRow(midwaySchedule('x'), { fixedBoard: 'No Such Event (NLH)' }, START)
    ).toBeNull();
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
    expect(src).toMatch(
      /MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE && host\.clubId === MIDWAY_UNION_ID/
    );
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

  it('the 8 PM Prime Time Free Buy is on the arena board: rebuy and add-on at 100 Diamonds', () => {
    const name = 'Prime Time Free Buy (NLH)';
    const row = fixedBoardRow(arenaSchedule(name), { fixedBoard: name }, START)!;
    const mapped = diamondSpawnConfig(row, { fixedBoard: name }, START);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.config.buyIn).toBe(0);
      expect(mapped.config.rebuyCost).toBe(100);
      expect(mapped.config.addonCost).toBe(100);
      expect(DIAMOND_FREEROLL_REBUY_DIAMONDS).toBe(100);
    }
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

describe('the board is hard coded in the engine, so it can never run ahead of its code', () => {
  it('carries 25 events and 53 starts a day, for both clubs', () => {
    expect(FIXED_BOARD.length).toBe(25);
    expect(FIXED_BOARD.reduce((n, e) => n + e.times.length, 0)).toBe(53);
    expect(FIXED_BOARD_CLUBS.map((c) => c.clubId)).toEqual([MIDWAY, ARENA]);
  });

  it('keeps every event the migration first installed, with its old times as its previous times', () => {
    const fromMigration = scheduledNames.map((m) => [
      m[1],
      m[2].split(',').map((t) => t.replace(/'/g, '')),
      Number(m[3]),
    ]);
    expect(FIXED_BOARD.map((e) => [e.name, [...(e.previousTimes ?? e.times)], e.horses])).toEqual(
      // The board was regrouped by time of day on 2026-10-16; same events.
      [...fromMigration].sort(
        (a, b) =>
          FIXED_BOARD.findIndex((e) => e.name === a[0]) -
          FIXED_BOARD.findIndex((e) => e.name === b[0])
      )
    );
  });

  it('every hard-coded event builds a row in both clubs: no unknown template can ship', () => {
    for (const club of FIXED_BOARD_CLUBS) {
      for (const event of FIXED_BOARD) {
        const sched = { id: 'x', club_id: club.clubId, union_id: club.unionId, name: event.name };
        expect(
          fixedBoardRow(sched, fixedBoardRowFor(club, event).config, START),
          event.name
        ).not.toBeNull();
      }
    }
  });

  const asExisting = (
    id: string,
    club: (typeof FIXED_BOARD_CLUBS)[number],
    e: (typeof FIXED_BOARD)[number]
  ): ExistingFixedBoardRow => {
    const r = fixedBoardRowFor(club, e);
    return {
      id,
      club_id: r.club_id,
      active: true,
      days_of_week: r.days_of_week,
      start_times_utc: r.start_times_utc,
      time_zone: r.time_zone,
      config: r.config,
    };
  };

  it('an empty table gets all 50 rows', () => {
    const plan = planFixedBoardSync([]);
    expect(plan.inserts).toHaveLength(50);
    expect(plan.updates).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it('a table that already holds the board is left alone', () => {
    const existing = FIXED_BOARD_CLUBS.flatMap((c, ci) =>
      FIXED_BOARD.map((e, ei) => asExisting(`${ci}-${ei}`, c, e))
    );
    expect(planFixedBoardSync(existing)).toEqual({ inserts: [], updates: [], deactivate: [] });
  });

  it('a row whose times differ from the code is rewritten to the code', () => {
    const existing = FIXED_BOARD_CLUBS.flatMap((c, ci) =>
      FIXED_BOARD.map((e, ei) => asExisting(`${ci}-${ei}`, c, e))
    );
    existing[3] = { ...existing[3], start_times_utc: ['09:15'] };
    const plan = planFixedBoardSync(existing);
    expect(plan.updates.map((u) => u.id)).toEqual(['0-3']);
    expect(plan.updates[0].row.start_times_utc).toEqual([...FIXED_BOARD[3].times]);
  });

  it('a fixed-board row the code no longer lists is retired, and a duplicate too', () => {
    const existing = FIXED_BOARD_CLUBS.flatMap((c, ci) =>
      FIXED_BOARD.map((e, ei) => asExisting(`${ci}-${ei}`, c, e))
    );
    existing.push({ ...existing[0], id: 'dup' });
    existing.push({
      ...existing[1],
      id: 'gone',
      config: { type: 'fixed_board', fixedBoard: 'Retired Event (NLH)' },
    });
    expect(planFixedBoardSync(existing).deactivate.sort()).toEqual(['dup', 'gone']);
  });

  it('the scheduler writes the board before it reads a schedule', () => {
    const src = readFileSync(join(__dirname, 'ScheduledTournamentService.ts'), 'utf8');
    const poll = src.slice(src.indexOf('private async poll('));
    expect(poll.indexOf('this.syncFixedBoard()')).toBeGreaterThan(-1);
    expect(poll.indexOf('this.syncFixedBoard()')).toBeLessThan(
      poll.indexOf(".from('tournament_schedules')")
    );
  });

  it('a running engine writes the board again every ten minutes, not once per process', () => {
    // 2026-10-16 audit: written once per boot, a board row edited or switched
    // off after boot stayed wrong until the next release.
    expect(FIXED_BOARD_RESYNC_MS).toBe(10 * 60_000);
    const src = readFileSync(join(__dirname, 'ScheduledTournamentService.ts'), 'utf8');
    const poll = src.slice(
      src.indexOf('private async poll('),
      src.indexOf('private async syncFixedBoard(')
    );
    expect(poll).toMatch(/Date\.now\(\) - this\.fixedBoardSyncedAt >= FIXED_BOARD_RESYNC_MS/);
    expect(poll).toMatch(
      /if \(await this\.syncFixedBoard\(\)\) this\.fixedBoardSyncedAt = Date\.now\(\);/
    );
    expect(src).not.toMatch(/fixedBoardSynced\s*=\s*(true|false)/);
  });

  it('knows a board row when it sees one', () => {
    for (const club of FIXED_BOARD_CLUBS) {
      for (const event of FIXED_BOARD)
        expect(isFixedBoardConfig(fixedBoardRowFor(club, event).config)).toBe(true);
    }
    expect(isFixedBoardConfig({ type: 'mtt', name: 'Sunday 200 Deep Stack' })).toBe(false);
    expect(isFixedBoardConfig(null)).toBe(false);
    expect(isFixedBoardConfig([])).toBe(false);
  });

  it('the database refuses an owner edit of a board row, so the owner screen and the engine cannot fight', () => {
    const file = readdirSync(migrationsDir).find((f) =>
      f.includes('the_hard_coded_board_and_the_weekly_events_keep_chicago_time')
    );
    expect(file, 'the 2026-10-16 board-guard migration').toBeTruthy();
    const sql = readFileSync(join(migrationsDir, file!), 'utf8');
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_tournament_schedule_board_is_hard_coded\(\)/
    );
    expect(sql).toMatch(/auth\.role\(\)[\s\S]{0,120}'authenticated'[\s\S]{0,40}'anon'/);
    expect(sql).toMatch(/'fixed_board'/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.tournament_schedules/);
  });
});

/**
 * THE BOARD IS SPREAD OUT (Dan, 2026-10-16): "REDO THEM SO TOURNAMENT DO NOT
 * START AT THE SAME TIME, THAT THEY ARE SPREAD OUT ACCORDINGLY THROUGHOUT THE
 * DAY."
 */
describe('no two tournaments start at the same time, and the starts are spread through the day', () => {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const starts = [
    ...FIXED_BOARD.flatMap((e) => e.times.map((t) => ({ t, who: e.name }))),
    ...WEEKLY_EVENT_SLOTS.map((t) => ({ t, who: `weekly ${t}` })),
  ];

  it('one event per start time, board and weekly events together', () => {
    const seen = new Map<string, string>();
    for (const s of starts) {
      expect(seen.get(s.t), `${s.who} and ${seen.get(s.t)} both start at ${s.t}`).toBeUndefined();
      seen.set(s.t, s.who);
    }
  });

  it('every start is on the 20-minute grid, so any two are at least 20 minutes apart', () => {
    for (const s of starts) expect(toMin(s.t) % 20, `${s.who} at ${s.t}`).toBe(0);
  });

  it('no hour of the day is empty or crowded: one to three starts in every hour', () => {
    for (let h = 0; h < 24; h++) {
      const n = starts.filter((s) => Math.floor(toMin(s.t) / 60) === h).length;
      expect(n, `hour ${h}`).toBeGreaterThanOrEqual(1);
      expect(n, `hour ${h}`).toBeLessThanOrEqual(3);
    }
  });

  it('the five Free Buys keep their five hours', () => {
    for (const slot of FREE_BUY_SLOTS) {
      const e = FIXED_BOARD.find((x) => x.name === freeBuyBoardName(slot))!;
      expect(e.times).toEqual([`${String(slot.chicagoHour).padStart(2, '0')}:00`]);
      expect(e.previousTimes).toBeUndefined();
    }
  });

  it('a repeated event is never back to back: its starts are at least an hour apart', () => {
    for (const e of FIXED_BOARD) {
      const m = e.times.map(toMin).sort((a, b) => a - b);
      for (let i = 0; i < m.length; i++) {
        const next = i + 1 < m.length ? m[i + 1] : m[0] + 1440;
        expect(next - m[i], e.name).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('every moved event carries its old times and the date the change may start', () => {
    expect(FIXED_BOARD_TIMES_EFFECTIVE_FROM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const club of FIXED_BOARD_CLUBS) {
      for (const e of FIXED_BOARD.filter((x) => x.previousTimes)) {
        const change = scheduleTimeChange(fixedBoardRowFor(club, e).config);
        expect(change, e.name).toEqual({
          previous: [...e.previousTimes!],
          from: FIXED_BOARD_TIMES_EFFECTIVE_FROM,
        });
      }
    }
  });
});

describe('a schedule whose times move never doubles a date', () => {
  const id = 'sched';
  const at = (date: string, tm: string) => ({
    spawnKey: `${id}:${date}:${tm}`,
    startTime: new Date(`${date}T${tm}:00Z`),
    localDate: date,
  });
  const change = { previous: ['22:30'], from: '2026-10-17' };

  it('a date before the change keeps the old times', () => {
    const due = resolveTimeChange(
      [at('2026-10-16', '04:00')],
      [at('2026-10-16', '22:30')],
      change,
      new Set(),
      id
    );
    expect(due.map((d) => d.spawnKey)).toEqual([`${id}:2026-10-16:22:30`]);
  });

  it('a later date that already has an old-time occurrence keeps the old times', () => {
    const claimed = new Set([`${id}:2026-10-18:22:30`]);
    const due = resolveTimeChange(
      [at('2026-10-18', '04:00')],
      [at('2026-10-18', '22:30')],
      change,
      claimed,
      id
    );
    expect(due.map((d) => d.spawnKey)).toEqual([`${id}:2026-10-18:22:30`]);
  });

  it('a date with nothing on the board yet takes the new times', () => {
    const due = resolveTimeChange(
      [at('2026-10-20', '04:00')],
      [at('2026-10-20', '22:30')],
      change,
      new Set(),
      id
    );
    expect(due.map((d) => d.spawnKey)).toEqual([`${id}:2026-10-20:04:00`]);
  });

  it('reads the whole date, so an old time that already ran still holds the date', () => {
    const keys = previousDayKeys(id, { previous: ['01:00', '22:30'], from: '2026-10-17' }, [
      at('2026-10-19', '04:00'),
    ]);
    expect(keys).toEqual([`${id}:2026-10-19:01:00`, `${id}:2026-10-19:22:30`]);
  });

  it('a malformed change is no change', () => {
    expect(scheduleTimeChange({})).toBeNull();
    expect(
      scheduleTimeChange({ previousStartTimes: ['25:00'], startTimesEffectiveFrom: '2026-10-17' })
    ).toBeNull();
    expect(
      scheduleTimeChange({ previousStartTimes: ['22:30'], startTimesEffectiveFrom: 'soon' })
    ).toBeNull();
  });

  it('the scheduler waits rather than guess when it cannot read what exists', () => {
    const src = readFileSync(join(__dirname, 'ScheduledTournamentService.ts'), 'utf8');
    expect(src).toMatch(/if \(change && !claimedSet\) return;/);
    expect(src).toMatch(/resolveTimeChange\(dueNew, duePrev, change, claimedSet!, schedule\.id\)/);
  });
});
