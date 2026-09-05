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

describe('the hold stops a settling seat being re-ordered every cycle', () => {
  /* The map is a NOT-BEFORE, not a last-ordered-at. An ordinary stand settles
     inside the cooldown; one refused by the chip-continuity stay clock knows
     exactly when it lifts, and those are not the same wait. */
  it('holds a seat whose hold has not expired', () => {
    const o = order();
    const hold = new Map([[yieldKey(o), NOW + 90_000]]);
    const r = ripeYields([req(o, 5 * 60_000)], NOW, hold);
    expect(r.execute).toHaveLength(0);
    expect(r.heldByCooldown).toBe(1);
  });

  it('releases it the moment the hold expires', () => {
    const o = order();
    expect(
      ripeYields([req(o, 5 * 60_000)], NOW, new Map([[yieldKey(o), NOW]])).execute
    ).toHaveLength(1);
    expect(
      ripeYields([req(o, 5 * 60_000)], NOW, new Map([[yieldKey(o), NOW + 1]])).execute
    ).toHaveLength(0);
  });

  it('the ordinary cooldown is longer than any cash hand, because leaveTable defers mid-hand', () => {
    expect(YIELD_COOLDOWN_MS).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it('the key is the SEAT, not the horse - a horse plays four tables at once', () => {
    expect(yieldKey(order({ tableId: 'a' }))).not.toBe(yieldKey(order({ tableId: 'b' })));
    const hold = new Map([[yieldKey(order({ tableId: 'a' })), NOW + 60_000]]);
    const r = ripeYields(
      [req(order({ tableId: 'a' }), 5 * 60_000), req(order({ tableId: 'b' }), 5 * 60_000)],
      NOW,
      hold
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

  it('respects the settling hold, keyed by seat', () => {
    const w = wind(MIDWAY_UNION_ID, 0);
    const hold = new Map([[yieldKey(w.order), NOW + 1000]]);
    const r = ripeWindDowns([w], NOW, hold);
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

/* ══════════════════════════════════════════════════════════════════════════
   THE TWO TABLE FLAGS

   Dan 2026-09-04: "yes close all those tables. drain first, and never kick
   anyone." The executor does not close a table itself - it marks it, and the
   fleet's own drain and retirement pass do the rest, closing it only once it
   is genuinely empty.
   ══════════════════════════════════════════════════════════════════════════ */
describe('SOURCE LAW: closing is marking, and the two flags never swap', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandExecutor.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('the permanent list gets retire_when_empty and the night list gets night_parked', () => {
    expect(src).toContain("export const RETIRE_FLAG = 'retire_when_empty';");
    expect(src).toContain("export const NIGHT_PARK_FLAG = 'night_parked';");
    expect(src).toContain('this.setTableFlag(plan.close, RETIRE_FLAG');
    expect(src).toContain('this.setTableFlag(plan.park, NIGHT_PARK_FLAG');
  });

  it('NEVER writes the permanent flag from the night list, or the reverse', () => {
    // retire_when_empty is permanent by design - ensureAllTablesExist refuses
    // to reopen a table carrying it. One quiet night written to that flag
    // would delete the floor.
    expect(src).not.toContain('plan.park, RETIRE_FLAG');
    expect(src).not.toContain('plan.close, NIGHT_PARK_FLAG');
  });

  it('never closes or deletes a table itself', () => {
    // The fleet's retirement pass closes a table only once it is EMPTY. If
    // this module wrote status directly it could close one under a hand.
    expect(src).not.toMatch(/status:\s*'closed'/);
    expect(src).not.toContain('.delete()');
  });

  it('MERGES settings rather than replacing them', () => {
    // straddle, auto_extension and every other table setting live in the same
    // column; a bare overwrite would wipe them.
    expect(src).toContain('{ ...settings, [flag]: true }');
  });

  it('waits for a clean read before writing a flag', () => {
    // A partial read is not "none of them are flagged" - writing on one would
    // re-flag rows every cycle forever.
    expect(src).toContain('if (!rows.complete) return 0;');
  });

  it('lifts the park on every cycle outside the night, and reopens what closed', () => {
    expect(src).toContain('await this.unparkTables();');
    expect(src).toContain("if (String(row.status) === 'closed') patch.status = 'waiting';");
    // and it deletes the flag rather than setting it false, so the row reads
    // exactly as it did before the park
    expect(src).toContain('delete settings[NIGHT_PARK_FLAG];');
  });

  it('only ever touches the two Stable Hand hosts', () => {
    expect(src).toContain("in('club_id', [MIDWAY_UNION_ID, DSS_CLUB_ID])");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   CHIP CONTINUITY: a horse ahead of its buy-in stays, like anybody else

   Operation Table Stakes slice 0 landed on main while this branch was open.
   leaveTable became async and now refuses with LEAVE_LOCKED and the
   milliseconds left on the stay clock when a player is up on the money they
   put in.
   ══════════════════════════════════════════════════════════════════════════ */
describe('SOURCE LAW: the stay clock is respected, never forced', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandExecutor.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('NEVER passes forced - a horse is held to the clock a human is held to', () => {
    /* CLAUDE.md 10.5: there is no "equal outcome by a different mechanism"
       exemption. A horse let out of a stay clock is exactly the thing Dan
       rejected outright. */
    // The interface DECLARES the opts (that is the engine's signature); the
    // call site must not pass them.
    expect(src).toContain('await engine.leaveTable(order.horseId);');
    expect(src).not.toMatch(/engine\.leaveTable\([^)]*forced/);
    expect(src).not.toContain('forced: true');
    // exactly one call site, and it takes exactly one argument
    const calls = src.match(/engine\.leaveTable\([^)]*\)/g) ?? [];
    expect(calls).toEqual(['engine.leaveTable(order.horseId)']);
  });

  it('AWAITS the stand - an un-awaited promise is truthy and every refusal would read as a success', () => {
    expect(src).toContain('const result = await engine.leaveTable(');
    expect(src.match(/await this\.stand\(/g)?.length).toBe(2);
  });

  it('holds a stay-locked seat until the clock lifts, not for a flat cooldown', () => {
    // Re-asking every thirty seconds is thirty refusals a minute for a seat
    // that answers the same way until the clock reaches zero.
    expect(src).toContain("if (result?.code === 'LEAVE_LOCKED') {");
    expect(src).toContain('this.holdUntil.set(key, nowMs + remaining + 1_000);');
  });

  it('does not log a stay clock as a failure', () => {
    // It is the rule working. It gets a counted, once-a-cycle line instead.
    const lockBranch = src.slice(
      src.indexOf("if (result?.code === 'LEAVE_LOCKED') {"),
      src.indexOf('this.holdUntil.set(key, nowMs + YIELD_COOLDOWN_MS);\n    console.warn')
    );
    expect(lockBranch).not.toContain('console.warn');
    expect(src).toContain('stand(s) held by a stay clock');
  });

  it('treats an unreadable remaining time as zero rather than as forever', () => {
    expect(src).toContain('Math.max(0, Number(result.stay_remaining_ms) || 0)');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   EVERY CYCLE STEP IS CALLED, NOT MERELY IMPORTED

   This suite exists because of a real, shipped, four-hour outage of the very
   feature built to notice outages. A refactor on 2026-09-04 rewrote the block
   around the stands and took the heartbeat write and the bank check out with
   it. The imports stayed. `checkBanks` stayed defined. Typecheck stayed clean.
   5,371 tests stayed green. And `stable_hand_beats` held ZERO rows through
   four hours of live running while every other order executed normally - the
   silence watch was itself silent, and nothing said so.

   An import is not a call, and a defined method is not a called one.
   ══════════════════════════════════════════════════════════════════════════ */
describe('SOURCE LAW: the cycle actually performs every step it imports', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandExecutor.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  /** Just the body of cycle(), so a call somewhere else does not satisfy it. */
  const cycle = (() => {
    const start = src.indexOf('async cycle(): Promise<number> {');
    expect(start, 'cycle() not found').toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n  }', src.indexOf('return stood;')));
  })();

  it('WRITES THE HEARTBEAT - the call that went missing', () => {
    expect(cycle).toContain('await writeBeats(');
    expect(cycle).toContain('buildBeats(snap, orders.plan');
  });

  it('CHECKS THE BANKS - the other call that went missing', () => {
    expect(cycle).toContain('await this.checkBanks(snap, now);');
  });

  it('applies the table flags', () => {
    expect(cycle).toContain('await this.applyTableFlags(');
  });

  it('publishes the plan for the seeder', () => {
    expect(cycle).toContain('publishPlan(orders.plan, now);');
  });

  it('clears the executed counters AFTER the beat, or every beat double-counts', () => {
    const beat = cycle.indexOf('await writeBeats(');
    const clear = cycle.indexOf('this.executedYields.clear();');
    expect(clear).toBeGreaterThan(beat);
    expect(cycle).toContain('this.executedWindDowns.clear();');
  });

  it('the beat is written AFTER the work, so it records what was done', () => {
    // A beat written before the stands would record intentions, and the gap
    // between planned and executed is the whole reason both are stored.
    expect(cycle.indexOf('await this.stand(')).toBeLessThan(cycle.indexOf('await writeBeats('));
  });

  it('leaves nothing imported-but-uncalled from the beats module', () => {
    // The generalised version of the bug: anything pulled in from
    // StableHandBeats must be used somewhere in this file's code.
    const imported =
      (src.match(/import \{([^}]*)\} from '\.\/StableHandBeats\.js'/) ?? [])[1] ?? '';
    const names = imported
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, ''))
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const uses = src.split(new RegExp(`\\b${n}\\b`)).length - 1;
      expect(uses, `${n} is imported but never used`).toBeGreaterThan(1);
    }
  });

  it('leaves no private method defined and never called', () => {
    const defined = [...src.matchAll(/private (?:async )?(\w+)\(/g)].map((m) => m[1]);
    expect(defined.length).toBeGreaterThan(0);
    for (const name of defined) {
      const called = src.includes(`this.${name}(`);
      expect(called, `${name}() is defined and never called`).toBe(true);
    }
  });
});
