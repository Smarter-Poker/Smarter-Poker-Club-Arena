/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TOURNAMENT SEAT IS NOT CASH EXPOSURE, AND IT STILL DECIDES THE WALLET
 * (2026-09-09, horse-trigger audit, lane A)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three defects in the seeding cycle, all from the same root: `allActiveSeats`
 * is EVERY open seat on the platform, tournament chairs included, and three
 * readers of it drew the wrong line between a tournament seat and a cash one.
 *
 *  1. `horseExposure` summed tournament STACKS as chips at risk against the
 *     club bankroll. A 5,000 starting stack (median that day; 840,000 at the
 *     top) against an aggregate ceiling of roll x 5% x 4 refused every horse
 *     in an event at the sit verdict: `aggregate_exposure=265` on every cycle
 *     line while 501 horses sat in tournaments and the cash floor emptied.
 *  2. `seatClubInScope` read the CASH tables only, while the database's "one
 *     club at a time" rule (fn_seat_club_for_user_membership_unchecked) reads
 *     a held seat at ANY table of the union - and Midway Union tournament
 *     tables carry the union id. 448 of 584 Midway horses held such a seat;
 *     the engine saw 24; for 145 the engine gated, sized and tagged on one
 *     wallet and the database debited the other.
 *  3. The Stable Hand game key was built from the TABLE NAME, so a must-move
 *     between "X", "X Feeder" and "X Main 2" was a seat GIVEN UP: 1,438 moves
 *     in 90 minutes, "5-9 seat(s) given up, 0 sit(s)" every 30 seconds.
 *
 * Source contract for the wiring; the key rule is exercised directly.
 */
import { describe, it, expect } from 'vitest';
import { sliceStatement } from '../testHelpers/sourceWindow.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gameKeyForTable } from './HorseSitVerdict.js';
import { MIDWAY_UNION_ID } from './StableHand.js';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
const VERDICT = readFileSync(join(process.cwd(), 'src/services/HorseSitVerdict.ts'), 'utf8');

const SEED = SRC.slice(
  SRC.indexOf('private async seedAllTables('),
  SRC.indexOf('\n  private async ', SRC.indexOf('private async seedAllTables(') + 1)
);

describe('1. exposure is what a horse bought into CASH tables with', () => {
  it('the exposure sum skips every seat whose table is not on the open cash floor', () => {
    const block = SEED.slice(
      SEED.indexOf('const horseExposure = new Map<string, number>();'),
      SEED.indexOf('// Optimization: Fetch all horses once')
    );
    expect(block).toContain(
      'const openCashTableIds = new Set<string>(tables.map((t) => String(t.id)));'
    );
    // the skip sits BETWEEN the table-set add (every seat) and the stack add (cash only)
    const tablesAt = block.indexOf('horseTables.get(seat.user_id)!.add(seat.table_id);');
    const skipAt = block.indexOf('if (!openCashTableIds.has(String(seat.table_id))) continue;');
    const stackAt = block.indexOf(
      'horseExposure.set(seat.user_id, (horseExposure.get(seat.user_id) ?? 0) + st);'
    );
    expect(tablesAt).toBeGreaterThan(-1);
    expect(skipAt).toBeGreaterThan(tablesAt);
    expect(stackAt).toBeGreaterThan(skipAt);
  });

  it('the four-game limit still counts every seat (the database does)', () => {
    // `horseTables` feeds `gameLoad.seats`, which mirrors fn_concurrent_game_load
    // clause (1): every live seat, tournament or cash. Unchanged.
    expect(SEED).toContain('seats: tablesForHorse?.size ?? 0,');
  });

  it('the beat carries the cash floor count beside the platform-wide one', () => {
    expect(SEED).toContain('beat.horsesSeatedCash = seatedCashHorseCount;');
    expect(SRC).toContain('horses_seated_cash: beat.horsesSeatedCash,');
  });
});

describe('2. a held tournament seat in the union decides the wallet, as the database rules', () => {
  it('the tournament-table read carries the scope columns', () => {
    /* The slice runs to where the read is CONSUMED, not to the next read's
       label: the scope map is filled in the same block that builds
       `tournamentByTableId`, which sits after the tournamentTables page. */
    const from = SEED.indexOf("label: 'HorseFleet.tournamentBookings'");
    const to = SEED.indexOf('bookingLoad = buildBookingLoad(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const read = SEED.slice(from, to);
    expect(read).toContain(".select('id, tournament_id, union_id, club_id, status')");
    expect(read).toContain(
      "tournamentTableScope.set(row.id, String(row.union_id ?? row.club_id ?? ''));"
    );
  });

  it("the history statuses are the function's own four, verbatim", () => {
    expect(SRC).toMatch(
      /HELD_SEAT_HISTORY_STATUSES: ReadonlySet<string> = new Set\(\[\s*'closed',\s*'completed',\s*'cancelled',\s*'finished',\s*\]\)/
    );
    expect(SEED).toContain(
      "if (!HELD_SEAT_HISTORY_STATUSES.has(String(row.status ?? '').toLowerCase()))"
    );
  });

  it('the scope build asks the cash floor first and the tournament tables second', () => {
    const block = SEED.slice(
      SEED.indexOf('const scopeOfSeatTable = '),
      SEED.indexOf('const membership: SeatClubContext = {')
    );
    expect(block).toContain('const t = tableById.get(tableId);');
    expect(block).toContain('return tournamentTableScope.get(tableId);');
    expect(block).toContain('const scope = scopeOfSeatTable(seat.table_id);');
    expect(block).toContain('if (scope === undefined || !seat.club_id) continue;');
    // and the earliest seat still wins, exactly as `ORDER BY ts.joined_at ASC NULLS LAST`
    expect(block).toContain('if (prev !== undefined && prev <= joined) continue;');
  });
});

describe('3. the Stable Hand game key is the GAME, not the table', () => {
  const base = {
    id: 't1',
    club_id: MIDWAY_UNION_ID,
    union_id: MIDWAY_UNION_ID,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
  };

  it('three tables of one must-move game share one key', () => {
    const cluster = 'b59525f3-1f0c-486b-b3f9-578c17f866ad';
    const main = gameKeyForTable({ ...base, name: 'NLH 1/2 Classic', cluster_id: cluster });
    const feeder = gameKeyForTable({
      ...base,
      id: 't2',
      name: 'NLH 1/2 Classic Feeder',
      cluster_id: cluster,
    });
    const main2 = gameKeyForTable({
      ...base,
      id: 't3',
      name: 'NLH 1/2 Classic Main 2',
      cluster_id: cluster,
    });
    expect(feeder).toBe(main);
    expect(main2).toBe(main);
    expect(main).toBe(`${MIDWAY_UNION_ID}:${cluster}:nlh:1:2`);
  });

  it('a different game is a different key, and a table outside any game keeps its name', () => {
    const a = gameKeyForTable({ ...base, name: 'NLH 1/2 Classic', cluster_id: 'game-a' });
    const b = gameKeyForTable({ ...base, name: 'NLH 1/2 Classic', cluster_id: 'game-b' });
    expect(a).not.toBe(b);
    const legacy = gameKeyForTable({ ...base, name: 'NLH 1/2 Legacy' });
    expect(legacy).toBe(`${MIDWAY_UNION_ID}:NLH 1/2 Legacy:nlh:1:2`);
  });

  it('both callers - the mutex and the seat-key diff - use the one function', () => {
    expect(VERDICT).toContain('const key = gameKeyForTable(table);');
    expect(SEED).toContain('const key = gameKeyForTable(t);');
    expect(SRC).not.toMatch(/template: String\(t(?:able)?\.name/);
    expect(VERDICT).not.toMatch(/template: String\(table\.name/);
  });
});

describe('4. the window is reported, and a table that cannot deal takes the whole sittable pool', () => {
  it('counts the sleeping share of every sittable pool and names it on the no-horses line', () => {
    expect(SEED).toContain('asleepDropped += sittable.length - pool.length;');
    expect(SEED).toMatch(
      /No available horses for[\s\S]{0,400}sittable \$\{sittable\.length\}, asleep \$\{asleepHere\}/
    );
    expect(SEED).toContain('asleep: asleepDropped,');
  });

  it('an empty or lone cluster table widens the hour when the awake pool cannot reach two', () => {
    const rescue = SEED.indexOf(
      'if (pool.length < emptySeats.length && humanNeedsRescue) pool = sittable;'
    );
    const feeder = SEED.indexOf(
      'if (openingFeeder && pool.length < FEEDER_BUYERS_TO_GO_LIVE) pool = sittable;'
    );
    const dealable = SEED.indexOf(
      'if (seedToDealable && !openingFeeder && pool.length < DEALABLE_MINIMUM) {'
    );
    const handed = SEED.indexOf('pool: pool.map((h) => h.id)');
    expect(rescue).toBeGreaterThan(0);
    expect(feeder).toBeGreaterThan(rescue);
    expect(dealable).toBeGreaterThan(feeder);
    expect(handed).toBeGreaterThan(dealable);
    // never the band, never the verdict: it is `sittable` that is handed over,
    // read from the statement itself rather than a byte window
    // (tests/unit/noFixedSizeSourceWindows).
    expect(sliceStatement(SEED.slice(dealable), 'if (seedToDealable')).toContain(
      'pool = sittable;'
    );
  });

  it('the own-ceiling refusal is counted, so no gate in the candidate filter is silent', () => {
    expect(SEED).toMatch(/bookedOutDropped\+\+;\s*\} else \{\s*ownCeilingDropped\+\+;/);
    expect(SEED).toContain('own_ceiling: ownCeilingDropped,');
  });
});

describe('5. the heartbeat carries every gate the cycle line prints', () => {
  it('detail.gates is built from the same counters', () => {
    for (const key of [
      'no_membership: clubDropped',
      'tag: tagDropped',
      'rest_day: restDayDropped',
      'daily_cap: dailyCapDropped',
      'host_cap: hostCapRefused',
      'booked_out: bookedOutDropped',
      'lone_seat_refused: loneSeatRefused',
      'unsittable: record(unsittable)',
      'mutex_refused: record(mutexRefused)',
      'buy_in_refused: record(buyInRefused)',
      'bankroll: bankrollThisCycle',
    ]) {
      expect(SEED).toContain(key);
    }
    expect(SRC).toContain('gates: beat.gates,');
  });

  it('the seating-status flip only ever lifts a waiting row', () => {
    expect(SEED).toMatch(
      /\.update\(\{ status: 'running' \}\)\s*\.eq\('id', table\.id\)\s*\.eq\('status', 'waiting'\);/
    );
    /* The old predicate must be gone from the CODE. It is still named in the
       comment above the new one, which is where an explanation belongs, so
       the assertion reads the source with its comments stripped. */
    const code = SEED.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(code).not.toContain(".neq('status', 'running')");
  });

  it('the seat-offer read is paged like every other read of the queue', () => {
    const claim = SRC.slice(
      SRC.indexOf('private async claimOfferedSeats('),
      SRC.indexOf('private computeHorseBuyIn(')
    );
    expect(claim).toContain("label: 'HorseFleet.offeredSeats'");
    expect(claim).toMatch(
      /\.eq\('status', 'notified'\)\s*\.order\('id', \{ ascending: true \}\)\s*\.limit\(want\)/
    );
    expect(claim).not.toContain('const { data: offers, error }');
  });
});
