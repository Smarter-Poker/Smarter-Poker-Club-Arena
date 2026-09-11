/**
 * THE ROTATOR MEETS A DRIFTED FLOOR (horse audit, lane B, 2026-09-09)
 *
 * HorseSessionRotator declined every pass from 05:25 UTC on 2026-09-09
 * (PGRST201 on its seat embed, swallowed by a bare `return`) and came back
 * to a floor nobody had rotated for fifteen hours: 337 horse cash seats,
 * 279 of them past the mean session, median 250 minutes seated. Auditing
 * what it would do on its first pass found the defects pinned here, every
 * one measured against the live database or traced through the code:
 *
 *   1. the session ledger read was `.limit(20_000)` on a table PostgREST
 *      caps at 1,000 rows, unfiltered - 386,992 rake and jackpot rows in the
 *      window, so the book-win / stop-loss rule never saw a true figure;
 *   2. that ledger was summed from the OLDEST seat on the floor, so a
 *      previous sitting at the same table counted against today's stack -
 *      49 of 337 seats read as a stop-loss under that sum, 2 under their own;
 *   3. a "short break" of up to five minutes met the engine's five-minute
 *      sit-out eviction, and a quarter of breaks ended as a cash-out;
 *   4. the break map is memory and the engine restarts hourly, so a break
 *      the restart forgot sat out until the eviction clock removed it;
 *   5. a person the platform had already offered a chair (`notified`) still
 *      stood a second horse up, and a third if a chair was already open;
 *   6. the waitlist read was unpaged (the fleet's has been paged since
 *      2026-09-06; the queue reached 10,004 rows on 2026-08-31);
 *   7. `leave_pending` was read for the seat-change pass but never selected,
 *      so a seat already leaving was asked to leave again every cycle and
 *      topped up on its way out;
 *   8. a `LEAVE_LOCKED` refusal (the stay clock) was re-asked every cycle;
 *   9. top-ups lived inside the departure loop, behind its population floor
 *      and its four-departure cap, and priced off `bb * 100` on tables whose
 *      minimum is four times that.
 *
 * The rotator needs a live Supabase to run, so the wiring is pinned against
 * the shipped source; what is pure is exercised directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DisconnectEngine } from '../engine/DisconnectEngine.js';
import { clearHorseStakeBands, setHorseStakeBands, stakeBandAllows } from './HorseBehavior.js';
import { rebuyStopLossReached, atRebuyStopLoss } from './HorseRebuyPolicy.js';
import { bankrollPolicyFor } from './HorseBankroll.js';

const REPO = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');
/** Strip comments so prose cannot satisfy a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROTATOR = read('server/src/services/HorseSessionRotator.ts');
const ROT = code(ROTATOR);
const LIFECYCLE = code(read('server/src/services/HorseLifecycleManager.ts'));
const LOADER = code(read('server/src/services/HorseLaneLoader.ts'));
const HYDRATOR = code(read('server/src/services/HorseMindHydrator.ts'));
const REBUY = code(read('server/src/services/HorseRebuyPolicy.ts'));
const WALLETS = code(read('server/src/services/supabase/wallets.ts'));
const DEALING = code(read('server/src/engine/ServerTableEngineDealing.ts'));
const SETTLEMENT = code(read('server/src/engine/ServerTableEngineSettlement.ts'));

const constant = (src: string, name: string): number => {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!m) throw new Error(`${name} not found`);
  // eslint-disable-next-line no-new-func
  return Number(new Function(`return (${m[1]})`)());
};

describe("1 + 2: the session ledger is the horse's own rows, this sitting only", () => {
  const block = ROT.slice(
    ROT.indexOf('const investedBySeat = new Map<string, number>();'),
    ROT.indexOf("reportError(err, 'HorseSessionRotator.bankroll_context');")
  );

  it('reads chip_ledger by the seated horses, chunked, paged by keyset, never a bare limit', () => {
    expect(block).toMatch(/\.in\('from_entity_id', batch\)/);
    expect(block).toMatch(/\.eq\('to_type', 'table_stack'\)/);
    expect(block).toMatch(/fetchAllRows<LedgerRow>\(/);
    expect(block).toMatch(/i \+= IN_LIST_CHUNK/);
    expect(block).toMatch(/\.order\('id', \{ ascending: true \}\)/);
    expect(block).not.toMatch(/\.limit\(\s*\d[\d_]*\s*\)/);
  });

  it("counts a row for a seat only inside that seat's own sitting", () => {
    expect(block).toMatch(/const joined = seatJoinedAt\.get\(k\);/);
    expect(block).toMatch(/if \(joined === undefined\) continue;/);
    expect(block).toMatch(/at < joined - 60_000\) continue;/);
  });

  it('a short read leaves the map EMPTY and says so - half a ledger is a false heater', () => {
    expect(block).toMatch(/if \(!page\.complete\) ledgerComplete = false;/);
    expect(block).toMatch(/'HorseSessionRotator\.invested_ledger_incomplete'/);
    // The rows are only summed on the complete branch.
    const summing = block.indexOf('investedBySeat.set(k,');
    const elseAt = block.indexOf('} else {', block.indexOf('if (!ledgerComplete)'));
    expect(summing).toBeGreaterThan(elseAt);
  });

  it('the horse set is resolved BEFORE the ledger, so the ledger read is horses only', () => {
    expect(ROT.indexOf('const horseIds = new Set(horseRead.rows')).toBeLessThan(
      ROT.indexOf('const investedBySeat = new Map')
    );
    expect(block).toMatch(/horseIds\.has\(s\.user_id\) && byTable\.has\(s\.table_id\)/);
  });
});

describe('3: a break ends before the eviction clock does', () => {
  it('BREAK_MAX_MS plus one cycle of slack is inside SITOUT_MAX_MS', () => {
    const breakMax = constant(ROT, 'BREAK_MAX_MS');
    const cycle = constant(ROT, 'CYCLE_MS');
    expect(breakMax + cycle).toBeLessThan(DisconnectEngine.SITOUT_MAX_MS);
    expect(constant(ROT, 'BREAK_MIN_MS')).toBeLessThan(breakMax);
  });
});

describe('4: a break the process forgot is sat back in from the row', () => {
  it('selects is_sitting_out and leave_pending on the seat read', () => {
    const sel = ROTATOR.slice(
      ROTATOR.indexOf("from('table_seats')"),
      ROTATOR.indexOf("is('left_at', null)")
    );
    expect(sel).toContain('leave_pending, is_sitting_out');
    expect(sel).toContain('max_players, min_buy_in, max_buy_in');
  });

  it('a horse sitting out at a cash table with no break on record is sat back in', () => {
    expect(ROT).toMatch(
      /seat\.is_sitting_out !== true \|\| HorseSessionRotator\.isLeaving\(seat\)\) continue;/
    );
    expect(ROT).toMatch(
      /if \(this\.breaks\.has\(key\) \|\| this\.sitBackRestoredKeys\.has\(key\)\) continue;/
    );
    expect(ROT).toMatch(/this\.getEngine\(tableId\)\?\.sitOut\?\.\(userId, false\)/);
  });
});

describe('5: a horse gets up for a person who does not already have a chair', () => {
  it('releaseWanted is the queue minus the chairs the table already has open', () => {
    expect(ROT).toMatch(/const openSeats = Math\.max\(0, maxPlayers - tableSeats\.length\);/);
    expect(ROT).toMatch(
      /const releaseWanted = Math\.max\(0, \(humansWaiting\.get\(tableId\) \?\? 0\) - openSeats\);/
    );
  });

  it("the release victim is the executor's order: sitting out first, then the newest arrival", () => {
    const order = ROT.slice(ROT.indexOf('const order ='), ROT.indexOf('let best:'));
    expect(order).toMatch(/is_sitting_out === true \? 0 : 1/);
    expect(order).toMatch(
      /new Date\(b\.joined_at\)\.getTime\(\) - new Date\(a\.joined_at\)\.getTime\(\)/
    );
  });
});

describe("6: the waitlist read is paged like the fleet's", () => {
  it('keyset on id, and a short read still fails closed', () => {
    const block = ROT.slice(
      ROT.indexOf('const humansWaiting = new Map<string, number>();'),
      ROT.indexOf("reportError(err, 'HorseSessionRotator.humansWaiting');")
    );
    expect(block).toMatch(/fetchAllRows</);
    expect(block).toMatch(/\.in\('status', \['waiting', 'notified'\]\)/);
    expect(block).toMatch(/if \(!page\.complete\) throw new Error/);
    expect(ROT).toMatch(/humansWaiting\.clear\(\);/);
  });
});

describe('7 + 8: a seat already leaving, or inside a stay clock, is not asked again', () => {
  it('leave_pending is read from the row for every departure path', () => {
    expect(ROT).toMatch(/return seat\.leave_pending === true;/);
    // drain, discretionary, lone, tournament: all four consult isLeaving.
    expect((ROT.match(/HorseSessionRotator\.isLeaving\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('every leave result is noted, and LEAVE_LOCKED holds the seat for the clock it named', () => {
    expect((ROT.match(/await engine\.leaveTable\(/g) ?? []).length).toBe(4);
    expect((ROT.match(/this\.noteLeaveResult\(/g) ?? []).length).toBe(4);
    expect(ROT).toMatch(/if \(result\.code === 'LEAVE_LOCKED'\) \{/);
    expect(ROT).toMatch(/this\.leaveHeld\.set\(key, Date\.now\(\) \+ remaining \+ 1_000\);/);
    expect((ROT.match(/this\.isLeaveHeld\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('a seat on its way out is not topped up and not sent on a break', () => {
    const topups = ROT.slice(
      ROT.indexOf('if (!engine?.addChips) continue;'),
      ROT.indexOf('let departures = 0;')
    );
    expect(topups).toMatch(
      /if \(HorseSessionRotator\.isLeaving\(seat\) \|\| seat\.is_sitting_out === true\) continue;/
    );
    expect(ROT).toMatch(/best\.seat\.is_sitting_out !== true &&/);
  });
});

describe('9: a reload is not a departure', () => {
  it('top-ups run for every cash table, before the departure loop and outside its cap', () => {
    const topupAt = ROT.indexOf('if (!engine?.addChips) continue;');
    const capAt = ROT.indexOf('if (departures >= GLOBAL_DEPARTURES_PER_CYCLE) break;');
    const floorAt = ROT.indexOf('tableSeats.length < (humanPresent ? 5 : 4)) continue');
    expect(topupAt).toBeGreaterThan(0);
    expect(topupAt).toBeLessThan(capAt);
    expect(topupAt).toBeLessThan(floorAt);
    // and the departure loop no longer carries a top-up of its own
    const departures = ROT.slice(capAt);
    expect(departures).not.toContain('engine.addChips(');
  });

  it("prices the reload, the swing and the session verdict off the table's own limits", () => {
    expect(
      (ROT.match(/const buyIn = referenceBuyIn\(bb, tableMin, tableMax\);/g) ?? []).length
    ).toBe(2);
    expect(ROT).toMatch(/minBuyIn: tableMin,\s*maxBuyIn: tableMax,/);
    expect(ROT).not.toMatch(/minBuyIn: bb \* 40/);
    expect(ROT).toMatch(/sessionVerdict\(\s*stack - invested,\s*buyIn,/);
  });
});

describe('the lifecycle sweeps do the work they are for, and no more', () => {
  it('the finished-tournament reset looks at what ended recently, ordered and bounded', () => {
    expect(LIFECYCLE).toMatch(/\.gte\('ended_at', endedSince\)/);
    expect(LIFECYCLE).toMatch(/\.order\('ended_at', \{ ascending: false \}\)/);
    expect(LIFECYCLE).toMatch(/const FINISHED_TOURNAMENT_WINDOW_MS = 15 \* 60 \* 1000;/);
  });

  it('a horse already available is not rewritten as available', () => {
    expect(LIFECYCLE).toMatch(/\.neq\('horse_status', 'available'\)\s*\.select\('id'\)/);
    expect(LIFECYCLE).toMatch(/if \(!changed \|\| changed\.length === 0\) return false;/);
  });

  it('the stale-seat sweep reads its tables once, in chunks, and fails closed', () => {
    expect(LIFECYCLE).toMatch(/'HorseLifecycle\.staleSeatTables'/);
    expect(LIFECYCLE).toMatch(/if \(!tableRead\.complete\) \{/);
    expect(LIFECYCLE).toMatch(/const tableRow = tableById\.get\(seat\.table_id\);/);
    expect(LIFECYCLE).not.toMatch(
      /\.select\('tournament_id, cluster_id'\)\s*\.eq\('id', seat\.table_id\)/
    );
    // the cluster-table guard the estate law pins is still there
    expect(LIFECYCLE).toMatch(/if \(tableRow\?\.cluster_id\) continue;/);
  });
});

describe('the bands are loaded before the fleet decides a seat on them', () => {
  beforeEach(() => clearHorseStakeBands());

  it('with nothing loaded the gate refuses; with a record it decides', () => {
    expect(stakeBandAllows('anybody', 0.1)).toBe(false);
    expect(stakeBandAllows('anybody', 25)).toBe(false);
    setHorseStakeBands([{ id: 'grinder', stakeBand: 'micro' }]);
    expect(stakeBandAllows('grinder', 0.1)).toBe(true);
    // a horse with no record still starts at the bottom once a fleet is loaded
    expect(stakeBandAllows('newcomer', 0.1)).toBe(true);
    expect(stakeBandAllows('newcomer', 25)).toBe(false);
  });

  it('the loader loads at once and retries a failed first load within a minute', () => {
    expect(LOADER).not.toContain('BOOT_DELAY_MS');
    expect(LOADER).toMatch(/lifecycleGeneration \+= 1;\s*stopOperation = null;\s*launchLoad\(\);/);
    expect(LOADER).toMatch(/const FIRST_LOAD_RETRY_MS = 60_000;/);
    expect(LOADER).toMatch(
      /if \(assignedStakeBandCount\(\) === 0 && lifecycleIsCurrent\(generation\) && !retryTimer\)/
    );
  });
});

describe('the mind hydrates from the newest hands, not the oldest thousand', () => {
  it('pages newest-first by created_at up to the cap and replays in dealt order', () => {
    expect(HYDRATOR).toMatch(/\.order\('created_at', \{ ascending: false \}\)/);
    expect(HYDRATOR).toMatch(/if \(cursor\) q = q\.lt\('created_at', cursor\);/);
    expect(HYDRATOR).toMatch(/const data = newestFirst\.reverse\(\);/);
    expect(HYDRATOR).not.toMatch(/\.limit\(HYDRATION_MAX_HANDS\)/);
  });
});

describe('the rebuy reads the wallet the seat was bought from, and holds the window by temperament', () => {
  it('rebuyStopLossReached is the temperament, side-effect free, and agrees with atRebuyStopLoss', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const stop = bankrollPolicyFor(id).stopLossBuyIns;
      expect(rebuyStopLossReached(id, stop - 2)).toBe(false);
      expect(rebuyStopLossReached(id, stop - 1)).toBe(true);
      expect(rebuyStopLossReached(id, stop - 1)).toBe(atRebuyStopLoss(id, stop - 1));
    }
  });

  it('the dealing loop holds the five-second window by the same figure', () => {
    expect(DEALING).toMatch(
      /if \(!rebuyStopLossReached\(horse\.user_id, this\.horseRebuys\.get\(horse\.user_id\) \|\| 0\)\)/
    );
    expect(DEALING).not.toMatch(/horseRebuys\.get\(horse\.user_id\) \|\| 0\) < 2\)/);
  });

  it("both engine sites hand the policy the table, and the policy reads the seat's club", () => {
    expect(DEALING).toMatch(/tableId: this\.tableId,\s*userId: horse\.user_id,/);
    expect(SETTLEMENT).toMatch(/tableId: this\.tableId,\s*userId: horse\.user_id,/);
    expect(REBUY).toMatch(/readSeatWalletClub\(req\.tableId, userId\)/);
    expect(WALLETS).toMatch(/export async function readSeatWalletClub\(/);
    expect(WALLETS).toMatch(/\.from\('table_seats'\)\s*\.select\('club_id'\)/);
  });
});
