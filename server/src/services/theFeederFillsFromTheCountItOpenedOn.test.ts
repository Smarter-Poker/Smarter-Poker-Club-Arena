/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FEEDER FILLS FROM THE COUNT IT OPENED ON (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ClusterController opens a feeder on the strength of the fleet's buyer
 * count (OPORD 1.4 18.3: a horse is a buyer). The launcher audit Dan ordered
 * on 2026-09-06 read the fleet heartbeat for one afternoon and found the
 * count and the chair disagreeing in four independent ways, each of which
 * left an opening feeder empty until the six-minute abandon, the two-minute
 * rest, and the same open again:
 *
 *   1. the buy-in was rolled with Math.random() on EVERY sizing, and the
 *      aggregate-exposure ceiling reads the roll - "selected 2, seated 0,
 *      skipped {aggregate_exposure=5}";
 *   2. the activity window dropped the buyers the feeder was opened on -
 *      "candidates 6, sittable 4, selected 1, seated 0,
 *      skipped {lone_seat_refused: 1}", the same line for thirty minutes;
 *   3. the lone-seat rule was judged on how many CLEARED the verdict, and a
 *      buy-in the door refused left one horse alone on a feeder that is then
 *      never abandoned, never promoted and never broken;
 *   4. a feeder that claimed ZERO buyers still clamped its game's probe to
 *      zero for the rest of the cycle.
 *
 * Plus three the same read found beside them: a buyer census that never aged
 * (a fleet that could not read the floor kept promising buyers), a session
 * start balance that could never be recorded, a tag whose every stake named
 * a closed game refusing every table, a planner open order that would have
 * re-enabled an operator-closed game, and a seating table claiming a whole
 * table of shared horse capacity for the one or two seats it would fill.
 *
 * The arithmetic is asserted on the real functions where they are pure; the
 * seeding path is asserted as a source contract, because seatHorse ends in
 * atomic_table_buyin against production (theFeederKeepsItsBuyers.test.ts
 * makes the same choice for the same reason).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buyInBBFor } from './HorseBehavior.js';
import { allocateBuyers, FULL_TABLE_BUYER_PROBE } from './HorseBuyerAllocation.js';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
const SEED = SRC.slice(
  SRC.indexOf('private async seedAllTables('),
  SRC.indexOf('\n  private async ', SRC.indexOf('private async seedAllTables(') + 1)
);
const BUY_IN = SRC.slice(
  SRC.indexOf('private computeHorseBuyIn('),
  SRC.indexOf('private async seatHorse(')
);
const OPEN_PLANNED = SRC.slice(
  SRC.indexOf('private async openPlannedTables('),
  SRC.indexOf('/* spawnOverflowTables is GONE')
);

describe('1. the buy-in is one roll per sitting, so the count and the chair size the same number', () => {
  it('the same sitting returns the same buy-in, every time', () => {
    for (const id of ['horse-a', 'horse-b', 'horse-c', 'horse-d', 'horse-e']) {
      const first = buyInBBFor(id, 'table-1|1757170800000');
      for (let i = 0; i < 20; i++) expect(buyInBBFor(id, 'table-1|1757170800000')).toBe(first);
    }
  });

  it('a different sitting can still roll differently - the jitter is per sitting, not gone', () => {
    const seen = new Set<number>();
    for (let cycle = 0; cycle < 40; cycle++) seen.add(buyInBBFor('horse-a', `table-1|${cycle}`));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('every roll stays inside the profile band the id hash chose', () => {
    for (let cycle = 0; cycle < 200; cycle++) {
      const bb = buyInBBFor('horse-a', `t|${cycle}`);
      expect(bb).toBeGreaterThanOrEqual(40);
      expect(bb).toBeLessThanOrEqual(200);
    }
  });

  it('the fleet sizes with the table id and the cycle seed, set once at the top of the cycle', () => {
    expect(BUY_IN).toContain('buyInBBFor(horseId, `${String(table.id)}|${this.cycleSittingSeed}`)');
    expect(SEED).toContain('this.cycleSittingSeed = String(cycleStartedAt);');
    expect(BUY_IN).not.toContain('buyInBBFor(horseId)');
  });
});

describe('2. an opening feeder widens the hour, as a human rescue does', () => {
  it('the activity window never leaves a feeder short of the two it is promoted at', () => {
    expect(SEED).toContain(
      'if (openingFeeder && pool.length < FEEDER_BUYERS_TO_GO_LIVE) pool = sittable;'
    );
    // Ordered AFTER the human-rescue widening and BEFORE the pool is handed
    // to the allocation and the selection.
    const rescue = SEED.indexOf(
      'if (pool.length < emptySeats.length && humanNeedsRescue) pool = sittable;'
    );
    const feeder = SEED.indexOf(
      'if (openingFeeder && pool.length < FEEDER_BUYERS_TO_GO_LIVE) pool = sittable;'
    );
    const handed = SEED.indexOf('pool: pool.map((h) => h.id)');
    expect(rescue).toBeGreaterThan(0);
    expect(feeder).toBeGreaterThan(rescue);
    expect(handed).toBeGreaterThan(feeder);
  });
});

describe('3. no lone horse, judged on the outcome', () => {
  it('every seat goes through ONE closure, and the session start is read before the seat is added', () => {
    expect(SEED).toContain('const seatOne = async (');
    const closure = SEED.slice(
      SEED.indexOf('const seatOne = async ('),
      SEED.indexOf('const seatedIdsHere')
    );
    const wasIdle = closure.indexOf(
      'const wasIdle = (horseTables.get(horse.id)?.size ?? 0) === 0;'
    );
    const seatCall = closure.indexOf('await this.seatHorse(');
    const added = closure.indexOf('horseTables.get(horse.id)!.add(table.id);');
    expect(wasIdle).toBeGreaterThan(0);
    expect(seatCall).toBeGreaterThan(wasIdle);
    expect(added).toBeGreaterThan(seatCall);
    expect(closure).toContain('...(wasIdle && seatClub');
    // The old, unreachable test is gone.
    expect(SEED).not.toContain('((horseTables.get(horse.id)?.size ?? 0) === 0 && seatClub');
  });

  it('an empty cluster table that ends with ONE seated draws again from the pool, then says so', () => {
    const draw = SEED.slice(
      SEED.indexOf('NO LONE HORSE, JUDGED ON THE OUTCOME'),
      SEED.indexOf('if (diag) diag.seated = seated;')
    );
    expect(draw).toContain(
      'if (table.cluster_id && currentCount === 0 && seated === 1 && seatBudget > 0)'
    );
    expect(draw).toContain('for (const h of pool)');
    expect(draw).toContain('if (tried.has(h.id)) continue;');
    expect(draw).toContain('const v = sitVerdictFor(h.id, table, sitCtx);');
    expect(draw).toContain('if (await seatOne(h, chair, v)) seatedIdsHere.add(h.id);');
    expect(draw).toContain("noteSkip(diag, 'lone_seat_left');");
    // A second-draw horse reaches the allocation like any other seated one.
    expect(SEED).toContain('const seatedIds = seatedIdsHere;');
  });
});

describe('4. a reservation of zero is not a reservation', () => {
  it('a feeder that claims nothing does not clamp its game probe to zero', () => {
    // The feeder already has two seated (seatsWanted 0); Main 1 is full and
    // probes for two. Before: the probe reported min(0, 2) = 0 buyers.
    const out = allocateBuyers(
      [
        {
          tableId: 'feeder',
          clusterId: 'g1',
          pool: ['h1', 'h2', 'h3'],
          claim: 'reserved',
          seatsWanted: 0,
        },
        {
          tableId: 'main1',
          clusterId: 'g1',
          pool: ['h1', 'h2', 'h3'],
          claim: 'probe',
          seatsWanted: FULL_TABLE_BUYER_PROBE,
        },
      ],
      new Map([
        ['h1', 4],
        ['h2', 4],
        ['h3', 4],
      ])
    );
    expect(out.get('feeder')).toBe(0);
    expect(out.get('main1')).toBe(FULL_TABLE_BUYER_PROBE);
  });

  it('a feeder that DOES hold a claim still clamps the probe to that claim', () => {
    const out = allocateBuyers(
      [
        {
          tableId: 'feeder',
          clusterId: 'g1',
          pool: ['h1', 'h2', 'h3'],
          claim: 'reserved',
          seatsWanted: 1,
        },
        {
          tableId: 'main1',
          clusterId: 'g1',
          pool: ['h1', 'h2', 'h3'],
          claim: 'probe',
          seatsWanted: FULL_TABLE_BUYER_PROBE,
        },
      ],
      new Map([
        ['h1', 4],
        ['h2', 4],
        ['h3', 4],
      ])
    );
    expect(out.get('feeder')).toBe(1);
    expect(out.get('main1')).toBe(1);
  });
});

describe('5. the buyer census ages out instead of being repeated to the controller', () => {
  it('the census is stamped ONLY after a full walk, and both readers answer nothing when it is stale', () => {
    expect(SRC).toContain('export const ELIGIBLE_MAX_AGE_MS = 5 * 60 * 1000;');
    expect((SRC.match(/this\.lastEligibleBuiltAt = Date\.now\(\);/g) || []).length).toBe(1);
    const stamp = SEED.indexOf('this.lastEligibleBuiltAt = Date.now();');
    const swap = SEED.indexOf('this.lastEligibleByTable = nextEligible;');
    expect(stamp).toBeGreaterThan(swap);
    const count = SRC.slice(
      SRC.indexOf('eligibleHorseCount(tableId: string): number {'),
      SRC.indexOf('eligibleCounts(): ReadonlyMap')
    );
    expect(count).toContain('if (this.censusIsStale()) return 0;');
    const all = SRC.slice(
      SRC.indexOf('eligibleCounts(): ReadonlyMap'),
      SRC.indexOf('private censusIsStale(')
    );
    expect(all).toContain('if (this.censusIsStale()) return EMPTY_CENSUS;');
  });
});

describe('6. a tag whose every stake names a closed game falls through to the merit band', () => {
  it('the exact-blind set is built beside the band set, from the same tables', () => {
    expect(SEED).toContain('const stakesWithAGame = new Set<string>();');
    expect(SEED).toContain('stakesWithAGame.add(Number(t.big_blind).toFixed(2));');
  });

  it('the fallthrough happens only when NO tagged stake has a game, and only to undefined', () => {
    const gate = SEED.slice(
      SEED.indexOf('let stakeOk = tagAllowsStake('),
      SEED.indexOf('if (stakeOk === undefined && !stakeBandAllows(')
    );
    expect(gate).toContain(
      '!tag.preferredStakes.some((s) => stakesWithAGame.has(Number(s).toFixed(2)))'
    );
    expect(gate).toContain('stakeOk = undefined;');
    expect(gate).toContain('strandedTagFallthrough++;');
    // The hard refusal is still there for a tag that names a running stake.
    expect(gate).toContain('if (stakeOk === false && !humanNeedsRescue) {');
  });
});

describe('7. an operator close outranks a planner open', () => {
  it('a disabled key is read and refused before fn_cash_game_ensure can re-enable it', () => {
    const read = OPEN_PLANNED.indexOf(".eq('enabled', false)");
    const ensure = OPEN_PLANNED.indexOf("supabase.rpc('fn_cash_game_ensure'");
    expect(read).toBeGreaterThan(0);
    expect(ensure).toBeGreaterThan(read);
    expect(OPEN_PLANNED).toContain('if (closedGame) {');
    // A read that fails does not reopen either.
    expect(OPEN_PLANNED).toContain(
      'continue; // cannot tell whether a human closed it: do not reopen'
    );
  });
});

describe('8. a seating table claims what it will seat', () => {
  it('the seating claim is bounded by seatsNeeded, never the whole table', () => {
    expect(SEED).toContain(
      'Math.max(0, Math.min(seatsNeeded, Number(table.max_players) - currentCount))'
    );
    expect(SEED).not.toContain(
      ': Math.max(0, Number(table.max_players) - currentCount),\n            };'
    );
  });
});
