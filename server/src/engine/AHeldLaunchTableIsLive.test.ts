/**
 * A TABLE HELD FOR ITS LAUNCH IS ALIVE WHEN THE HOLD ENDS (2026-10-19).
 *
 * Since #7367 a prepared tournament launch seats every table minutes before
 * the advertised start and holds each one with `holdDealingUntil(launchStart)`.
 * The dealing loop waited that hold out without ever calling markProgress(),
 * so at the start instant - the hold gone, the table no longer paused by
 * design - GameServer's 180 s sweep judged it on a clock that had last moved
 * before the hold began and fenced it as `tournament_table_zombie` with
 * hand_count 0. 85, 88 and 46 tables at 01:30, 03:30 and 05:30 UTC.
 *
 * These drive the real engine through the real hold slice and then ask the
 * same questions the sweep and the table watchdog ask. The other half matters
 * as much: a table that is genuinely stalled, or whose loop never came back
 * through the hold, must still be condemned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';
import { zombieProgressAge } from '../fleetWideZombieVerdict.js';

const TABLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ZOMBIE_MS = 180_000;
const T0 = Date.parse('2026-10-19T01:25:00Z');

function engineBetweenHands(): any {
  const e = new ServerTableEngine(TABLE) as any;
  e.running = true;
  e.isCurrentEngine = () => true;
  e.handCount = 0;
  e.handController = null;
  e.tableInfo = { action_time_seconds: 15, game_variant: 'nlh' };
  e.seatedPlayers = [1, 2, 3].map((seat) => ({
    seat_number: seat,
    user_id: `u${seat}`,
    username: `p${seat}`,
    stack: 1500,
    is_horse: seat !== 1,
  }));
  e.waitingForBB = new Set<string>();
  e.disconnectEngine = { isSittingOut: () => false };
  e.killed = [] as string[];
  e.killForRestart = (reason: string) => {
    e.killed.push(reason);
    e.running = false;
  };
  return e;
}

/**
 * GameServer's per-table verdict, verbatim (GameServer.ts:
 * `shouldBeDealing && !parkedOnPurpose && zombieProgressAge(engine) > 180_000`,
 * with `parkedOnPurpose = engine.isParkedByDesign() && !pausedTooLong`). A
 * tournament-owned table always "should be dealing". The source pin below
 * fails if the sweep stops reading these inputs this way.
 */
function sweepCondemns(e: any): boolean {
  const shouldBeDealing = true;
  const parkedOnPurpose = e.isParkedByDesign();
  return shouldBeDealing && !parkedOnPurpose && zombieProgressAge(e) > ZOMBIE_MS;
}

/** Run the dealing loop's hold branch exactly as the loop does, until it ends. */
async function waitOutHold(e: any): Promise<number> {
  let slices = 0;
  while (e.dealHoldUntilMs > Date.now()) {
    const slice = e.waitOneDealHoldSlice();
    await vi.advanceTimersByTimeAsync(1000);
    await slice;
    slices += 1;
  }
  return slices;
}

describe('a held launch table is alive when its hold expires', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('is not condemned at the start instant after a hold longer than 180 s', async () => {
    const e = engineBetweenHands();
    e.markProgress(); // seated and built at T0
    e.holdDealingUntil(T0 + 5 * 60_000); // the measured prepared-launch lead

    expect(e.isPausedByDesign()).toBe(true);
    const slices = await waitOutHold(e);
    expect(slices).toBeGreaterThanOrEqual(300);

    // The start instant: the hold is gone, the table is no longer paused.
    expect(e.dealHoldUntilMs).toBeLessThanOrEqual(Date.now());
    expect(e.isPausedByDesign()).toBe(false);
    expect(e.isParkedByDesign()).toBe(false);
    expect(e.msSinceProgress()).toBeLessThanOrEqual(1000);
    expect(sweepCondemns(e)).toBe(false);

    // And the table's own watchdog agrees: no trip, no kill.
    e.runTableWatchdog();
    expect(e.watchdogTrips).toBe(0);
    expect(e.killed).toEqual([]);
  });

  it('still owes the 180 s clock from the instant the hold ends', async () => {
    const e = engineBetweenHands();
    e.markProgress();
    e.holdDealingUntil(T0 + 4 * 60_000);
    await waitOutHold(e);

    // The first deal never comes: the table is judged exactly as any other.
    vi.setSystemTime(Date.now() + ZOMBIE_MS + 1_000);
    expect(sweepCondemns(e)).toBe(true);
  });

  it('condemns a genuinely stalled table that was never held', () => {
    const e = engineBetweenHands();
    e.lastProgressAtMs = Date.now() - (ZOMBIE_MS + 1_000);
    expect(e.isParkedByDesign()).toBe(false);
    expect(sweepCondemns(e)).toBe(true);
  });

  it('condemns a held table whose loop never came back through the hold', () => {
    const e = engineBetweenHands();
    e.markProgress();
    e.holdDealingUntil(T0 + 5 * 60_000);
    // The loop is wedged elsewhere: no slice runs. Exempt while held...
    vi.setSystemTime(T0 + 4 * 60_000);
    expect(sweepCondemns(e)).toBe(false);
    // ...and judged on its real, aged clock the moment the hold passes.
    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    expect(e.msSinceProgress()).toBeGreaterThan(ZOMBIE_MS);
    expect(sweepCondemns(e)).toBe(true);
  });

  it('a stopped engine earns no progress from a slice', async () => {
    const e = engineBetweenHands();
    e.lastProgressAtMs = T0 - 200_000;
    e.holdDealingUntil(T0 + 10_000);
    const slice = e.waitOneDealHoldSlice();
    e.running = false;
    await vi.advanceTimersByTimeAsync(1000);
    await slice;
    expect(e.msSinceProgress()).toBeGreaterThan(ZOMBIE_MS);
  });
});

describe('the wiring the behaviour above depends on', () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), 'utf8');
  const DEALING = read('ServerTableEngineDealing.ts');
  const GAME_SERVER = read('../GameServer.ts');

  it('the dealing loop waits a hold out through the slice that marks progress', () => {
    expect(DEALING).toMatch(
      /if \(this\.dealHoldUntilMs > Date\.now\(\)\) \{\s*await this\.waitOneDealHoldSlice\(\);\s*continue;\s*\}/
    );
    const slice = DEALING.slice(DEALING.indexOf('protected async waitOneDealHoldSlice'));
    const body = slice.slice(0, slice.indexOf('\n  }\n'));
    expect(body.indexOf('await this.sleep(')).toBeGreaterThan(-1);
    expect(body.indexOf('this.markProgress()')).toBeGreaterThan(body.indexOf('await this.sleep('));
  });

  it('the sweep still reads the inputs this test models, at the same threshold', () => {
    expect(GAME_SERVER).toMatch(
      /const parkedOnPurpose = engine\.isParkedByDesign\(\) && !pausedTooLong;/
    );
    expect(GAME_SERVER).toMatch(
      /shouldBeDealing && !parkedOnPurpose && zombieProgressAge\(engine\) > 180_000/
    );
  });
});
