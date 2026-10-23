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
import { FREE_BUY_SLOTS, freeBuyBoardName, freeBuySlotTime } from './FreeBuy.js';
import { DIAMOND_FREEROLL_REBUY_DIAMONDS, diamondSpawnConfig } from './diamondScheduledSpawn.js';
import { withMidwayStructure } from '../tournament/midwayStructurePolicy.js';
import {
  FIXED_BOARD,
  FIXED_BOARD_CLUBS,
  FIXED_BOARD_RESYNC_MS,
  FIXED_BOARD_TIMES_EFFECTIVE_FROM,
  WEEKLY_EVENT_SLOTS,
  WEEKLY_EVENT_DAYS,
  SATELLITE_MINUTES,
  BOARD_DAY_OPENS,
  BOARD_DAY_CLOSES,
  NEW_BOARD_EVENTS_START,
  isFixedBoardConfig,
  isRetiredMidwayBoardEvent,
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

  it('schedules the Free Buys at their Chicago hours', () => {
    for (const slot of FREE_BUY_SLOTS) {
      const row = scheduledNames.find((m) => m[1] === freeBuyBoardName(slot));
      expect(row, freeBuyBoardName(slot)).toBeTruthy();
      expect(row![2]).toBe(`'${String(slot.chicagoHour).padStart(2, '0')}:00'`);
    }
  });

  it('every lobby and union template the timers used to launch is on the hard-coded board', () => {
    const names = new Set(FIXED_BOARD.map((e) => e.name));
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
    for (const e of FIXED_BOARD) {
      const name = e.name;
      for (const sched of [midwaySchedule(name), arenaSchedule(name)]) {
        if (isRetiredMidwayBoardEvent(sched.club_id, name)) continue;
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
    expect(row).toEqual(withMidwayStructure({ ...board, schedule_id: sched.id }));
    expect(row.free_buy).toBe(true);
    expect(row.buy_in_amount).toBe(0);
    // Dan 2026-10-16: "DOUBLE ALL THE OTHER CURRENT GUARANTEES".
    // Owner October 20: evening 8:30 PM Free Buy is 500.
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
    expect(lobby).toEqual(
      withMidwayStructure({
        ...recurringMttRow(lobbyTemplate.config, START, {
          clubId: MIDWAY,
          unionId: MIDWAY,
          xmtt: false,
        }),
        schedule_id: '11111111-1111-1111-1111-111111111111',
      })
    );
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
    if (mapped.ok) expect(mapped.config.buyIn).toBe(total * 10);
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
    const name = 'Morning Free Buy (NLH)';
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
  it('carries 26 events, each once a day (11 on Sunday, the Sunday Funday day), for both clubs', () => {
    expect(FIXED_BOARD.length).toBe(26);
    expect(FIXED_BOARD.every((e) => e.times.length === 1)).toBe(true);
    const onDay = (d: number) => FIXED_BOARD.filter((e) => !e.days || e.days.includes(d)).length;
    expect(onDay(0)).toBe(11);
    for (const d of [1, 2, 3, 4, 5, 6]) expect(onDay(d)).toBe(26);
    expect(FIXED_BOARD_CLUBS.map((c) => c.clubId)).toEqual([MIDWAY, ARENA]);
  });

  it('an event that moved twice remembers the first migration times as its retired times', () => {
    const firstTimes = new Map(
      scheduledNames.map((m) => [m[1], m[2].split(',').map((t) => t.trim().replace(/'/g, ''))])
    );
    for (const e of FIXED_BOARD.filter((x) => x.retiredTimes)) {
      expect([...e.retiredTimes!], e.name).toEqual(firstTimes.get(e.name));
    }
  });

  it('every hard-coded event builds a row in both clubs: no unknown template can ship', () => {
    for (const club of FIXED_BOARD_CLUBS) {
      for (const event of FIXED_BOARD) {
        if (isRetiredMidwayBoardEvent(club.clubId, event.name)) continue;
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

  it('an empty table gets 51 rows after the Midway 11 AM removal', () => {
    const plan = planFixedBoardSync([]);
    expect(plan.inserts).toHaveLength(51);
    expect(plan.updates).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it('a table that already holds the board is left alone', () => {
    const existing = FIXED_BOARD_CLUBS.flatMap((c, ci) =>
      FIXED_BOARD.filter((e) => !isRetiredMidwayBoardEvent(c.clubId, e.name)).map((e, ei) =>
        asExisting(`${ci}-${ei}`, c, e)
      )
    );
    expect(planFixedBoardSync(existing)).toEqual({ inserts: [], updates: [], deactivate: [] });
  });

  it('a row whose times differ from the code is rewritten to the code', () => {
    const existing = FIXED_BOARD_CLUBS.flatMap((c, ci) =>
      FIXED_BOARD.filter((e) => !isRetiredMidwayBoardEvent(c.clubId, e.name)).map((e, ei) =>
        asExisting(`${ci}-${ei}`, c, e)
      )
    );
    existing[3] = { ...existing[3], start_times_utc: ['09:15'] };
    const plan = planFixedBoardSync(existing);
    expect(plan.updates.map((u) => u.id)).toEqual(['0-3']);
    expect(plan.updates[0].row.start_times_utc).toEqual([...FIXED_BOARD[3].times]);
  });

  it('a fixed-board row the code no longer lists is retired, and a duplicate too', () => {
    const existing = FIXED_BOARD_CLUBS.flatMap((c, ci) =>
      FIXED_BOARD.filter((e) => !isRetiredMidwayBoardEvent(c.clubId, e.name)).map((e, ei) =>
        asExisting(`${ci}-${ei}`, c, e)
      )
    );
    existing.push({ ...existing[0], id: 'dup' });
    existing.push({
      ...existing[1],
      id: 'gone',
      config: { type: 'fixed_board', fixedBoard: 'Retired Event (NLH)' },
    });
    expect(planFixedBoardSync(existing).deactivate.sort()).toEqual(['dup', 'gone']);
  });

  it('retires the removed Midway freeroll and preserves the Diamond Arena event', () => {
    const event = FIXED_BOARD.find((e) => e.name === 'Coffee Break Freeroll (PLO4)')!;
    const existing = FIXED_BOARD_CLUBS.map((c, i) => asExisting('freeroll-' + i, c, event));
    const plan = planFixedBoardSync(existing);
    expect(plan.deactivate).toContain('freeroll-0');
    expect(plan.deactivate).not.toContain('freeroll-1');
    expect(plan.inserts.some((r) => r.club_id === MIDWAY && r.name === event.name)).toBe(false);
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
 * A REAL ROOM'S DAY (Dan, 2026-10-16): "WHY THE FUCK DO WE HAVE A TOURNAMENT
 * EVERY 20 MINUTES IN THE MIDDLE OF THE NIGHT, LOOK AT REAL ONLINE POKER
 * SCHEDULES FROM THE TOP SITES", then "SATELLITES ARE NEVER 'PRIME
 * TOURNAMENTS'. YOU SHOULD ALWAYS HAVE A REAL TOURNAMENT RUNNING IN THOSE
 * SPOTS, ALL SATELLITES SHOULD START AT THE :15 OR :45."
 */
describe("a real room's day: a real tournament every half hour from 8 AM to 1 AM, nothing overnight", () => {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const startsOn = (day: number) => [
    ...FIXED_BOARD.filter((e) => !e.days || e.days.includes(day)).flatMap((e) =>
      e.times.map((t) => ({ t, who: e.name }))
    ),
    ...WEEKLY_EVENT_SLOTS.filter((t) => WEEKLY_EVENT_DAYS[t].includes(day)).map((t) => ({
      t,
      who: `weekly ${t}`,
    })),
  ];
  // 08:00, 08:30 ... 23:30, 00:00, 00:30, 01:00.
  const dayOfSlots = [...Array.from({ length: 32 }, (_, i) => 8 * 60 + i * 30), 0, 30, 60].map(
    (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  );

  it('every board and weekly start is on a :00 or a :30', () => {
    for (let d = 0; d < 7; d++)
      for (const s of startsOn(d)) expect(toMin(s.t) % 30, `${s.who} at ${s.t}`).toBe(0);
  });

  it('every half hour from 8 AM to 1 AM holds exactly one real tournament, every day', () => {
    for (let d = 0; d < 7; d++) {
      const starts = startsOn(d);
      const seen = new Map<string, string>();
      for (const s of starts) {
        expect(seen.get(s.t), `day ${d}: ${s.who} and ${seen.get(s.t)} at ${s.t}`).toBeUndefined();
        seen.set(s.t, s.who);
      }
      expect([...seen.keys()].sort(), `day ${d}`).toEqual([...dayOfSlots].sort());
    }
  });

  it('nothing starts between 1:30 AM and 8 AM', () => {
    expect(BOARD_DAY_OPENS).toBe('08:00');
    expect(BOARD_DAY_CLOSES).toBe('01:00');
    for (let d = 0; d < 7; d++)
      for (const s of startsOn(d)) {
        const m = toMin(s.t);
        expect(m > 60 && m < 8 * 60, `${s.who} at ${s.t}`).toBe(false);
      }
  });

  it('satellites start only on the :15 and the :45', () => {
    expect([...SATELLITE_MINUTES]).toEqual(['15', '45']);
    const file = readdirSync(migrationsDir).find((f) => f.includes('a_real_rooms_day'));
    expect(file, 'the 2026-10-16 schedule migration').toBeTruthy();
    const sql = readFileSync(join(migrationsDir, file!), 'utf8');
    const sats = [
      ...sql.matchAll(/^\s+\('(?:[^']+)', '(?:[^']+)', ARRAY\[[^\]]*\], ARRAY\[([^\]]+)\]/gm),
    ];
    expect(sats.length).toBeGreaterThan(0);
    for (const m of sats)
      for (const t of m[1].split(',').map((x) => x.trim().replace(/'/g, '')))
        expect(['15', '45'], t).toContain(t.slice(3));
  });

  it("the clubs' own events were moved onto exactly the weekly slots", () => {
    const file = readdirSync(migrationsDir).find((f) => f.includes('a_real_rooms_day'));
    const sql = readFileSync(join(migrationsDir, file!), 'utf8');
    const m = /IF v_slots IS DISTINCT FROM ARRAY\[([^\]]+)\]::text\[\]/.exec(sql);
    expect(m, 'the weekly-slot assertion').toBeTruthy();
    const slots = m![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(slots).toEqual([...WEEKLY_EVENT_SLOTS]);
  });

  it('every plain event of 25 or more has a satellite, and no satellite is named like its target', () => {
    const file = readdirSync(migrationsDir).find((f) => f.includes('a_real_rooms_day'));
    const sql = readFileSync(join(migrationsDir, file!), 'utf8');
    const rows = [
      ...sql.matchAll(/^\s+\('([^']+)', '([^']+)', ARRAY\[[^\]]*\], ARRAY\[[^\]]+\]/gm),
    ];
    const targets = new Set(rows.map((m) => m[2]));
    for (const m of rows) expect(m[1].startsWith(m[2]), m[1]).toBe(false);
    for (const t of [
      'Prime Time Main Event',
      'Nightly 10K (NLH)',
      'Friday Fight Night Opener',
      'Saturday Stackfest Opener',
      'Wednesday Feature',
      'Six-Card Feature',
      'Friday Night Feature',
      'Saturday Night Big Stack',
      'Sunday Funday PLO Classic',
      'Sunday Funday Turbo',
      'Sunday Funday Big Stack',
      'Sunday Funday Six-Max',
      'Sunday Funday Championship',
      'Sunday Funday Happy Hour',
      'Sunday Funday Prime Time',
      'Sunday Funday PLO High Roller',
      'Sunday Funday PLO Opener',
      'Sunday Funday Warm-Up',
      'Sunday Funday Main Event',
      'Sunday Funday PLO5 Big Stack',
      'Sunday Funday Six-Card Closer',
    ])
      expect(targets.has(t), t).toBe(true);
  });

  it('the five Free Buys run every day at 8:30 AM, 12:30 PM, 4:30 PM, 8:30 PM and 12:30 AM', () => {
    expect(FREE_BUY_SLOTS.map(freeBuySlotTime).sort()).toEqual([
      '00:30',
      '08:30',
      '12:30',
      '16:30',
      '20:30',
    ]);
    for (const slot of FREE_BUY_SLOTS) {
      const e = FIXED_BOARD.find((x) => x.name === freeBuyBoardName(slot))!;
      expect(e.times).toEqual([freeBuySlotTime(slot)]);
      expect(e.days).toBeUndefined();
      expect(e.previousTimes).toEqual([`${String(slot.chicagoHour).padStart(2, '0')}:00`]);
    }
  });

  it('6 PM to 10 PM is the dearest part of the day: every paid board event there costs 22 or more', () => {
    for (const e of FIXED_BOARD) {
      const m = toMin(e.times[0]);
      if (m < 18 * 60 || m > 22 * 60) continue;
      if (FREE_BUY_SLOTS.some((s) => freeBuyBoardName(s) === e.name)) continue;
      const t = fixedBoardTemplate(e.name)!;
      expect(t.config.buyIn + t.config.rake, e.name).toBeGreaterThanOrEqual(22);
    }
  });

  it('every board guarantee is a whole 500 (Dan: "NO 25 75 OR 50 AMOUNTS")', () => {
    for (const e of FIXED_BOARD) {
      const t = fixedBoardTemplate(e.name);
      if (!t) continue; // a Free Buy
      expect(t.config.guarantee % 500, e.name).toBe(0);
      expect(t.config.guarantee, e.name).toBeGreaterThan(0);
    }
  });

  it('every moved event carries its old and retired times and the date the change may start', () => {
    expect(FIXED_BOARD_TIMES_EFFECTIVE_FROM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const club of FIXED_BOARD_CLUBS) {
      for (const e of FIXED_BOARD.filter((x) => x.previousTimes)) {
        const change = scheduleTimeChange(fixedBoardRowFor(club, e).config, e.times);
        expect(change, e.name).toEqual({
          previous: [...e.previousTimes!],
          from: FIXED_BOARD_TIMES_EFFECTIVE_FROM,
          ...(e.retiredTimes ? { retired: [...e.retiredTimes] } : {}),
        });
        // A retired time that is also a live one could freeze the wrong date.
        for (const t of e.retiredTimes ?? []) {
          expect(e.times, e.name).not.toContain(t);
          expect(e.previousTimes, e.name).not.toContain(t);
        }
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

  it('a date that already ran on the retired timetable takes nothing more', () => {
    const twice = { previous: ['22:30'], from: '2026-10-17', retired: ['19:30'] };
    const claimed = new Set([`${id}:2026-10-16:19:30`]);
    const due = resolveTimeChange(
      [at('2026-10-16', '04:00')],
      [at('2026-10-16', '22:30')],
      twice,
      claimed,
      id
    );
    expect(due).toEqual([]);
    expect(
      previousDayKeys(id, twice, [at('2026-10-16', '04:00')]).includes(`${id}:2026-10-16:19:30`)
    ).toBe(true);
  });

  it('a retired time that is also a current time is ignored', () => {
    expect(
      scheduleTimeChange(
        {
          previousStartTimes: ['22:30'],
          retiredStartTimes: ['04:00', '19:30'],
          startTimesEffectiveFrom: '2026-10-17',
        },
        ['04:00']
      )
    ).toEqual({ previous: ['22:30'], from: '2026-10-17', retired: ['19:30'] });
  });

  it('a brand-new event starts on its first date and never before', () => {
    const fresh = scheduleTimeChange({
      previousStartTimes: [],
      startTimesEffectiveFrom: '2026-10-20',
    });
    expect(fresh).toEqual({ previous: [], from: '2026-10-20' });
    const before = resolveTimeChange([at('2026-10-19', '04:00')], [], fresh!, new Set(), id);
    expect(before).toEqual([]);
    const after = resolveTimeChange([at('2026-10-20', '04:00')], [], fresh!, new Set(), id);
    expect(after.map((d) => d.spawnKey)).toEqual([`${id}:2026-10-20:04:00`]);
  });

  it('the board events added on 2026-10-16 wait for the first date the new timetable owns', () => {
    for (const e of FIXED_BOARD.filter((x) => x.startsFrom)) {
      expect(e.startsFrom).toBe(NEW_BOARD_EVENTS_START);
      expect(e.previousTimes, e.name).toBeUndefined();
      expect(scheduleTimeChange(fixedBoardRowFor(FIXED_BOARD_CLUBS[0], e).config, e.times)).toEqual(
        {
          previous: [],
          from: NEW_BOARD_EVENTS_START,
        }
      );
    }
    expect(
      FIXED_BOARD.filter((x) => x.startsFrom)
        .map((x) => x.name)
        .sort()
    ).toEqual([
      'Afternoon Deep Stack (NLH)',
      'Dinner Break PLO (PLO4)',
      'Happy Hour Bounty (NLH)',
      'Midday Turbo (NLH)',
    ]);
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

// Owner October 22: the same guarantees in both rooms, on every weekday.
describe('daily Free Buy guarantees in both live schedule creators', () => {
  const cases = Array.from({ length: 7 }, (_, day) =>
    [midwaySchedule, arenaSchedule].flatMap((schedule) =>
      [
        [8, 'Morning', 250],
        [12, 'Midday', 500],
        [16, 'Afternoon', 500],
        [20, 'Prime Time', 500],
        [0, 'Midnight', 250],
      ].map(([hour, label, guarantee]) => ({
        day,
        hour: Number(hour),
        guarantee: Number(guarantee),
        schedule: schedule(`${label} Free Buy (NLH)`),
      }))
    )
  ).flat();
  it.each(cases)(
    'day $day / $schedule.club_id / $schedule.name is $guarantee GTD',
    ({ day, hour, guarantee, schedule }) => {
      const start = new Date(Date.UTC(2026, 9, 25 + day, hour + 5, 30));
      const row = fixedBoardRow(schedule, { fixedBoard: schedule.name }, start);
      expect(row).not.toBeNull();
      expect(row!.guaranteed_prize).toBe(guarantee);
      expect(row!.buy_in_amount).toBe(0);
      expect(row!.buy_in_fee).toBe(0);
      expect(row!.starting_chips).toBe(3000);
      expect(row!.start_time).toBe(start.toISOString());
      expect(row!.schedule_id).toBe(schedule.id);
      if (schedule.club_id === ARENA) {
        const converted = diamondSpawnConfig(row!, {}, start);
        expect(converted.ok).toBe(true);
        if (converted.ok) expect(converted.config.guaranteedPrize).toBe(guarantee);
      }
    }
  );
});

// This operator action must never bypass the existing registered-player law.
it('the one-time guarantee update locks and rechecks before changing eligible listings', () => {
  const sql = readFileSync(join(__dirname, '../../../scripts/ops/free-buy-guarantees.sql'), 'utf8');
  expect(sql).toContain('FOR UPDATE OF t');
  expect(sql).toContain('public.fn_platform_frozen()');
  for (const field of [
    'entry_contract_locked',
    'prize_pool_finalized',
    'current_players',
    'prize_pool',
  ])
    expect(sql).toContain(`current_event.${field}`);
  expect(sql).toContain('FROM public.tournament_players p');
  expect(sql).toContain('current_event.start_time <= clock_timestamp()');
  expect(sql).not.toMatch(/DISABLE|session_replication_role|DELETE FROM|TRUNCATE/i);
});
