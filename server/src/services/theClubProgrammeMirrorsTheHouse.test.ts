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
 *   4. "WAIT 60-150 SECONDS TO ALLOW A HUMAN TO PLAY, BEFORE A 3RD HORSE CAN
 *      JOIN" - the human window is 60 to 150 seconds, in every place that
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
    '../supabase/migrations/20260903171736_the_third_seat_waits_60_to_150_seconds_for_a_human_everywhere.sql'
  ),
  'utf8'
);

describe('4. the third seat waits 60 to 150 seconds for a human', () => {
  it('the engine window is 60 to 150 seconds', () => {
    expect(SEAT_FIRST_HUMAN_WINDOW_MIN_MS).toBe(60_000);
    expect(SEAT_FIRST_HUMAN_WINDOW_MAX_MS).toBe(150_000);
  });
  it('the recovery window agrees', () => {
    expect(FRESH_HUMAN_WINDOW_MIN_S).toBe(60);
    expect(FRESH_HUMAN_WINDOW_MAX_S).toBe(150);
  });
  it('and so does the SQL repair (60 + [0, 90] seconds)', () => {
    expect(REPAIR_MIGRATION).toMatch(/v_window := 60 \+ floor\(random\(\) \* 91\)::int;/);
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
  it('prices two entries to cover one ticket after the heads-up rake, with no overlay', () => {
    const rate = rakeRateFor({ tournamentType: 'SNG', maxPlayers: HEADS_UP_SEATS });
    for (const ticket of [20, 33, 44, 109, 200]) {
      const buyIn = satelliteHeadsUpBuyIn(ticket);
      expect(buyIn).toBeGreaterThan(0);
      expect(buyInFor(buyIn, rate).prize * HEADS_UP_SEATS).toBeGreaterThanOrEqual(ticket);
    }
    expect(satelliteHeadsUpBuyIn(0)).toBe(0);
    expect(satelliteHeadsUpBuyIn(1_000_000)).toBe(0);
  });
  it('names the feeder after its target', () => {
    expect(satelliteHeadsUpName('Sunday $200 Deep Stack')).toBe(
      'Sunday $200 Deep Stack Satellite Heads-Up'
    );
  });
  it('picks the dearest open events inside the window, one per name, never a seat-first game', () => {
    const now = Date.parse('2026-09-03T18:00:00Z');
    const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
    const rows: SatelliteTargetRow[] = [
      {
        id: 'a',
        name: 'Sunday $200 Deep Stack',
        start_time: at(70),
        buy_in_amount: 180,
        buy_in_fee: 20,
        variant: 'freezeout',
        max_players: 1000,
      },
      {
        id: 'b',
        name: 'Sunday $200 Deep Stack',
        start_time: at(238),
        buy_in_amount: 180,
        buy_in_fee: 20,
        variant: 'freezeout',
        max_players: 1000,
      },
      {
        id: 'c',
        name: 'Saturday Night Big Stack',
        start_time: at(50),
        buy_in_amount: 40,
        buy_in_fee: 4,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        id: 'd',
        name: 'Friday Night Feature',
        start_time: at(30),
        buy_in_amount: 30,
        buy_in_fee: 3,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        id: 'e',
        name: 'Turbo Tuesday Graveyard',
        start_time: at(20),
        buy_in_amount: 3,
        buy_in_fee: 0.3,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        id: 'f',
        name: 'NLH Heads-Up 100',
        start_time: at(1),
        buy_in_amount: 95,
        buy_in_fee: 5,
        variant: 'sng',
        max_players: 2,
      },
      {
        id: 'g',
        name: 'Sunday Deep Stack Satellite $25',
        start_time: at(40),
        buy_in_amount: 22.5,
        buy_in_fee: 2.5,
        variant: 'satellite',
        max_players: 100,
      },
      {
        id: 'h',
        name: 'Starting Any Minute',
        start_time: at(0.25),
        buy_in_amount: 90,
        buy_in_fee: 10,
        variant: 'freezeout',
        max_players: 500,
      },
      {
        id: 'i',
        name: 'Next Month',
        start_time: at(24 * 9),
        buy_in_amount: 90,
        buy_in_fee: 10,
        variant: 'freezeout',
        max_players: 500,
      },
      {
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
    expect(SATELLITE_HU_TARGET_LEAD_MS).toBe(30 * 60_000);
    expect(SATELLITE_HU_TARGET_HORIZON_MS).toBe(7 * 24 * 3_600_000);
  });
  it('the row is a heads-up SNG to every seat-first reader and a satellite to the finish', () => {
    const src = RECURRING.slice(RECURRING.indexOf('private async createSatelliteHeadsUp('));
    const insert = src.slice(0, src.indexOf('.select()'));
    expect(insert).toMatch(/variant: 'sng',/);
    expect(insert).toMatch(/tournament_type: 'SATELLITE',/);
    expect(insert).toMatch(/satellite_target_id: config\.targetId,/);
    expect(insert).toMatch(/satellite_seats: 1,/);
    expect(insert).toMatch(/max_players: config\.maxPlayers,/);
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
    expect(ROTATOR).toMatch(
      /tables!inner\(id, big_blind, tournament_id, status, settings, cluster_id, role, main_index, lifecycle\)/
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
