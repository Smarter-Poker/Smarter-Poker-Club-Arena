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
