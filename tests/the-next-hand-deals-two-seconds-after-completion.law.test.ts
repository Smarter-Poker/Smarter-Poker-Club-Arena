/**
 * LAW: the next hand deals two seconds after the hand is completed, and the
 * two seconds are where the bookkeeping runs - not before it.
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, 2026-09-07, verbatim: "LOTS OF HANDS ARE NOT STARTING THE NEXT HAND 2
 * SECONDS AFTER THE HAND IS COMPLETED, MOST ARE TAKING MORE THAN 2 SECONDS,
 * SOME UP TO 10 SECONDS+ TO GET THE NEXT HAND STARTED." And of Rabbit Hunt:
 * "INSTEAD OF IT JUST 'DISPLAYING AND MOVING ON'."
 *
 * "Completed" is Dan's 2026-08-21 definition and it is unchanged: the winning
 * hand shown, the pot pushed with its total, the cards mucked - the end of
 * handCompletionHoldMs. From that instant to the next deal is ONE number,
 * HAND_COMPLETION.NEXT_HAND_REST_MS, and everything the engine used to do
 * AFTER its post-hand sleeps - wait for settlement, reload the roster, sweep
 * the leavers, allocate a hand number - now runs UNDER that number. The
 * Rabbit Hunt window (Dan 2026-09-05) is the same number under its own name;
 * a purchase never touches the schedule.
 *
 * Measured before the change (production, 2026-09-07 22:30 UTC, cash tables,
 * 40 minutes, 6,470 hands): p50 11.2s and p90 20.6s from one hand's ended_at
 * to the next hand's started_at. From /health's loop phases: 5.9s mean in
 * await_post_hand_tasks, 2.8s in load_next_hand_inputs, 1.5s each in
 * announce_seat_moves and leave_pending - one PostgREST round trip apiece,
 * 250-700ms each from the engine box, all of them serial and all of them
 * after the rest instead of inside it. /health now carries `nextHandGap`
 * so the claim can be checked after every deploy rather than argued.
 *
 * Changelog: docs/changelog/2026-09-07-the-next-hand-deals-two-seconds-after-completion.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAND_COMPLETION, boardClearMs } from '../src/config/handCompletionSpec';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const DEALING = strip(read('server/src/engine/ServerTableEngineDealing.ts'));
const BASE = strip(read('server/src/engine/ServerTableEngineBase.ts'));
const SETTLEMENT = strip(read('server/src/engine/ServerTableEngineSettlement.ts'));
const TABLES = strip(read('server/src/services/supabase/tables.ts'));
const GAME_SERVER = strip(read('server/src/GameServer.ts'));

describe('LAW: the next hand deals two seconds after completion (Dan 2026-09-07)', () => {
  it('the rest is 2000ms, the Rabbit Hunt window is the same number, and the engine mirror agrees', () => {
    expect(HAND_COMPLETION.NEXT_HAND_REST_MS).toBe(2000);
    expect(HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS).toBe(HAND_COMPLETION.NEXT_HAND_REST_MS);
    const server = read('server/src/config/handCompletionSpec.ts');
    expect(server).toMatch(/NEXT_HAND_REST_MS: 2000,/);
    expect(server).toMatch(/RABBIT_HUNT_WINDOW_MS: 2000,/);
  });

  it('the rest is longer than either board clear and at least the client button floor', () => {
    expect(HAND_COMPLETION.NEXT_HAND_REST_MS).toBeGreaterThan(boardClearMs(true));
    expect(HAND_COMPLETION.NEXT_HAND_REST_MS).toBeGreaterThan(boardClearMs(false));
    const floor = Number(
      read('src/pages/TablePage.tsx').match(/const RABBIT_MIN_VISIBLE_MS = (\d+);/)![1]
    );
    expect(HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS).toBeGreaterThanOrEqual(floor);
  });

  it('the engine ARMS the rest at the hand-free broadcast and AWAITS it right before dealHand', () => {
    const hold = DEALING.indexOf("this.setLoopPhase('post_hand_hold')");
    const broadcast = DEALING.indexOf('this.broadcastCurrentState();', hold);
    const arm = DEALING.indexOf('this.armNextHandRest(', broadcast);
    expect(hold).toBeGreaterThan(-1);
    expect(broadcast).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(broadcast);
    expect(DEALING.slice(broadcast, arm)).not.toMatch(/\bif\s*\(|await /);
    const awaited = DEALING.indexOf('await this.awaitNextHandRest();');
    const deal = DEALING.indexOf("this.setLoopPhase('dealing');");
    expect(awaited).toBeGreaterThan(-1);
    expect(deal).toBeGreaterThan(awaited);
    const betweenRestAndDeal = DEALING.slice(
      awaited + 'await this.awaitNextHandRest();'.length,
      deal
    );
    // A requested pause can arrive under the rest. These exact owner gates
    // have no unpaused-path wait; the lease re-proof remains the only other
    // work before the deal, preserving the ordinary two-second rest.
    const boundaryGate =
      /if \(\s*this\.terminalCloseoutPaused\s*\|\|\s*this\.tournamentMovePauseOwners\.size > 0\s*\) \{\s*if \(this\.maintenancePaused\) await this\.persistPresenceForRestart\('parked'\);\s*await this\.awaitPauseGate\(\);\s*if \(!this\.running\) break;\s*continue;\s*\}/g;
    const requestedPauseGate =
      /if \(this\.isNextHandPaused\(\)\) \{\s*if \(this\.maintenancePaused\) await this\.persistPresenceForRestart\('parked'\);\s*if \(!this\.adminPauseLock && !this\.maintenanceLock\) await this\.awaitPauseGate\(\);\s*if \(!this\.running\) break;\s*continue;\s*\}/g;
    expect(betweenRestAndDeal.match(boundaryGate)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(betweenRestAndDeal.match(requestedPauseGate)).toHaveLength(1);
    expect(
      betweenRestAndDeal.replace(boundaryGate, '').replace(requestedPauseGate, '').trim()
    ).toBe('if (!this.lifecycleCanMutate()) return;');
  });

  it('the old separate sleeps are gone - the clear and the window live inside the rest', () => {
    expect(DEALING).not.toMatch(/await this\.sleep\(boardClearMs\(/);
    expect(DEALING).not.toMatch(/await this\.sleep\(HAND_COMPLETION\.RABBIT_HUNT_WINDOW_MS\)/);
    expect(DEALING).toMatch(
      /armNextHandRest\(\s*Math\.max\(HAND_COMPLETION\.NEXT_HAND_REST_MS, boardClearMs\(wentToShowdown\)\)/
    );
  });

  it('the roster, the leave sweep and the hand number are read together, under the rest', () => {
    // The roster is prepared once under the rest, then adopted only while
    // this engine still owns its table. The synchronous adoption helper also
    // retires replaced occupancies' old mirrors without another roster read.
    expect(DEALING).toMatch(
      /const (\w+) = await this\.prepareNextHand\(\);\s*if \(!this\.lifecycleCanMutate\(\)\) return;\s*this\.adoptSeatRoster\(\1\);/
    );
    expect(BASE).toMatch(
      /protected adoptSeatRoster\((\w+): SeatedPlayer\[\]\): string\[\] \{\s*if \(!this\.lifecycleCanMutate\(\)\) return \[\];\s*const previous = new Map\(this\.seatedPlayers\.map\(\(p\) => \[p\.user_id, p\.occupancy_id\]\)\);\s*this\.seatedPlayers = \1;/
    );
    expect(DEALING.match(/await this\.prepareNextHand\(\)/g)).toHaveLength(1);
    const start = DEALING.indexOf('protected async prepareNextHand(');
    const end = DEALING.indexOf('private preparedLeavePending:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = DEALING.slice(start, end);
    // The seat-boundary owner joins the one roster read and both sweep
    // outcomes before returning the prepared roster, even after a failure.
    expect(body.match(/this\.readNextHandInputs\(\)/g)).toHaveLength(1);
    expect(body).toMatch(
      /const \[roster, departure, budget\] = await Promise\.allSettled\(\[\s*this\.readNextHandInputs\(\),\s*rawSweep \?\? Promise\.resolve\(\[\]\),\s*budgetedSweep \?\? Promise\.resolve\(\[\]\),?\s*\]\);/
    );
    expect(body).toMatch(
      /if \(roster\.status === 'rejected'\) throw roster\.reason;\s*if \(departure\.status === 'rejected'\) throw departure\.reason;\s*if \(budget\.status === 'rejected'\) throw budget\.reason;\s*return roster\.value;\s*\} finally \{\s*releaseSeatBoundary\(\);/
    );
    // the leave sweep races the roster read only when no add-on is pending
    expect(body).toMatch(/!this\.pendingAddOnSweepNeeded/);
    expect(body).toMatch(/this\.pendingAddOns\.size === 0/);
    expect(body).toMatch(/this\.allocateGlobalHandNumber\(\)/);
    // dealHand takes the prepared number and only allocates when none is held
    expect(DEALING).toMatch(
      /this\.handCount = this\.takePreparedHandNumber\(\) \?\? \(await this\.allocateGlobalHandNumber\(\)\);/
    );
    // a held number is never dealt stale
    expect(DEALING).toMatch(/PREPARED_HAND_NUMBER_MAX_AGE_MS = 15_000/);
  });

  it('settlement runs the record and the seats as two lanes, serial again on any jackpot or insurance hand', () => {
    expect(SETTLEMENT).toMatch(
      /const lanesCanOverlap =\s*!snap\.bbjHit\?\.hit && !snap\.miniBbjHit && snap\.insuranceSettlements\.length === 0;/
    );
    // a seats step waits for the whole record lane when the lanes may not overlap
    expect(SETTLEMENT).toMatch(
      /lane === 'seats' && !lanesCanOverlap\s*\? Promise\.all\(\[lanes\.record, lanes\.seats\]\)/
    );
    expect(SETTLEMENT).toMatch(/lanes\[lane\] = after\.then\(exec\);/);
    // the barrier waits for both lanes
    expect(SETTLEMENT).toMatch(/await Promise\.all\(\[lanes\.record, lanes\.seats\]\);/);
    // a step without a lane runs in place: sync_stacks stays ahead of both lanes
    const laneTable = SETTLEMENT.slice(
      SETTLEMENT.indexOf('const STEP_LANE'),
      SETTLEMENT.indexOf('};', SETTLEMENT.indexOf('const STEP_LANE'))
    );
    expect(laneTable).not.toMatch(/sync_stacks/);
    for (const step of [
      'hand_history',
      'rake_distribution',
      'bbj_contribution',
      'promo_playthrough',
      'insurance_ledger',
      'bbj_mini_payout',
      'bbj_payout',
      'tournament_chip_sync',
    ]) {
      expect(laneTable, `${step} is not in the record lane`).toMatch(
        new RegExp(`${step}: 'record'`)
      );
    }
    for (const step of [
      'pending_addons',
      'horse_rebuys',
      'chip_continuity',
      'horse_cashouts',
      'deferred_sitouts',
      'leave_pending',
      'table_unlock',
    ]) {
      expect(laneTable, `${step} is not in the seats lane`).toMatch(new RegExp(`${step}: 'seats'`));
    }
    // every runStep in the function is in the table or is sync_stacks
    const fn = SETTLEMENT.slice(SETTLEMENT.indexOf('protected async postHandTasks('));
    const names = [...fn.matchAll(/await runStep\('([a-z_]+)'/g)].map((m) => m[1]);
    for (const n of names) {
      expect(n === 'sync_stacks' || laneTable.includes(`${n}:`), `${n} has no lane`).toBe(true);
    }
    // the hand row is written from a copy taken before either lane starts
    const copy = SETTLEMENT.indexOf('const playersForRecord = players.map((p) => ({ ...p }));');
    const record = SETTLEMENT.indexOf("await runStep('hand_history'");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(record);
    expect(SETTLEMENT).toMatch(/const roster = playersForRecord\.map\(/);
  });

  it('the roster is one round trip through the profiles FK, with the two-step read as the fallback', () => {
    const fn = TABLES.slice(TABLES.indexOf('export async function loadSeatedPlayers('));
    expect(fn).toMatch(
      /profile:profiles!fk_table_seats_user_id_profiles\(\$\{SEATED_PROFILE_SELECT\}, is_vip, vip_tier, vip_expires_at\)/
    );
    expect(fn).toMatch(/DB\.load_seated_players_embed_fallback/);
    expect(fn).toMatch(
      /\.from\('profiles'\)\s*\.select\(`\$\{SEATED_PROFILE_SELECT\}, is_vip, vip_tier, vip_expires_at`\)\s*\.in\('id', userIds\)/
    );
  });

  it('/health measures the gap so the next agent does not have to guess', () => {
    expect(GAME_SERVER).toMatch(/nextHandGap: nextHandGap\.snapshot\(\),/);
  });
});
