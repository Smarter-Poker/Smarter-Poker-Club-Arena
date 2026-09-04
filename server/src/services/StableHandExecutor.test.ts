/**
 * THE EXECUTOR - the first order Operation Stable Hand actually ships.
 *
 * Every test here is about one of three things: the human waits the right
 * amount of time, the same seat is not ordered to stand twice while it is
 * settling, and nothing in this module can reach a seat row directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ripeYields,
  yieldKey,
  yieldRequestsFor,
  YIELD_COOLDOWN_MS,
  MAX_YIELDS_PER_CYCLE,
  STABLE_HAND_CYCLE_MS,
  type YieldRequest,
} from './StableHandExecutor.js';
import { SEAT_HOLD_MS, YIELD_MIN_MS, YIELD_SPAN_MS, MIDWAY_UNION_ID } from './StableHand.js';
import type { FloorSnapshot, StandOrder } from './StableHandController.js';

const NOW = Date.UTC(2026, 8, 4, 18, 0, 0);

const order = (over: Partial<StandOrder> = {}): StandOrder => ({
  tableId: 'table-1',
  horseId: 'horse-1',
  reason: 'human_yield',
  delayMs: 3 * 60_000,
  holdSeatMs: SEAT_HOLD_MS,
  ...over,
});

const req = (o: StandOrder, waitedMs: number): YieldRequest => ({
  order: o,
  waitingSinceMs: NOW - waitedMs,
});

describe('a yield waits the delay the human has already served', () => {
  it('is not ripe before the delay', () => {
    const r = ripeYields([req(order(), 2 * 60_000)], NOW, new Map());
    expect(r.execute).toHaveLength(0);
  });

  it('is ripe at the delay exactly', () => {
    const r = ripeYields([req(order(), 3 * 60_000)], NOW, new Map());
    expect(r.execute).toHaveLength(1);
  });

  it('measures from when the human JOINED, not from when we noticed', () => {
    // A human who has already waited four minutes when the cycle first sees
    // them stands a horse up on that very cycle. Measuring from "first seen"
    // would make them wait three more minutes for a delay they had served.
    const r = ripeYields([req(order(), 4 * 60_000)], NOW, new Map());
    expect(r.execute).toHaveLength(1);
  });

  it('the whole delay band fits inside the 2-5 minutes Dan specified', () => {
    expect(YIELD_MIN_MS).toBe(2 * 60_000);
    // YIELD_SPAN_MS is the MODULUS, so the hash yields 0..SPAN-1 and the
    // largest delay is MIN + SPAN - 1 = exactly 5:00. Inclusive at both ends,
    // which is what "2-5 minutes" says.
    expect(YIELD_MIN_MS + YIELD_SPAN_MS - 1).toBe(5 * 60_000);
    // and the cycle is short enough that the LAST cycle before the deadline
    // still lands inside the band
    expect(STABLE_HAND_CYCLE_MS).toBeLessThan(YIELD_SPAN_MS);
  });

  it('a missing join time yields IMMEDIATELY rather than never', () => {
    // A failed read is not "no human is waiting". The failure a waiting human
    // must never hit is the one where nobody stands up at all.
    const r = ripeYields([{ order: order(), waitingSinceMs: NaN }], NOW, new Map());
    expect(r.execute).toHaveLength(1);
  });
});

describe('the cooldown stops a settling seat being re-ordered every cycle', () => {
  it('holds a seat ordered inside the cooldown', () => {
    const o = order();
    const last = new Map([[yieldKey(o), NOW - 30_000]]);
    const r = ripeYields([req(o, 5 * 60_000)], NOW, last);
    expect(r.execute).toHaveLength(0);
    expect(r.heldByCooldown).toBe(1);
  });

  it('releases it once the cooldown expires', () => {
    const o = order();
    const last = new Map([[yieldKey(o), NOW - YIELD_COOLDOWN_MS - 1]]);
    expect(ripeYields([req(o, 5 * 60_000)], NOW, last).execute).toHaveLength(1);
  });

  it('is longer than any cash hand, because leaveTable defers mid-hand', () => {
    expect(YIELD_COOLDOWN_MS).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it('the key is the SEAT, not the horse - a horse plays four tables at once', () => {
    expect(yieldKey(order({ tableId: 'a' }))).not.toBe(yieldKey(order({ tableId: 'b' })));
    const last = new Map([[yieldKey(order({ tableId: 'a' })), NOW]]);
    const r = ripeYields(
      [req(order({ tableId: 'a' }), 5 * 60_000), req(order({ tableId: 'b' }), 5 * 60_000)],
      NOW,
      last
    );
    expect(r.execute.map((x) => x.order.tableId)).toEqual(['b']);
  });
});

describe('the per-cycle ceiling defers, it never drops', () => {
  it('caps a runaway plan', () => {
    const many = Array.from({ length: MAX_YIELDS_PER_CYCLE + 5 }, (_, i) =>
      req(order({ tableId: `t${i}`, horseId: `h${i}` }), 5 * 60_000)
    );
    const r = ripeYields(many, NOW, new Map());
    expect(r.execute).toHaveLength(MAX_YIELDS_PER_CYCLE);
    expect(r.heldByCap).toBe(5);
  });

  it('serves the longest-waiting human first, so a cap cannot starve them', () => {
    const r = ripeYields(
      [
        req(order({ tableId: 'recent', horseId: 'h1' }), 3 * 60_000),
        req(order({ tableId: 'oldest', horseId: 'h2' }), 20 * 60_000),
      ],
      NOW,
      new Map(),
      { max: 1 }
    );
    expect(r.execute[0].order.tableId).toBe('oldest');
  });
});

describe('only human_yield is executed', () => {
  it('shape_adjust and occupancy_wind_down are ignored entirely', () => {
    const r = ripeYields(
      [
        req(order({ reason: 'shape_adjust', delayMs: 0 }), 60 * 60_000),
        req(order({ reason: 'occupancy_wind_down', delayMs: 0, tableId: 't2' }), 60 * 60_000),
      ],
      NOW,
      new Map()
    );
    expect(r.execute).toHaveLength(0);
  });

  it('yieldRequestsFor pulls only human_yield out of a real plan', () => {
    const snap: FloorSnapshot = {
      chicagoHour: 13,
      chicagoMinute: 0,
      killed: false,
      hosts: [
        {
          hostId: MIDWAY_UNION_ID,
          n: 584,
          uniqueLive: 200,
          tables: [
            {
              tableId: 'busy',
              hostId: MIDWAY_UNION_ID,
              variant: 'nlh',
              sb: 1,
              bb: 2,
              maxPlayers: 6,
              occupied: 6,
              humansSeated: 0,
              humansWaiting: 1,
              waitlistOldestJoinedAtMs: NOW - 10 * 60_000,
              status: 'running',
              seatedHorses: Array.from({ length: 6 }, (_, i) => ({
                horseId: `h${i}`,
                sittingOut: false,
                minutesAtTable: 30,
                isRed: false,
                stack: 200,
              })),
            },
          ],
        },
      ],
    };
    const requests = yieldRequestsFor(snap);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.order.reason === 'human_yield')).toBe(true);
    expect(requests.every((r) => r.waitingSinceMs === NOW - 10 * 60_000)).toBe(true);
  });

  it('a table with nobody waiting produces no yield at all', () => {
    const snap: FloorSnapshot = {
      chicagoHour: 13,
      chicagoMinute: 0,
      killed: false,
      hosts: [
        {
          hostId: MIDWAY_UNION_ID,
          n: 584,
          uniqueLive: 200,
          tables: [
            {
              tableId: 'quiet',
              hostId: MIDWAY_UNION_ID,
              variant: 'nlh',
              sb: 1,
              bb: 2,
              maxPlayers: 6,
              occupied: 6,
              humansSeated: 0,
              humansWaiting: 0,
              status: 'running',
              seatedHorses: [],
            },
          ],
        },
      ],
    };
    expect(yieldRequestsFor(snap)).toHaveLength(0);
  });
});

describe('SOURCE LAW: the executor cannot reach a seat row', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandExecutor.ts'), 'utf8');
  /* The ban is on CODE, not on prose. The header explains at length which
     doors this module must not open, and naming them there is the point. */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('stands a horse up ONLY through engine.leaveTable', () => {
    expect(src).toMatch(/engine\.leaveTable\(/);
  });

  it('never calls a cash-out RPC or touches table_seats directly', () => {
    // Deleting a table_seats row skips the refund and destroys the chips
    // (CLAUDE.md 11.5 rule 3). leaveTable is the only door.
    for (const banned of [
      'atomicCashout',
      'markSeatAsLeft',
      'atomic_seat_cashout_locked',
      'fn_leave_seat_and_refund',
      "from('table_seats')",
      'player_leave_table',
    ]) {
      expect(src, `${banned} must not appear in the executor`).not.toContain(banned);
    }
  });

  it('never prints chips', () => {
    for (const banned of ['grantChips', 'topUp', 'adminReload', 'fn_add_chips']) {
      expect(src).not.toContain(banned);
    }
  });

  it('gates the cycle on the freeze before any I/O', () => {
    const gate = src.indexOf('if (isMaintenanceFrozen()) return 0;');
    const firstIo = src.indexOf('await buildFloorSnapshot()');
    expect(gate).toBeGreaterThan(-1);
    expect(firstIo).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstIo);
  });

  it('the kill switch does NOT stop a yield', () => {
    // A kill switch that strands a waiting human is not a safety feature, it
    // is a second outage. `killed()` is never consulted here; planFloor runs
    // its yield pass even when the snapshot is killed.
    expect(src).not.toMatch(/\bkilled\(\)/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE WIND-DOWN: the floor walks onto the curve, it does not drop onto it
   ══════════════════════════════════════════════════════════════════════════ */

import {
  ripeWindDowns,
  standOrdersFor,
  MAX_WIND_DOWN_PER_HOST_PER_CYCLE,
  type WindDownRequest,
} from './StableHandExecutor.js';
import { DSS_CLUB_ID } from './StableHand.js';

const wind = (hostId: string, i: number): WindDownRequest => ({
  order: order({
    tableId: `${hostId}-t${i}`,
    horseId: `${hostId}-h${i}`,
    reason: 'occupancy_wind_down',
    delayMs: 0,
  }),
  hostId,
});

/** A host far above its curve at 03:00 Chicago, with nobody waiting. */
const overCapSnapshot = (over: Partial<FloorSnapshot> = {}): FloorSnapshot => ({
  chicagoHour: 3,
  chicagoMinute: 0,
  killed: false,
  hosts: [
    {
      hostId: MIDWAY_UNION_ID,
      n: 584,
      uniqueLive: 187,
      tables: Array.from({ length: 20 }, (_, i) => ({
        tableId: `t${i}`,
        hostId: MIDWAY_UNION_ID,
        variant: 'nlh',
        sb: 1,
        bb: 2,
        maxPlayers: 6,
        occupied: 6,
        humansSeated: 0,
        humansWaiting: 0,
        status: 'running',
        seatedHorses: Array.from({ length: 6 }, (_, k) => ({
          horseId: `t${i}-h${k}`,
          sittingOut: false,
          minutesAtTable: 30,
          isRed: false,
          stack: 200,
        })),
      })),
    },
  ],
  ...over,
});

describe('the per-host wind-down ceiling', () => {
  it('stands at most the ceiling per host per cycle', () => {
    const many = Array.from({ length: 20 }, (_, i) => wind(MIDWAY_UNION_ID, i));
    const r = ripeWindDowns(many, NOW, new Map());
    expect(r.execute).toHaveLength(MAX_WIND_DOWN_PER_HOST_PER_CYCLE);
    expect(r.heldByCap).toBe(20 - MAX_WIND_DOWN_PER_HOST_PER_CYCLE);
  });

  it('counts each host separately - one busy host does not starve the other', () => {
    const both = [
      ...Array.from({ length: 10 }, (_, i) => wind(MIDWAY_UNION_ID, i)),
      ...Array.from({ length: 10 }, (_, i) => wind(DSS_CLUB_ID, i)),
    ];
    const r = ripeWindDowns(both, NOW, new Map());
    expect(r.execute.filter((x) => x.hostId === MIDWAY_UNION_ID)).toHaveLength(
      MAX_WIND_DOWN_PER_HOST_PER_CYCLE
    );
    expect(r.execute.filter((x) => x.hostId === DSS_CLUB_ID)).toHaveLength(
      MAX_WIND_DOWN_PER_HOST_PER_CYCLE
    );
  });

  it('defers rather than drops - what is held is planned again next cycle', () => {
    // The plan is recomputed from the floor every cycle, so a held order is
    // not a lost one. This pins the SHAPE of the return: held, not discarded.
    const many = Array.from({ length: 9 }, (_, i) => wind(MIDWAY_UNION_ID, i));
    const r = ripeWindDowns(many, NOW, new Map());
    expect(r.execute.length + r.heldByCap).toBe(9);
  });

  it('respects the settling cooldown, keyed by seat', () => {
    const w = wind(MIDWAY_UNION_ID, 0);
    const last = new Map([[yieldKey(w.order), NOW - 1000]]);
    const r = ripeWindDowns([w], NOW, last);
    expect(r.execute).toHaveLength(0);
    expect(r.heldByCooldown).toBe(1);
  });

  it('ignores a human_yield order - that pass has its own rules', () => {
    const y: WindDownRequest = { order: order(), hostId: MIDWAY_UNION_ID };
    expect(ripeWindDowns([y], NOW, new Map()).execute).toHaveLength(0);
  });

  it('one table never loses more than one seat per cycle', () => {
    // The planner picks a single victim per table; this pins that the executor
    // does not undo it by batching two orders for one table.
    const orders = standOrdersFor(overCapSnapshot()).windDowns;
    const perTable = new Map<string, number>();
    orders.forEach((o) => perTable.set(o.order.tableId, (perTable.get(o.order.tableId) ?? 0) + 1));
    expect(Math.max(...perTable.values())).toBe(1);
  });
});

describe('standOrdersFor splits the plan into its two urgencies', () => {
  it('a host above its curve at 3am produces wind-downs and no yields', () => {
    const o = standOrdersFor(overCapSnapshot());
    expect(o.windDowns.length).toBeGreaterThan(0);
    expect(o.yields).toHaveLength(0);
    expect(o.windDowns.every((w) => w.hostId === MIDWAY_UNION_ID)).toBe(true);
  });

  it('THE KILL SWITCH STOPS A WIND-DOWN AND NOT A YIELD', () => {
    const killed = standOrdersFor(overCapSnapshot({ killed: true }));
    expect(killed.windDowns).toHaveLength(0);

    // The same killed floor, with one human waiting, still yields.
    const withHuman = overCapSnapshot({ killed: true });
    withHuman.hosts[0].tables[0].humansWaiting = 1;
    withHuman.hosts[0].tables[0].waitlistOldestJoinedAtMs = NOW - 10 * 60_000;
    expect(standOrdersFor(withHuman).yields.length).toBeGreaterThan(0);
  });

  it('a host whose population could not be read produces neither', () => {
    const unknown = overCapSnapshot();
    unknown.hosts[0].n = 0;
    const o = standOrdersFor(unknown);
    expect(o.windDowns).toHaveLength(0);
    expect(o.alerts.some((a) => a.startsWith('host_population_unknown'))).toBe(true);
  });
});
