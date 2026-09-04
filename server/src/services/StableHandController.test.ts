import { describe, it, expect } from 'vitest';
import {
  planFloor,
  chicagoNow,
  stableHandHostCaps,
  hostAllowsNewBody,
  bodiesOnHostFrom,
  type FloorSnapshot,
  type TableSnapshot,
} from './StableHandController.js';
import {
  MIDWAY_UNION_ID,
  DSS_CLUB_ID,
  SEAT_HOLD_MS,
  nightCap,
  nightTablesNeeded,
} from './StableHand.js';

const horse = (
  id: string,
  over: Partial<{ sittingOut: boolean; minutesAtTable: number; isRed: boolean; stack: number }> = {}
) => ({
  horseId: id,
  sittingOut: false,
  minutesAtTable: 30,
  isRed: false,
  stack: 100,
  ...over,
});

const table = (o: Partial<TableSnapshot> & { tableId: string }): TableSnapshot => ({
  hostId: MIDWAY_UNION_ID,
  variant: 'nlh',
  sb: 1,
  bb: 2,
  maxPlayers: 6,
  occupied: 6,
  humansSeated: 0,
  humansWaiting: 0,
  seatedHorses: Array.from({ length: 6 }, (_, i) => horse(`${o.tableId}-h${i}`)),
  status: 'running',
  ...o,
});

const snap = (over: Partial<FloorSnapshot> = {}): FloorSnapshot => ({
  chicagoHour: 19,
  chicagoMinute: 0,
  killed: false,
  hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables: [] }],
  ...over,
});

describe('planFloor - shape', () => {
  it('T1 drives ten 6-max tables toward 6 FULL / 2 ONE_OPEN / 2 JOINABLE', () => {
    const tables = Array.from({ length: 10 }, (_, i) => table({ tableId: `t${i}` }));
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    const m = p.metrics[0];
    expect(m.targetFull).toBe(6);
    expect(m.targetOneOpen).toBe(2);
    expect(m.targetJoinable).toBe(2);
    // All ten are FULL, so the plan must stand horses to make the other buckets.
    expect(p.stand.filter((s) => s.reason === 'shape_adjust').length).toBeGreaterThan(0);
  });

  it('T2 never orders a seat that would fill a ONE_OPEN table', () => {
    const tables = [
      ...Array.from({ length: 6 }, (_, i) => table({ tableId: `full${i}` })),
      table({
        tableId: 'one-open',
        occupied: 5,
        seatedHorses: Array.from({ length: 5 }, (_, i) => horse(`o${i}`)),
      }),
      table({
        tableId: 'j1',
        occupied: 3,
        seatedHorses: Array.from({ length: 3 }, (_, i) => horse(`j${i}`)),
      }),
      table({
        tableId: 'j2',
        occupied: 2,
        seatedHorses: Array.from({ length: 2 }, (_, i) => horse(`k${i}`)),
      }),
      table({
        tableId: 'one-open2',
        occupied: 5,
        seatedHorses: Array.from({ length: 5 }, (_, i) => horse(`p${i}`)),
      }),
    ];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    const m = p.metrics[0];
    // Already at target: 6 full, 2 one-open, 2 joinable. Nothing to seat.
    expect(m.full).toBe(6);
    expect(m.oneOpen).toBe(2);
    expect(m.joinable).toBe(2);
    expect(p.seat.filter((s) => s.tableId.startsWith('one-open'))).toHaveLength(0);
  });

  it('flags a one-player table rather than listing it as joinable', () => {
    const tables = [table({ tableId: 'lonely', occupied: 1, seatedHorses: [horse('a')] })];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 10, tables }] })
    );
    expect(p.alerts.some((a) => a.startsWith('one_player_table_listed'))).toBe(true);
    expect(p.metrics[0].onePlayerTablesListed).toBe(1);
  });
});

describe('planFloor - human yield', () => {
  it('T3 stands a horse 2-5 minutes after a human joins the list', () => {
    const tables = [table({ tableId: 'wanted', humansWaiting: 1, waitlistId: 'wl-1' })];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    const yields = p.stand.filter((s) => s.reason === 'human_yield');
    expect(yields.length).toBeGreaterThan(0);
    yields.forEach((y) => {
      expect(y.delayMs).toBeGreaterThanOrEqual(120_000);
      expect(y.delayMs).toBeLessThan(300_000);
    });
  });

  it('T4 holds the vacated seat for 90 seconds', () => {
    const tables = [table({ tableId: 'wanted', humansWaiting: 1, waitlistId: 'wl-1' })];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    p.stand
      .filter((s) => s.reason === 'human_yield')
      .forEach((y) => expect(y.holdSeatMs).toBe(SEAT_HOLD_MS));
  });

  it('T5 one human does not yield four horses', () => {
    const tables = [table({ tableId: 'wanted', humansWaiting: 1, waitlistId: 'wl-1' })];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    expect(p.stand.filter((s) => s.reason === 'human_yield')).toHaveLength(2);
  });

  it('T33 the kill switch stops seating but never the yield', () => {
    const tables = [
      table({ tableId: 'wanted', humansWaiting: 1, waitlistId: 'wl-1' }),
      table({ tableId: 'empty', occupied: 0, seatedHorses: [] }),
    ];
    const p = planFloor(
      snap({ killed: true, hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    expect(p.seat).toHaveLength(0);
    expect(p.open).toHaveLength(0);
    expect(p.stand.filter((s) => s.reason === 'human_yield').length).toBeGreaterThan(0);
  });
});

describe('planFloor - occupancy', () => {
  it('T20 alerts and winds down when a host is over its cap', () => {
    const tables = Array.from({ length: 4 }, (_, i) => table({ tableId: `t${i}` }));
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 400, tables }] })
    );
    expect(p.alerts.some((a) => a.startsWith('occupancy_over'))).toBe(true);
    expect(p.alerts).toContain('over_peak_cap host=' + MIDWAY_UNION_ID);
    expect(p.stand.some((s) => s.reason === 'occupancy_wind_down')).toBe(true);
  });

  it('reports the measured caps for both hosts', () => {
    const p = planFloor(
      snap({
        hosts: [
          { hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables: [] },
          { hostId: DSS_CLUB_ID, n: 416, uniqueLive: 150, tables: [] },
        ],
      })
    );
    expect(p.metrics[0]).toMatchObject({ peakCap: 233, nightCap: 29 });
    expect(p.metrics[1]).toMatchObject({ peakCap: 166, nightCap: 20 });
  });

  it('holds the night cap at 04:00 and does not ramp past it', () => {
    const p = planFloor(
      snap({
        chicagoHour: 4,
        hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 100, tables: [] }],
      })
    );
    expect(p.metrics[0].max).toBeLessThanOrEqual(29);
    expect(p.alerts).toContain('over_night_cap host=' + MIDWAY_UNION_ID);
  });
});

describe('planFloor - exotics and limit games', () => {
  it('T6 closes exotics above 1/2 and trims the rest to two', () => {
    const tables = [
      table({ tableId: 'p1', variant: 'pineapple', occupied: 6 }),
      table({ tableId: 'p2', variant: 'pineapple', occupied: 5 }),
      table({ tableId: 'p3', variant: 'pineapple', occupied: 1, seatedHorses: [horse('x')] }),
      table({ tableId: 'p-hi', variant: 'pineapple', bb: 5, sb: 2, occupied: 3 }),
    ];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 100, tables }] })
    );
    expect(p.close).toContain('p-hi');
    expect(p.close).toContain('p3');
    expect(p.alerts.some((a) => a.startsWith('exotic_above_half'))).toBe(true);
  });

  it('keeps a limit floor lit and caps it separately from plo8', () => {
    const tables = [
      table({ tableId: 'o1', variant: 'plo8', occupied: 6 }),
      table({ tableId: 'o2', variant: 'plo8', occupied: 6 }),
    ];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 100, tables }] })
    );
    expect(p.close).not.toContain('o1');
    expect(p.close).not.toContain('o2');
    // plo8 is at cap and opens nothing; flh/flo8 are untouched by that.
    expect(p.open.filter((o) => o.variant === 'plo8')).toHaveLength(0);
  });

  it('does not treat fixed-limit tables as pot-limit Omaha 8', () => {
    const tables = [
      table({ tableId: 'f1', variant: 'flo8', occupied: 6 }),
      table({ tableId: 'f2', variant: 'flo8', occupied: 5 }),
      table({
        tableId: 'f3',
        variant: 'flo8',
        occupied: 2,
        seatedHorses: [horse('a'), horse('b')],
      }),
    ];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 100, tables }] })
    );
    // Own cap of 2: the smallest is trimmed, the other two stay.
    expect(p.close).toEqual(['f3']);
  });
});

describe('chicagoNow', () => {
  it('returns a legal wall clock', () => {
    const c = chicagoNow(new Date('2026-09-04T18:30:00Z'));
    expect(c.hour).toBeGreaterThanOrEqual(0);
    expect(c.hour).toBeLessThan(24);
    expect(c.minute).toBe(30);
    expect(c.weekday).toBeGreaterThanOrEqual(0);
    expect(c.weekday).toBeLessThanOrEqual(6);
  });
  it('converts UTC to Chicago, not to itself', () => {
    // 18:30 UTC is 13:30 CDT in September.
    expect(chicagoNow(new Date('2026-09-04T18:30:00Z')).hour).toBe(13);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   A ZERO POPULATION IS NOT A SMALL FLEET

   Written after the FIRST live run of GET /stable-hand, 2026-09-04, which
   returned n = 0 for both hosts against a fleet of 1,000 because
   `profiles!inner(is_horse)` is an ambiguous embed on club_members. n is the
   denominator of every cap, so 188 live horses read as 188 over a cap of 0 and
   the plan asked for 170 stands. Nothing executed them - the executor ships
   human yield only - but that was the phased rollout catching it, not the code
   being safe.
   ══════════════════════════════════════════════════════════════════════════ */
describe('planFloor - an unreadable population is never managed', () => {
  const zeroPopHost = (tables: TableSnapshot[]) => ({
    hostId: MIDWAY_UNION_ID,
    n: 0,
    uniqueLive: 188,
    tables,
  });

  it('says so out loud instead of pretending the host is empty', () => {
    const p = planFloor(snap({ hosts: [zeroPopHost([table({ tableId: 't0' })])] }));
    expect(p.alerts.some((a) => a.startsWith('host_population_unknown'))).toBe(true);
  });

  it('orders NO wind-down stands, which is the 170-stand plan that started this', () => {
    const tables = Array.from({ length: 20 }, (_, i) => table({ tableId: `t${i}` }));
    const p = planFloor(snap({ hosts: [zeroPopHost(tables)] }));
    expect(p.stand.filter((s) => s.reason === 'occupancy_wind_down')).toHaveLength(0);
    expect(p.stand.filter((s) => s.reason === 'shape_adjust')).toHaveLength(0);
    expect(p.seat).toHaveLength(0);
  });

  it('raises no cap alerts it cannot actually evaluate', () => {
    const p = planFloor(snap({ hosts: [zeroPopHost([table({ tableId: 't0' })])] }));
    expect(p.alerts.some((a) => a.startsWith('over_peak_cap'))).toBe(false);
    expect(p.alerts.some((a) => a.startsWith('over_night_cap'))).toBe(false);
  });

  it('STILL yields to a waiting human - a failed read is not their problem', () => {
    const t = table({ tableId: 'busy', humansWaiting: 1 });
    const p = planFloor(snap({ hosts: [zeroPopHost([t])] }));
    expect(p.stand.filter((s) => s.reason === 'human_yield').length).toBeGreaterThan(0);
  });

  it('a host left out of the snapshot entirely is reported, not silently absent', () => {
    const p = planFloor(snap({ hosts: [], unreadableHosts: [MIDWAY_UNION_ID, DSS_CLUB_ID] }));
    expect(p.alerts).toContain(`host_unreadable host=${MIDWAY_UNION_ID}`);
    expect(p.alerts).toContain(`host_unreadable host=${DSS_CLUB_ID}`);
    expect(p.seat).toHaveLength(0);
    expect(p.stand).toHaveLength(0);
    expect(p.metrics).toHaveLength(0);
  });
});

describe('SOURCE LAW: the snapshot never turns a failed read into a zero', () => {
  it('eligibleBodies returns null on an incomplete read, and the builder skips that host', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const raw = readFileSync(resolve(__dirname, 'StableHandSnapshot.ts'), 'utf8');
    // The ban is on CODE. The header explains at length which embed broke and
    // has to name it to be worth reading.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Every read is paged or chunked, and every completeness flag is checked.
    expect(src).toContain('fetchAllRows');
    expect(src).toContain('selectInChunks');
    expect(src).toContain('if (!page.complete) return null;');
    expect(src).toContain('unreadableHosts.push(hostId)');
    // And the ambiguous embed that caused it never comes back.
    expect(src).not.toContain('profiles!inner');
  });
});

describe('SOURCE LAW: a partial tagging run is not a finished one', () => {
  it('the no-op guard compares against the intended count, and the write is read back', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const raw = readFileSync(resolve(__dirname, '../scripts/horsesTag.ts'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    /* The first real run died on `fetch failed` partway through the first
       chunk. Nothing landed, so nothing was harmed - but `count > 0` would
       have read a half-written table as a finished one, leaving horses
       untagged forever with every log line green. */
    expect(src).not.toMatch(
      /if \(\(count \?\? 0\) > 0\) \{\s*console\.log\(\s*`\[stable-hand:tag\] \$\{count\} tags already/
    );
    expect(src).toContain('if ((count ?? 0) >= tagRows.length) {');
    expect(src).toContain('tagging incomplete:');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE SEEDING SIDE OF THE CURVE

   Standing a horse up is pointless if the fleet manager reseats the seat
   thirty seconds later: that is a cash-out and a buy-in per horse per cycle,
   and the loudest tell a floor can have. These are the pieces the seeding
   cycle uses so a freed seat stays freed.
   ══════════════════════════════════════════════════════════════════════════ */
describe('the per-host seat cap', () => {
  it('caps each host from its own population and the hour', () => {
    const caps = stableHandHostCaps(
      new Map([
        [MIDWAY_UNION_ID, 584],
        [DSS_CLUB_ID, 416],
      ]),
      { hour: 3, minute: 0 }
    );
    // 03:00 is the night window: 5% of the population (Dan 2026-09-04).
    expect(caps.get(MIDWAY_UNION_ID)!).toBe(29);
    expect(caps.get(DSS_CLUB_ID)!).toBeLessThan(caps.get(MIDWAY_UNION_ID)!);
  });

  it('is far higher at peak than at night, so the cap only binds overnight', () => {
    const night = stableHandHostCaps(new Map([[MIDWAY_UNION_ID, 584]]), { hour: 3, minute: 0 });
    const peak = stableHandHostCaps(new Map([[MIDWAY_UNION_ID, 584]]), { hour: 20, minute: 0 });
    expect(peak.get(MIDWAY_UNION_ID)!).toBeGreaterThan(night.get(MIDWAY_UNION_ID)! * 2);
  });

  it('GIVES NO CAP AT ALL for a population it could not read', () => {
    const caps = stableHandHostCaps(
      new Map([
        [MIDWAY_UNION_ID, 0],
        [DSS_CLUB_ID, Number.NaN],
      ]),
      { hour: 3, minute: 0 }
    );
    // No entry means no cap, which is exactly the seeder's behaviour today.
    expect(caps.size).toBe(0);
  });
});

describe('hostAllowsNewBody', () => {
  const bodies = new Map([[MIDWAY_UNION_ID, new Set(['a', 'b', 'c'])]]);
  const caps = new Map([[MIDWAY_UNION_ID, 3]]);
  const ask = (horseId: string, over: Record<string, unknown> = {}) =>
    hostAllowsNewBody({
      hostId: MIDWAY_UNION_ID,
      horseId,
      caps,
      bodiesOnHost: bodies,
      humanNeedsRescue: false,
      ...over,
    } as Parameters<typeof hostAllowsNewBody>[0]);

  it('refuses a NEW body once the host is at its cap', () => {
    expect(ask('newcomer')).toBe(false);
  });

  it('still lets a horse ALREADY on the host open another table', () => {
    // The cap is on BODIES. One horse holding four seats is one body, so
    // multi-tabling is untouched by it.
    expect(ask('a')).toBe(true);
  });

  it('is bypassed outright when a human at the table needs the game rescued', () => {
    expect(ask('newcomer', { humanNeedsRescue: true })).toBe(true);
  });

  it('allows everything when the host has no cap', () => {
    expect(ask('newcomer', { caps: new Map() })).toBe(true);
  });

  it('allows the first body onto an empty host', () => {
    expect(ask('newcomer', { bodiesOnHost: new Map() })).toBe(true);
  });
});

describe('bodiesOnHostFrom counts bodies, not seats', () => {
  it('a horse at four tables on one host is one body', () => {
    const hostOf = new Map([
      ['t1', MIDWAY_UNION_ID],
      ['t2', MIDWAY_UNION_ID],
      ['t3', MIDWAY_UNION_ID],
      ['t4', DSS_CLUB_ID],
    ]);
    const seats = [
      { user_id: 'h1', table_id: 't1' },
      { user_id: 'h1', table_id: 't2' },
      { user_id: 'h1', table_id: 't3' },
      { user_id: 'h2', table_id: 't1' },
      { user_id: 'human', table_id: 't1' },
      { user_id: 'h1', table_id: 't4' },
    ];
    const out = bodiesOnHostFrom(seats, hostOf, (id) => id !== 'human');
    expect(out.get(MIDWAY_UNION_ID)!.size).toBe(2);
    expect(out.get(DSS_CLUB_ID)!.size).toBe(1);
  });

  it('a seat on a table it does not know the host of is skipped, not guessed', () => {
    const out = bodiesOnHostFrom([{ user_id: 'h1', table_id: 'unknown' }], new Map(), () => true);
    expect(out.size).toBe(0);
  });
});

describe('SOURCE LAW: the seeding cap can only ever refuse a NEW seat', () => {
  it('HorseFleetManager consults the cap and never stands anybody up for it', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const raw = readFileSync(resolve(__dirname, 'HorseFleetManager.ts'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // It is wired in.
    expect(src).toContain('stableHandHostCaps(');
    expect(src).toContain('hostAllowsNewBody({');
    // The body count is updated as seats are taken, or one pass could seat the
    // whole floor past a cap read from the position the cycle started with.
    expect(src).toContain('bodiesOnHost.get(seatedHost)!.add(horse.id)');
    // And nothing in this file removes a seated horse on account of the cap.
    expect(src).not.toContain('leaveTable');
    expect(src).not.toContain('atomicCashout');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   A LIVE TABLE IS ONE WITH PLAYERS AT IT, NOT ONE WITH A STATUS STRING

   Measured on production 2026-09-04 at 03:58, minutes after an hourly engine
   restart: Midway Union had 80 open tables, 74 of them with players and 362
   seats filled, and ZERO tables whose status read 'running'. The whole shape
   half of the planner was reasoning about an empty list.
   ══════════════════════════════════════════════════════════════════════════ */
describe('planFloor - shape reads seats, not tables.status', () => {
  const waitingButFull = (id: string) =>
    table({ tableId: id, status: 'waiting', occupied: 6, maxPlayers: 6 });

  it('counts a WAITING table that has six players at it', () => {
    const tables = Array.from({ length: 10 }, (_, i) => waitingButFull(`w${i}`));
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    expect(p.metrics[0].full).toBe(10);
  });

  it('a floor of waiting tables above the curve produces wind-down orders', () => {
    // The exact shape of the 03:58 reading: every table waiting, the host far
    // above its night cap. Before the fix this planned nothing at all.
    const tables = Array.from({ length: 20 }, (_, i) => waitingButFull(`w${i}`));
    const p = planFloor({
      chicagoHour: 3,
      chicagoMinute: 0,
      killed: false,
      hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 178, tables }],
    });
    expect(p.stand.filter((s) => s.reason === 'occupancy_wind_down').length).toBeGreaterThan(0);
  });

  it('still excludes a CLOSED table', () => {
    const tables = [waitingButFull('live'), table({ tableId: 'dead', status: 'closed' })];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    expect(p.metrics[0].full).toBe(1);
  });

  it('still excludes a table above the phase clamp', () => {
    const tables = [waitingButFull('ok'), table({ tableId: 'big', status: 'waiting', bb: 50 })];
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables }] })
    );
    expect(p.metrics[0].full).toBe(1);
  });

  it('human yield never depended on this and still does not', () => {
    // It loops every table on the host, so a waiting player was always served
    // even while the shape half was blind.
    const t = table({ tableId: 'busy', status: 'waiting', humansWaiting: 1 });
    const p = planFloor(
      snap({ hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 180, tables: [t] }] })
    );
    expect(p.stand.filter((s) => s.reason === 'human_yield').length).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   LATE NIGHT: FEWER TABLES, MORE PLAYERS AT EACH

   Dan 2026-09-04: "fewer tables, more players at each table. late night
   shouldn't have any 2-3 handed games." At 5% of the population there are
   about sixty seats to place on Midway Union overnight; spread over eighty
   tables that is one player each, so the thin ones are parked and the seats
   concentrate.
   ══════════════════════════════════════════════════════════════════════════ */
describe('planFloor - the night park', () => {
  const nightSnap = (tables: TableSnapshot[], over: Partial<FloorSnapshot> = {}) =>
    planFloor({
      chicagoHour: 4,
      chicagoMinute: 0,
      killed: false,
      hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 40, tables }],
      ...over,
    });

  /**
   * Enough full tables to satisfy the keep-open floor on their own, so a thin
   * table added beside them is parked on its own merits.
   *
   * SEVEN, not six: nightTablesNeeded derives the floor from the cap rather
   * than fixing it, and Midway Union's 5% cap of 29 bodies at up to 1.3 seats
   * each is 38 seats - seven full rings.
   */
  const KEEP_OPEN = nightTablesNeeded(nightCap(584), 4);
  const keepFull = () =>
    Array.from({ length: KEEP_OPEN }, (_, i) => table({ tableId: `full${i}`, occupied: 6 }));

  it('parks a 2-handed table', () => {
    const p = nightSnap([
      ...keepFull(),
      table({ tableId: 'thin', occupied: 2, seatedHorses: [horse('a'), horse('b')] }),
    ]);
    expect(p.park).toContain('thin');
  });

  it('parks an empty table', () => {
    const p = nightSnap([
      ...keepFull(),
      table({ tableId: 'empty', occupied: 0, seatedHorses: [] }),
    ]);
    expect(p.park).toContain('empty');
  });

  it('leaves a 4-handed table alone - four is not 2-3 handed', () => {
    const p = nightSnap([
      ...keepFull(),
      table({
        tableId: 'four',
        occupied: 4,
        seatedHorses: [horse('a'), horse('b'), horse('c'), horse('d')],
      }),
    ]);
    expect(p.park).not.toContain('four');
  });

  it('NEVER parks a table with a human seated', () => {
    // Parking stops the seeder refilling it, which is how a person ends up
    // alone at a table nobody can join.
    const p = nightSnap([
      ...keepFull(),
      table({ tableId: 'human', occupied: 2, humansSeated: 1, seatedHorses: [horse('a')] }),
    ]);
    expect(p.park).not.toContain('human');
  });

  it('NEVER parks a table a human is waiting for', () => {
    const p = nightSnap([
      ...keepFull(),
      table({
        tableId: 'queued',
        occupied: 2,
        humansWaiting: 1,
        seatedHorses: [horse('a'), horse('b')],
      }),
    ]);
    expect(p.park).not.toContain('queued');
  });

  it('KEEPS THE FULLEST tables it still needs open, however thin - the cascade guard', () => {
    // Without a floor the wind-down thins every table under the minimum, every
    // table is parked, and the host has nowhere left to seat anybody.
    const thin = Array.from({ length: 20 }, (_, i) =>
      table({ tableId: `t${i}`, occupied: 1, seatedHorses: [horse(`h${i}`)] })
    );
    const p = nightSnap(thin);
    expect(KEEP_OPEN).toBe(7);
    expect(p.park).toHaveLength(20 - KEEP_OPEN);
  });

  it('parks nothing in the daytime', () => {
    const thin = Array.from({ length: 20 }, (_, i) =>
      table({ tableId: `t${i}`, occupied: 1, seatedHorses: [horse(`h${i}`)] })
    );
    const p = planFloor({
      chicagoHour: 14,
      chicagoMinute: 0,
      killed: false,
      hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 150, tables: thin }],
    });
    expect(p.park).toHaveLength(0);
  });

  it('a table being closed for good is never ALSO parked', () => {
    // The two flags have opposite lifetimes. Writing both to one row is how a
    // permanent retirement gets lifted by the morning unpark.
    const tables = [
      ...keepFull(),
      // eight short-deck tables: the exotic cap closes most of them
      ...Array.from({ length: 8 }, (_, i) =>
        table({
          tableId: `sd${i}`,
          variant: 'short_deck',
          occupied: 1,
          seatedHorses: [horse(`s${i}`)],
        })
      ),
    ];
    const p = nightSnap(tables);
    expect(p.close.length).toBeGreaterThan(0);
    const both = p.park.filter((id) => p.close.includes(id));
    expect(both).toHaveLength(0);
  });

  it('says how much it is parking, per host', () => {
    const p = nightSnap([
      ...keepFull(),
      table({ tableId: 'thin', occupied: 1, seatedHorses: [horse('a')] }),
    ]);
    expect(p.alerts.some((a) => a.startsWith(`night_parking host=${MIDWAY_UNION_ID}`))).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE POPULATION IS CACHED; THE FLOOR IS NOT
   ══════════════════════════════════════════════════════════════════════════ */
describe('SOURCE LAW: the snapshot caches only the slow number', () => {
  it('caches the population and never the tables, seats or waiting lists', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const raw = readFileSync(resolve(__dirname, 'StableHandSnapshot.ts'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // The population goes through the cache...
    expect(src).toContain('const n = await cachedEligibleBodies(hostId);');
    // ...and nothing else does. A stale seat map is a plan for a floor that no
    // longer exists.
    expect(src).toContain("'StableHand.seats'");
    expect(src).toContain("'StableHand.waitlist'");
    expect(src).not.toMatch(/cached(Seats|Tables|Waitlist)/);
  });

  it('keeps the last good population rather than dropping a host on one bad read', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, 'StableHandSnapshot.ts'), 'utf8');
    expect(src).toContain('if (hit && nowMs - hit.readAt < POPULATION_MAX_AGE_MS) return hit.n;');
  });

  it('refreshes far more often than the number moves, and expires eventually', async () => {
    const { POPULATION_TTL_MS, POPULATION_MAX_AGE_MS } = await import('./StableHandSnapshot.js');
    expect(POPULATION_TTL_MS).toBeLessThan(POPULATION_MAX_AGE_MS);
    // more often than a horse's club membership realistically changes...
    expect(POPULATION_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
    // ...and a value older than an hour is a guess, not a measurement
    expect(POPULATION_MAX_AGE_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
