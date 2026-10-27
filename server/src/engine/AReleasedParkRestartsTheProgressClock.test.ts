/**
 * A RELEASED PARK RESTARTS THE PROGRESS CLOCK - ON EVERY EXIT (2026-10-19).
 *
 * GameServer's sweep condemns a table that should be dealing, is not parked
 * by design, and has made no progress for 180 s. A table parked on purpose is
 * exempt while parked; the defect class is what happens the instant the park
 * ends. If the progress clock kept ageing underneath the park, the table
 * leaves it already "stale" and is rebuilt one sweep after it was allowed to
 * deal. Production, 2026-10-19: every table of the :30 MTTs was built about
 * 6.5 minutes early (01:23:25-01:23:57), held to 01:30:00, and condemned at
 * 01:30:00-01:30:04 reading "no progress for 389-395s" - 85, 88, 46 and 14
 * tables at 01:30, 03:30, 05:30 and 13:30 UTC. The :00 starts were never hit,
 * because the :53 maintenance break parks those tables at the pause gate and
 * the gate's release already credited the clock.
 *
 * This file drives the real engine through every deliberate-park exit at that
 * timing, and through the other half too: a released table that then makes no
 * progress is still condemned after 180 s, and a table that never reached the
 * gate earns nothing from a resume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';
import { zombieProgressAge } from '../fleetWideZombieVerdict.js';

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ZOMBIE_MS = 180_000;
/** Table built at 01:23:30, start at 01:30:00: the measured 390 s lead. */
const BUILT = Date.parse('2026-10-19T01:23:30Z');
const START = Date.parse('2026-10-19T01:30:00Z');
const LEAD_MS = START - BUILT;

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
  e.persistPresenceForRestart = async () => undefined;
  e.markProgress(); // built and seated
  return e;
}

/** A seated table that has started dealing: empty -> waiting -> seating -> running. */
function toRunning(e: any): void {
  e.tableFSM.transition('waiting');
  e.tableFSM.transition('seating');
  e.tableFSM.transition('running');
}

/** GameServer's verdict, verbatim (pinned against the source below). */
function sweepCondemns(e: any): boolean {
  const shouldBeDealing = true;
  const parkedOnPurpose = e.isParkedByDesign();
  return shouldBeDealing && !parkedOnPurpose && zombieProgressAge(e) > ZOMBIE_MS;
}

/** Park at the gate the way both loops do, and report when the loop is back. */
function parkAtGate(e: any): { back: () => boolean; done: Promise<void> } {
  let returned = false;
  const done = (e.awaitPauseGate() as Promise<void>).then(() => {
    returned = true;
  });
  return { back: () => returned, done };
}

describe('every deliberate-park exit restarts the clock at the release instant', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUILT);
  });
  afterEach(() => vi.useRealTimers());

  it('the prepared-launch deal hold (the production path, 390 s lead)', async () => {
    const e = engineBetweenHands();
    e.holdDealingUntil(START);
    while (e.dealHoldUntilMs > Date.now()) {
      const slice = e.waitOneDealHoldSlice();
      await vi.advanceTimersByTimeAsync(1000);
      await slice;
    }
    expect(Date.now()).toBeGreaterThanOrEqual(START);
    expect(e.isParkedByDesign()).toBe(false);
    expect(e.msSinceProgress()).toBeLessThanOrEqual(1000);
    expect(sweepCondemns(e)).toBe(false);
  });

  it('the maintenance-break thaw', async () => {
    const e = engineBetweenHands();
    e.pauseForMaintenance(10 * 60_000);
    const gate = parkAtGate(e);
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    expect(gate.back()).toBe(false);
    expect(sweepCondemns(e)).toBe(false); // parked: exempt
    e.resumeFromMaintenance();
    await gate.done;
    expect(e.isPausedByDesign()).toBe(false);
    expect(e.msSinceProgress()).toBe(0);
    expect(sweepCondemns(e)).toBe(false);
  });

  it('hand-for-hand / the tournament break, released by its manager', async () => {
    const e = engineBetweenHands();
    e.pauseAfterHand(10 * 60_000, { beforeNextHand: true });
    const gate = parkAtGate(e);
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    e.resumeDealing();
    await gate.done;
    expect(e.isPausedByDesign()).toBe(false);
    expect(sweepCondemns(e)).toBe(false);
  });

  it("the pause gate's own safety timeout", async () => {
    const e = engineBetweenHands();
    // A break armed with its own budget; the manager's release comes late.
    e.pauseAfterHand(LEAD_MS, { beforeNextHand: true });
    const gate = parkAtGate(e);
    await vi.advanceTimersByTimeAsync(LEAD_MS + 1);
    await gate.done; // the gate let the loop go by itself
    // The loop is back and alive: its clock starts now, not at the park.
    expect(e.msSinceProgress()).toBeLessThanOrEqual(1);
    // The late release then reaches a table no longer at the gate - it gives
    // no credit of its own (2026-09-18) - and the table must still be live.
    e.resumeDealing();
    expect(e.isPausedByDesign()).toBe(false);
    expect(sweepCondemns(e)).toBe(false);
  });

  it('an operator admin pause, resumed after the 180 s window', async () => {
    const e = engineBetweenHands();
    toRunning(e);
    e.adminPause('floor check');
    e.tableFSM.transition('paused'); // what the loop's lock branch does
    while (Date.now() < START) {
      const slice = e.waitOneAdminLockSlice();
      await vi.advanceTimersByTimeAsync(3000);
      await slice;
    }
    e.adminResume();
    expect(e.tableFSM.state).toBe('running');
    expect(e.isParkedByDesign()).toBe(false);
    expect(e.msSinceProgress()).toBeLessThanOrEqual(3000);
    expect(sweepCondemns(e)).toBe(false);
  });

  it('a maintenance lock, lifted after the 180 s window', async () => {
    const e = engineBetweenHands();
    toRunning(e);
    e.setMaintenanceLock(true);
    while (Date.now() < START) {
      const slice = e.waitOneAdminLockSlice();
      await vi.advanceTimersByTimeAsync(3000);
      await slice;
    }
    e.setMaintenanceLock(false);
    expect(e.isParkedByDesign()).toBe(false);
    expect(sweepCondemns(e)).toBe(false);
  });
});

describe('the detector still condemns a genuinely stuck table', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUILT);
  });
  afterEach(() => vi.useRealTimers());

  it('a released table that then makes no progress is condemned after 180 s', async () => {
    const e = engineBetweenHands();
    e.holdDealingUntil(START);
    while (e.dealHoldUntilMs > Date.now()) {
      const slice = e.waitOneDealHoldSlice();
      await vi.advanceTimersByTimeAsync(1000);
      await slice;
    }
    vi.setSystemTime(Date.now() + ZOMBIE_MS - 1_000);
    expect(sweepCondemns(e)).toBe(false);
    vi.setSystemTime(Date.now() + 2_000);
    expect(sweepCondemns(e)).toBe(true);
  });

  it('a gate-released table that then freezes is condemned after 180 s', async () => {
    const e = engineBetweenHands();
    e.pauseForMaintenance(10 * 60_000);
    const gate = parkAtGate(e);
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    e.resumeFromMaintenance();
    await gate.done;
    vi.setSystemTime(Date.now() + ZOMBIE_MS + 1_000);
    expect(sweepCondemns(e)).toBe(true);
  });

  it('a table frozen between hands that never reached the gate earns no credit', () => {
    const e = engineBetweenHands();
    e.pauseForMaintenance(10 * 60_000); // flag raised, loop stuck elsewhere
    vi.setSystemTime(START);
    e.resumeFromMaintenance();
    expect(e.msSinceProgress()).toBe(LEAD_MS);
    expect(sweepCondemns(e)).toBe(true);
  });

  it('a stopped engine earns nothing from an admin-lock slice', async () => {
    const e = engineBetweenHands();
    e.adminPause();
    vi.setSystemTime(START);
    const slice = e.waitOneAdminLockSlice();
    e.running = false;
    await vi.advanceTimersByTimeAsync(3000);
    await slice;
    expect(e.msSinceProgress()).toBeGreaterThan(ZOMBIE_MS);
  });
});

describe('the wiring the behaviour above depends on', () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), 'utf8');
  const BASE = read('ServerTableEngineBase.ts');
  const DEALING = read('ServerTableEngineDealing.ts');
  const GAME_SERVER = read('../GameServer.ts');

  it('the pause gate stamps progress after the loop comes back from it', () => {
    const start = BASE.indexOf('protected async awaitPauseGate');
    const body = BASE.slice(start, BASE.indexOf('\n  }\n', start));
    const wait = body.lastIndexOf('await new Promise<void>');
    expect(wait).toBeGreaterThan(-1);
    expect(body.lastIndexOf('if (this.lifecycleCanMutate()) this.markProgress();')).toBeGreaterThan(
      wait
    );
  });

  it('the dealing loop waits an admin or maintenance lock out through the stamping slice', () => {
    expect(DEALING).toMatch(
      /if \(this\.adminPauseLock \|\| this\.maintenanceLock\) \{[^}]*\}\s*await this\.waitOneAdminLockSlice\(\);\s*continue;\s*\}/
    );
    const slice = DEALING.slice(DEALING.indexOf('protected async waitOneAdminLockSlice'));
    const body = slice.slice(0, slice.indexOf('\n  }\n'));
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
