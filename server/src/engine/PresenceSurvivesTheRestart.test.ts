/**
 * PRESENCE SURVIVES THE RESTART (disconnect audit item 2, 2026-09-04)
 *
 * The engine restarts at :55 every hour with every table parked between
 * hands, so there is never an incomplete hand snapshot to restore the
 * presence FSM from, and every seat booted CONNECTED with its strikes,
 * away-blind budget, sit-out reason and /away stamp wiped. Now the table
 * writes the FSM to engine_presence_parked when the break is announced and
 * again when it parks, and the next boot reads it back while it is fresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from '../testHelpers/sourceWindow.js';

const savePresenceAtPark = vi.fn().mockResolvedValue(true);
const loadPresenceFromPark = vi.fn().mockResolvedValue(null);

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    savePresenceAtPark: (...a: unknown[]) => savePresenceAtPark(...a),
    loadPresenceFromPark: (...a: unknown[]) => loadPresenceFromPark(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { DisconnectEngine } = await import('./DisconnectEngine.js');
const { PreciseActionTimer } = await import('./PreciseActionTimer.js');

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe('the FSM round-trips through its persisted entry with nothing lost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('strikes, the blind budget, the sit-out clock and reason, and the /away stamp all come back', () => {
    const before = new DisconnectEngine(new PreciseActionTimer());
    before.registerPlayer(TABLE, 'struck');
    before.registerPlayer(TABLE, 'satout');
    before.registerPlayer(TABLE, 'gone');
    // two strikes and one blind spent while away
    before.markDisconnected(TABLE, 'struck');
    before.getState(TABLE, 'struck')!.consecutiveTimeouts = 2;
    before.noteBlindChargedWhileAway(TABLE, 'struck', 'sb');
    // a forced sit-out that began four minutes ago
    before.sitOut(TABLE, 'satout', 'forced', Date.now() - 4 * 60_000);
    // a page-left seat
    before.markPageLeft(TABLE, 'gone');

    const persisted = JSON.parse(JSON.stringify(before.getFsmStatesForTable(TABLE)));
    expect(persisted.satout.sinceMs).toBe(Date.now() - 4 * 60_000);
    expect(persisted.satout.sitOutReason).toBe('forced');
    expect(persisted.struck.strikes).toBe(2);
    expect(persisted.struck.awayBlindSbCharged).toBe(true);
    expect(persisted.gone.pageLeftAtMs).toBe(Date.now());

    const after = new DisconnectEngine(new PreciseActionTimer());
    expect(after.restoreFsmStates(TABLE, persisted)).toBe(3);
    const struck = after.getState(TABLE, 'struck')!;
    expect(struck.consecutiveTimeouts).toBe(2);
    expect(struck.awayBlindSbCharged).toBe(true);
    expect(struck.awayBlindBbCharged).toBe(false);
    const satout = after.getState(TABLE, 'satout')!;
    expect(satout.isSittingOut).toBe(true);
    expect(satout.sitOutReason).toBe('forced');
    expect(satout.sitOutSince).toBe(Date.now() - 4 * 60_000);
    // ...so the 5-minute clock fires one minute later, not five.
    vi.advanceTimersByTime(61_000);
    expect(after.tickSitOutsAndCollectEvictions(TABLE, ['satout'])).toEqual(['satout']);
    expect(after.getState(TABLE, 'gone')!.pageLeftAt).toBe(
      new Date('2026-09-04T12:00:00Z').getTime()
    );
    expect(after.isAway(TABLE, 'gone')).toBe(true);
  });

  it('an older snapshot without the carried fields still restores as before', () => {
    const after = new DisconnectEngine(new PreciseActionTimer());
    const n = after.restoreFsmStates(TABLE, {
      old: { state: 'SAT_OUT', sinceMs: Date.now() - 1000, graceDeadlineMs: null },
    });
    expect(n).toBe(1);
    const s = after.getState(TABLE, 'old')!;
    expect(s.isSittingOut).toBe(true);
    expect(s.sitOutSince).toBe(Date.now() - 1000);
    expect(s.sitOutReason).toBe('voluntary');
    expect(s.consecutiveTimeouts).toBe(0);
  });
});

describe('the break writes the FSM, the boot reads it', () => {
  beforeEach(() => {
    savePresenceAtPark.mockClear();
    loadPresenceFromPark.mockClear();
  });

  it('pauseForMaintenance persists every tracked seat for this table', async () => {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.disconnectEngine.registerPlayer(TABLE, 'a');
    engine.disconnectEngine.registerPlayer(TABLE, 'b');
    engine.pauseForMaintenance(120_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(savePresenceAtPark).toHaveBeenCalledTimes(1);
    const arg = savePresenceAtPark.mock.calls[0][0];
    expect(arg.tableId).toBe(TABLE);
    expect(Object.keys(arg.disconnectStates).sort()).toEqual(['a', 'b']);
    expect(arg.engineInstance).toMatch(/:announced$/);
  });

  it('a table with nobody tracked writes nothing', async () => {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.pauseForMaintenance(120_000);
    await Promise.resolve();
    expect(savePresenceAtPark).not.toHaveBeenCalled();
  });

  it('start() reads the park when there was no crash snapshot, and the loop persists when it parks', () => {
    const base = readFileSync(resolve(__dirname, 'ServerTableEngineBase.ts'), 'utf8');
    // The block that runs only when checkCrashRecovery found nothing.
    const noCrash = sliceBlockAfter(base, 'if (!recovered) {');
    expect(noCrash).toMatch(/loadPresenceFromPark\(this\.tableId\)/);
    expect(noCrash).toMatch(/restoreFsmStates\(this\.tableId, parked\)/);
    const dealing = readFileSync(resolve(__dirname, 'ServerTableEngineDealing.ts'), 'utf8');
    // The gate that parks the loop for the break.
    const park = sliceBlockAfter(
      dealing,
      'if (this.maintenancePaused || (this.handForHandPaused && this.holdBeforeNextHand)) {'
    );
    expect(park).toMatch(
      /if \(this\.maintenancePaused\) await this\.persistPresenceForRestart\('parked'\);/
    );
    // ...and it persists BEFORE it waits on the gate, or the process may be
    // gone before the write.
    expect(park.indexOf('persistPresenceForRestart')).toBeLessThan(park.indexOf('awaitPauseGate'));
  });
});
