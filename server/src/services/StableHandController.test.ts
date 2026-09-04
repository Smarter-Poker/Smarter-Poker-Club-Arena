import { describe, it, expect } from 'vitest';
import {
  planFloor,
  chicagoNow,
  type FloorSnapshot,
  type TableSnapshot,
} from './StableHandController.js';
import { MIDWAY_UNION_ID, DSS_CLUB_ID, SEAT_HOLD_MS } from './StableHand.js';

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
    expect(p.metrics[0]).toMatchObject({ peakCap: 233, nightCap: 58 });
    expect(p.metrics[1]).toMatchObject({ peakCap: 166, nightCap: 41 });
  });

  it('holds the night cap at 04:00 and does not ramp past it', () => {
    const p = planFloor(
      snap({
        chicagoHour: 4,
        hosts: [{ hostId: MIDWAY_UNION_ID, n: 584, uniqueLive: 100, tables: [] }],
      })
    );
    expect(p.metrics[0].max).toBeLessThanOrEqual(58);
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
