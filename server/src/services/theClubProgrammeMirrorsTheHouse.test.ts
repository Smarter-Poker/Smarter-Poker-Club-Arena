/**
 * ═════════════════════════════════════════════════
 *  THE CLUB PROGRAMME MIRRORS THE HOUSE, AND THE THIRD SEAT WAITS FOR A HUMAN
 * ═════════════════════════════════════════════════
 *
 * Dan, 2026-09-03, eight rulings in one message. The ones that live in this
 * process are pinned here; the schedule mirror and the table closures are
 * migrations (20260903171313) and are verified against the database.
 *
 *   3. "ADD IN ALL THE SPINS (MIRROR MIDWAY UNION)" - a club board offers the
 *      same SPIN_CONFIGS the house does (its maxStake permitting), and it is
 *      never starved: the house used to spend the whole BURST first.
 *   4. "fleet should hold the seat for 90-350 seconds max before filling the
 *      3rd seat" - the human window is 90 to 350 seconds, in every place that
 *      hands one out.
 *   5. "ADD THE HIGHER STAKES FOR MIDWAY UNION, CAP IT AT 25-50."
 *   6. "SATELLITE SIT N GO'S ... A TICKET INTO BIGGER BUY IN MTT'S."
 *   7. "ALL MTT'S SHOULD BE ON A RECURRING WEEKLY CYCLE."
 *   2. "CLOSE ANY TABLES OVER 2/5" - the running ones drain through
 *      retire_when_empty rather than being cut off mid-hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SEAT_FIRST_HUMAN_WINDOW_MIN_MS,
  SEAT_FIRST_HUMAN_WINDOW_MAX_MS,
  boardBudgetShares,
  BOARD_BUDGET_FLOOR,
  satelliteHeadsUpBuyIn,
  satelliteHeadsUpName,
  pickSatelliteTargets,
  satelliteTargetIsDeliverable,
  SATELLITE_HU_MIN_TICKET,
  SATELLITE_HU_TARGET_LEAD_MS,
  SATELLITE_HU_TARGET_HORIZON_MS,
  SATELLITE_HU_TARGETS_PER_OWNER,
  type SatelliteTargetRow,
} from './TournamentRecurringService.js';
import {
  FRESH_HUMAN_WINDOW_MIN_S,
  FRESH_HUMAN_WINDOW_MAX_S,
} from './liveTournamentTableRecovery.js';
import {
  RESTART_WEEKLY_MINUTES,
  RESTART_MAX_MINUTES,
  restartCloneStartMs,
  RESTART_MIN_LEAD_MS,
} from './ScheduledTournamentService.js';
import { isRetiringTable } from './HorseBehavior.js';
import { buyInFor, rakeRateFor } from '../config/buyIn.js';
import { HEADS_UP_SEATS } from '../config/headsUpSpec.js';

const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);
const FLEET = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
const ROTATOR = readFileSync(join(process.cwd(), 'src/services/HorseSessionRotator.ts'), 'utf8');
const REPAIR_MIGRATION = readFileSync(
  join(
    process.cwd(),
    '../supabase/migrations/20260905104109_the_third_seat_waits_90_to_350_seconds_for_a_human.sql'
  ),
  'utf8'
);

/**
 * Dan 2026-09-05: "fleet should hold the seat for 90-350 seconds max before
 * filling the 3rd seat." Widened from 60-150 (Dan 2026-09-03) on the strength
 * of a measurement: in the seven days to 2026-09-05, 31,153 Spins ran on this
 * platform and FOUR of them had a human in them.
 *
 * All three surfaces still move together or none do. That is the whole reason
 * this block exists - the engine seating a horse at 90s while the repair sweep
 * hands the same board a 60s window is a race nobody would find by reading.
 */
describe('4. the third seat waits 90 to 350 seconds for a human', () => {
  it('the engine window is 90 to 350 seconds', () => {
    expect(SEAT_FIRST_HUMAN_WINDOW_MIN_MS).toBe(90_000);
    expect(SEAT_FIRST_HUMAN_WINDOW_MAX_MS).toBe(350_000);
  });
  it('the recovery window agrees', () => {
    expect(FRESH_HUMAN_WINDOW_MIN_S).toBe(90);
    expect(FRESH_HUMAN_WINDOW_MAX_S).toBe(350);
  });
  it('and so does the SQL repair (90 + [0, 260] seconds)', () => {
    expect(REPAIR_MIGRATION).toMatch(/v_window := 90 \+ floor\(random\(\) \* 261\)::int;/);
  });
  it('the three agree on the same pair of numbers, derived not retyped', () => {
    // A fourth statement of the same rule is a fourth thing to forget.
    expect(SEAT_FIRST_HUMAN_WINDOW_MIN_MS).toBe(FRESH_HUMAN_WINDOW_MIN_S * 1000);
    expect(SEAT_FIRST_HUMAN_WINDOW_MAX_MS).toBe(FRESH_HUMAN_WINDOW_MAX_S * 1000);
    const sql = /v_window := (\d+) \+ floor\(random\(\) \* (\d+)\)::int;/.exec(REPAIR_MIGRATION);
    expect(sql, 'the SQL window statement moved').toBeTruthy();
    expect(Number(sql![1])).toBe(FRESH_HUMAN_WINDOW_MIN_S);
    expect(Number(sql![1]) + Number(sql![2]) - 1).toBe(FRESH_HUMAN_WINDOW_MAX_S);
  });
});

describe('3. a club spin board is the house board, and cannot be starved', () => {
  it('every board gets a share of BURST before anyone spends', () => {
    expect(boardBudgetShares(1)).toBe(12);
    expect(boardBudgetShares(2)).toBe(6); // the house and Deep Stack Society
    expect(boardBudgetShares(3)).toBe(4);
    expect(boardBudgetShares(7)).toBe(BOARD_BUDGET_FLOOR);
    expect(boardBudgetShares(0)).toBe(12);
  });
  it('the house no longer spends first on a shared budget', () => {
    // The old shape: one `{ left: BURST }` threaded through the house call
    // and then `if (budget.left <= 0) break;` at the top of the owner loop.
    expect(RECURRING).not.toMatch(/const budget = \{ left: BURST \};/);
    // The owner loops hand each owner its own `{ left: share }`; the only
    // `budget.left` left in the file is ensureBoardOpen spending its own.
    for (const loop of RECURRING.split('for (const owner of owners) {').slice(1)) {
      const untilCall = loop.slice(0, loop.indexOf('await this.ensure'));
      expect(untilCall).not.toMatch(/budget\.left/);
    }
    expect(RECURRING).toMatch(/const share = boardBudgetShares\(owners\.length \+ 1\);/);
  });
  it('an owner board is the house SPIN_CONFIGS filtered only by its own stake cap', () => {
    expect(RECURRING).toMatch(/SPIN_CONFIGS\.filter\(\(c\) => c\.buyIn <= owner\.maxStake\)/);
  });
});

describe('5. the Midway ladder runs to 25/50 and no higher', () => {
  const block = /DEFAULT_TABLES: TableConfig\[\] = \[([\s\S]*?)\n\];/.exec(FLEET)?.[1] ?? '';
  const bigBlinds = [...block.matchAll(/bigBlind: ([0-9.]+),/g)].map((m) => Number(m[1]));
  it('has 5/10, 10/20 and 25/50 NLH plus PLO4 5/10', () => {
    expect(block).toMatch(/name: 'NLH 5\.00\/10\.00'/);
    expect(block).toMatch(/name: 'NLH 10\.00\/20\.00'/);
    expect(block).toMatch(/name: 'NLH 25\.00\/50\.00'/);
    expect(block).toMatch(/name: 'PLO4 5\.00\/10\.00'/);
  });
  it('caps at a 50 big blind', () => {
    expect(Math.max(...bigBlinds)).toBe(50);
  });
});

describe('6. satellite heads-ups pay a seat into a bigger event', () => {
  it('prices the minimum three-entry field to fund its promised ticket at standard MTT rake', () => {
    const rate = rakeRateFor({ tournamentType: 'SATELLITE' });
    for (const ticket of [20, 33, 44, 109, 200]) {
      const buyIn = satelliteHeadsUpBuyIn(ticket);
      expect(buyIn).toBeGreaterThan(0);
      expect(buyInFor(buyIn, rate).prize * 3).toBeGreaterThanOrEqual(ticket);
    }
    expect(satelliteHeadsUpBuyIn(0)).toBe(0);
    expect(satelliteHeadsUpBuyIn(1_000_000)).toBe(0);
  });
  it('names the feeder after its target', () => {
    expect(satelliteHeadsUpName('Sunday $200 Deep Stack')).toBe(
      'Sunday $200 Deep Stack Satellite'
    );
  });
  it('does not open an unlimited feeder into the old thirty-minute target window', () => {
    const now = Date.parse('2026-09-15T12:00:00Z');
    const target: SatelliteTargetRow = {
      id: 'main', name: 'Main Event', start_time: new Date(now + 30 * 60_000).toISOString(),
      buy_in_amount: 180, buy_in_fee: 20, variant: 'freezeout', tournament_type: 'MTT',
      max_players: null, is_bounty: false, is_pko: false, is_mystery_bounty: false,
      is_premium_spin: false,
    };
    expect(pickSatelliteTargets([target], now)).toEqual([]);
    expect(pickSatelliteTargets([{
      ...target, start_time: new Date(now + SATELLITE_HU_TARGET_LEAD_MS + 60_000).toISOString(),
    }], now)).toEqual([expect.objectContaining({ id: 'main' })]);
  });
  it('picks the dearest open events inside the window, one per name, never a seat-first game', () => {
    const now = Date.parse('2026-09-03T18:00:00Z');
    const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
    // The flags are read from the row; a feeder never assumes them.
    const plain = {
      is_bounty: false,
      is_pko: false,
      is_mystery_bounty: false,
      is_premium_spin: false,
    };
    const rows: SatelliteTargetRow[] = [
      {
        ...plain,
        id: 'a',
        name: 'Sunday $200 Deep Stack',
        start_time: at(70),
        buy_in_amount: 180,
        buy_in_fee: 20,
        variant: 'freezeout',
        max_players: 1000,
      },
      {
        ...plain,
        id: 'b',
        name: 'Sunday $200 Deep Stack',
        start_time: at(238),
        buy_in_amount: 180,
        buy_in_fee: 20,
        variant: 'freezeout',
        max_players: 1000,
      },
      {
        ...plain,
        id: 'c',
        name: 'Saturday Night Big Stack',
        start_time: at(50),
        buy_in_amount: 40,
        buy_in_fee: 4,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        ...plain,
        id: 'd',
        name: 'Friday Night Feature',
        start_time: at(30),
        buy_in_amount: 30,
        buy_in_fee: 3,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        ...plain,
        id: 'e',
        name: 'Turbo Tuesday Graveyard',
        start_time: at(20),
        buy_in_amount: 3,
        buy_in_fee: 0.3,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        ...plain,
        id: 'f',
        name: 'NLH Heads-Up 100',
        start_time: at(1),
        buy_in_amount: 95,
        buy_in_fee: 5,
        variant: 'sng',
        max_players: 2,
      },
      {
        ...plain,
        id: 'g',
        name: 'Sunday Deep Stack Satellite $25',
        start_time: at(40),
        buy_in_amount: 22.5,
        buy_in_fee: 2.5,
        variant: 'satellite',
        max_players: 100,
      },
      {
        ...plain,
        id: 'h',
        name: 'Starting Any Minute',
        start_time: at(0.25),
        buy_in_amount: 90,
        buy_in_fee: 10,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        ...plain,
        id: 'i',
        name: 'Next Month',
        start_time: at(24 * 9),
        buy_in_amount: 90,
        buy_in_fee: 10,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        ...plain,
        id: 'j',
        name: 'Union PKO Afternoon (PLO4)',
        start_time: at(60),
        buy_in_amount: 18,
        buy_in_fee: 2,
        variant: 'progressive_bounty',
        max_players: 80,
      },
    ];
    const picked = pickSatelliteTargets(rows, now);
    expect(picked.map((r) => r.id)).toEqual(['a', 'c', 'd']);
    expect(picked.length).toBe(SATELLITE_HU_TARGETS_PER_OWNER);
    expect(SATELLITE_HU_MIN_TICKET).toBe(20);
    expect(SATELLITE_HU_TARGET_LEAD_MS).toBe(3 * 60 * 60_000);
    expect(SATELLITE_HU_TARGET_HORIZON_MS).toBe(7 * 24 * 3_600_000);
  });
  it('never feeds an event the satellite finish refuses: bounty, PKO, mystery, Spin or unknown', () => {
    // 2026-09-11: the dearest weekly event was a PKO, so it got a feeder every
    // half hour and every finished feeder was refused at settlement
    // ("uses an unsupported bounty or Spin entry split").
    const now = Date.parse('2026-09-11T03:00:00Z');
    const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
    const plain = {
      is_bounty: false,
      is_pko: false,
      is_mystery_bounty: false,
      is_premium_spin: false,
    };
    const pko: SatelliteTargetRow = {
      id: '8171f9f6-1243-4d51-ac4b-9acabce110dc',
      name: 'Sunday Funday High Roller PKO',
      start_time: at(72),
      buy_in_amount: 67.5,
      buy_in_fee: 7.5,
      variant: 'progressive_bounty',
      max_players: 500,
      tournament_type: 'MTT',
      is_bounty: true,
      is_pko: true,
      is_mystery_bounty: false,
      is_premium_spin: false,
    };
    const main: SatelliteTargetRow = {
      ...plain,
      id: 'main',
      name: 'Sunday Funday Main Event',
      start_time: at(72),
      buy_in_amount: 45,
      buy_in_fee: 5,
      variant: 'freezeout',
      max_players: 500,
      tournament_type: 'MTT',
    };
    const refused: SatelliteTargetRow[] = [
      pko,
      { ...main, id: 'flat', name: 'Flat Bounty', is_bounty: true },
      { ...main, id: 'mystery', name: 'Mystery', is_mystery_bounty: true },
      { ...main, id: 'premium', name: 'Premium Spin', is_premium_spin: true },
      { ...main, id: 'spin-type', name: 'Spin Type', tournament_type: 'SPIN' },
      { ...main, id: 'bounty-variant', name: 'Bounty Variant', variant: 'bounty' },
      ...['bounty', 'progressive', 'progressive_bounty', 'pko', 'mystery', 'mystery_bounty'].flatMap((label) => [
        { ...main, id: `variant-${label}`, name: `Variant ${label}`, variant: ` ${label.toUpperCase()} ` },
        { ...main, id: `type-${label}`, name: `Type ${label}`, tournament_type: ` ${label.toUpperCase()} ` },
      ]),
      { ...main, id: 'unknown', name: 'Unknown Flags', is_pko: null },
      { ...main, id: 'unread', name: 'Unread Flags', is_bounty: undefined },
    ];
    for (const row of refused) expect(satelliteTargetIsDeliverable(row)).toBe(false);
    expect(satelliteTargetIsDeliverable(main)).toBe(true);
    // The PKO is the dearest row, and it is still never picked.
    expect(pickSatelliteTargets([...refused, main], now).map((r) => r.id)).toEqual(['main']);
  });
  it("the database refuses the same targets at creation, with the authority's own predicate", () => {
    const guard = readFileSync(
      join(
        process.cwd(),
        '../supabase/migrations/20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses.sql'
      ),
      'utf8'
    );
    for (const flag of ['is_bounty', 'is_pko', 'is_mystery_bounty', 'is_premium_spin']) {
      expect(guard).toContain(`t.${flag} IS FALSE`);
    }
    expect(guard).toContain("lower(COALESCE(t.variant, '')) <> 'spin'");
    expect(guard).toContain("upper(COALESCE(t.tournament_type, '')) <> 'SPIN'");
    expect(guard).toMatch(
      /CREATE TRIGGER satellite_feeds_only_a_deliverable_target\s+BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target,/
    );
  });
  it('reads the flags the predicate needs from the database', () => {
    const src = RECURRING.slice(RECURRING.indexOf('private async ensureSatelliteHeadsUps('));
    const read = src.slice(0, src.indexOf('.eq('));
    for (const column of [
      'tournament_type',
      'is_bounty',
      'is_pko',
      'is_mystery_bounty',
      'is_premium_spin',
    ]) {
      expect(read).toContain(column);
    }
  });
  it('the row is an unlimited scheduled satellite with its target settlement contract', () => {
    const src = RECURRING.slice(RECURRING.indexOf('private async createSatelliteHeadsUp('));
    const insert = src.slice(0, src.indexOf(".select('id')"));
    expect(insert).toMatch(/variant: 'satellite',/);
    expect(insert).toMatch(/tournament_type: 'SATELLITE',/);
    expect(insert).toMatch(/satellite_target_id: config\.targetId,/);
    expect(insert).toMatch(/satellite_seats: 1,/);
    expect(insert).toMatch(/max_players: null,/);
  });
  it('the feeders ride the heads-up tick for the house and every activated owner', () => {
    expect(RECURRING).toMatch(
      /await this\.ensureSatelliteHeadsUps\(this\.houseOwner, satelliteShare\);/
    );
    expect(RECURRING).toMatch(
      /for \(const owner of owners\) \{\s*await this\.ensureSatelliteHeadsUps\(owner, satelliteShare\);/
    );
  });
});

describe('7. an event may repeat every week, on the same weekday and time', () => {
  it('a week is the cap, and the checkbox value', () => {
    expect(RESTART_WEEKLY_MINUTES).toBe(10080);
    expect(RESTART_MAX_MINUTES).toBe(10080);
  });
  it('a weekly clone is anchored to the last start, not to when the hand ended', () => {
    const start = Date.parse('2026-09-06T17:00:00Z'); // Sunday 17:00
    const ended = start + 3 * 3_600_000; // ran three hours
    const next = restartCloneStartMs({
      restartMinutes: RESTART_WEEKLY_MINUTES,
      endedAtMs: ended,
      startTimeMs: start,
      nowMs: ended + 60_000,
      guaranteedPrize: 0,
    });
    expect(new Date(next).toISOString()).toBe('2026-09-13T17:00:00.000Z');
  });
  it('a clone made late steps forward to the next slot that is still ahead', () => {
    const start = Date.parse('2026-09-06T17:00:00Z');
    const next = restartCloneStartMs({
      restartMinutes: RESTART_WEEKLY_MINUTES,
      endedAtMs: start + 3_600_000,
      startTimeMs: start,
      nowMs: Date.parse('2026-09-20T12:00:00Z'),
      guaranteedPrize: 0,
    });
    expect(new Date(next).toISOString()).toBe('2026-09-20T17:00:00.000Z');
  });
  it('a sub-daily restart keeps the old rule: ended plus the interval, never inside the lead', () => {
    const ended = Date.parse('2026-09-06T17:40:00Z');
    const next = restartCloneStartMs({
      restartMinutes: 30,
      endedAtMs: ended,
      startTimeMs: ended - 40 * 60_000,
      nowMs: ended,
      guaranteedPrize: 0,
    });
    expect(next).toBe(ended + 30 * 60_000);
    const soon = restartCloneStartMs({
      restartMinutes: 5,
      endedAtMs: ended,
      startTimeMs: null,
      nowMs: ended + 10 * 60_000,
      guaranteedPrize: 0,
    });
    expect(soon).toBe(ended + 10 * 60_000 + RESTART_MIN_LEAD_MS);
  });
});

describe('2. a table over the cap drains through the engine, never a mid-hand cut', () => {
  it('only a literal true retires a table', () => {
    expect(isRetiringTable({ settings: { retire_when_empty: true } })).toBe(true);
    expect(isRetiringTable({ settings: { retire_when_empty: 'true' } })).toBe(false);
    expect(isRetiringTable({ settings: null })).toBe(false);
    expect(isRetiringTable(null)).toBe(false);
    expect(isRetiringTable({ settings: 'garbage' })).toBe(false);
  });
  it('the fleet reads settings and treats a retiring table as surplus', () => {
    // (Slice 2, 2026-09-05: the select also carries cluster_id and lifecycle,
    //  so the fleet can keep its hands off the controller's tables.)
    expect(FLEET).toMatch(
      /current_players, created_at, settings, cluster_id, lifecycle, role, main_index'/
    );
    expect(FLEET).toMatch(
      /if \(isRetiringTable\(t as \{ settings\?: unknown \}\)\) \{\s*surplusTableIds\.add\(t\.id\);/
    );
  });
  it('the rotator walks one horse out per cycle through the engine, outside the realism cap', () => {
    // 2026-09-05: role / main_index / lifecycle joined the select for the
    // horse seat-change pass (CLAUDE.md 10.5) - it has to know whether a
    // chair is on Main 1, which has no seat change, and whether the table is
    // closing. The columns this pin was written for (settings, for
    // isRetiringTable, and cluster_id, for the drain below) are still there.
    // 2026-09-05 (no lone horse): and created_at, for the opening-feeder grace.
    /* 2026-09-09: THE EMBED NAMES ITS PARENT NOW, and the pin moved with it
       (CLAUDE.md 10.6). `table_seats` gained two composite foreign keys to
       `tables` that afternoon, so the unqualified `tables!inner(...)` this
       used to pin was refused by PostgREST (PGRST201) and the rotator read
       nothing for three and a half hours. The COLUMNS this pin was written
       for are the point and every one of them is still asserted below; what
       changed is that the relationship is named, which is strictly stronger -
       the read can no longer be broken from a distance by a migration in
       another lane. */
    expect(ROTATOR).toMatch(
      /tables!table_seats_table_id_fkey!inner\(id, big_blind, tournament_id, status, settings, cluster_id, role, main_index, lifecycle, created_at, max_players, min_buy_in, max_buy_in\)/
    );
    // 2026-09-05: and the drain never touches a cluster table.
    expect(ROTATOR).toMatch(
      /if \(t\?\.cluster_id\) continue;\s*if \(!isRetiringTable\(t\)\) continue;/
    );
    const drain = ROTATOR.slice(
      ROTATOR.indexOf('A TABLE MARKED FOR RETIREMENT'),
      ROTATOR.indexOf('let departures = 0;')
    );
    expect(drain).toMatch(/engine\.leaveTable\(horseSeat\.user_id\)/);
    expect(drain).not.toMatch(/departures\+\+/);
  });
});
