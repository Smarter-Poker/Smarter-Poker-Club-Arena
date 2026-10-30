import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('./http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('./http/rateLimit.js', () => ({ checkRateLimit: vi.fn(() => true) }));
import { GameServer } from './GameServer.js';
import { ServerTableEngine } from './engine/ServerTableEngine.js';

/**
 * 2026-10-29: the serving engine exhausted its main-isolate V8 heap twice in
 * one day. `GameServer.weeklyPayoutTableListeners` (PR #8474) was a strong
 * `Map<ServerTableEngine, unsubscribe>` that gained one entry per adopted
 * engine generation and lost entries only at process shutdown, so every
 * retired tournament table, lease-loss replacement and cash rebuild stayed
 * reachable with its whole object graph. These cases pin the repair: the
 * registry is never a strong owner, and every registry exit releases the
 * engine's weekly-payout subscription.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function listeners(engine: any): Set<() => void> {
  return engine.weeklyPayoutBoundaryListeners;
}

function server(): any {
  return new GameServer() as any;
}

function engineFor(tableId: string): any {
  return new ServerTableEngine(tableId) as any;
}

describe('weekly-payout custody releases retired table engines', () => {
  it('never owns an engine strongly', () => {
    const gameServer = server();
    expect(gameServer.weeklyPayoutTableListeners).toBeInstanceOf(WeakMap);
    expect(typeof gameServer.weeklyPayoutTableListeners.clear).toBe('undefined');
  });

  it('subscribes once per adoption and unsubscribes when a closed tournament table leaves', () => {
    const gameServer = server();
    const engine = engineFor('weekly-custody-closed');
    gameServer.tableEngines.set('weekly-custody-closed', engine);
    gameServer.adoptWeeklyPayout(engine);
    gameServer.adoptWeeklyPayout(engine);
    expect(listeners(engine).size).toBe(1);
    expect(gameServer.weeklyPayoutTableListeners.has(engine)).toBe(true);

    expect(gameServer.unregisterTableEngine('weekly-custody-closed', engine)).toBe(true);
    expect(gameServer.tableEngines.has('weekly-custody-closed')).toBe(false);
    expect(listeners(engine).size).toBe(0);
    expect(gameServer.weeklyPayoutTableListeners.has(engine)).toBe(false);

    // A repeated release of an already absent slot is an idempotent success.
    expect(gameServer.unregisterTableEngine('weekly-custody-closed', engine)).toBe(true);
    expect(listeners(engine).size).toBe(0);
  });

  it('keeps a quarantined incumbent subscribed when a stale generation asks to leave', () => {
    const gameServer = server();
    const incumbent = engineFor('weekly-custody-stale');
    const stale = engineFor('weekly-custody-stale');
    gameServer.tableEngines.set('weekly-custody-stale', incumbent);
    gameServer.adoptWeeklyPayout(incumbent);
    gameServer.adoptWeeklyPayout(stale);

    expect(gameServer.unregisterTableEngine('weekly-custody-stale', stale)).toBe(false);
    expect(gameServer.tableEngines.get('weekly-custody-stale')).toBe(incumbent);
    expect(listeners(incumbent).size).toBe(1);
    expect(gameServer.weeklyPayoutTableListeners.has(incumbent)).toBe(true);
  });

  it('unsubscribes the exact tournament generation a retiring manager releases', () => {
    const gameServer = server();
    gameServer.running = true;
    const engine = engineFor('weekly-custody-tournament');
    expect(gameServer.registerTableEngine('weekly-custody-tournament', engine)).toBe(true);
    expect(listeners(engine).size).toBe(1);

    expect(gameServer.unregisterTournamentTableEngine('weekly-custody-tournament', engine)).toBe(
      true
    );
    expect(gameServer.tableEngines.has('weekly-custody-tournament')).toBe(false);
    expect(gameServer.tournamentOwnedTables.has('weekly-custody-tournament')).toBe(false);
    expect(listeners(engine).size).toBe(0);
    expect(gameServer.weeklyPayoutTableListeners.has(engine)).toBe(false);
  });

  it('moves the subscription from a replaced generation to its replacement', async () => {
    const gameServer = server();
    gameServer.running = true;
    const expected = engineFor('weekly-custody-replace');
    const replacement = engineFor('weekly-custody-replace');
    expect(gameServer.registerTableEngine('weekly-custody-replace', expected)).toBe(true);
    expect(listeners(expected).size).toBe(1);

    await expect(
      gameServer.replaceTableEngine('weekly-custody-replace', expected, replacement)
    ).resolves.toBe(true);
    expect(gameServer.tableEngines.get('weekly-custody-replace')).toBe(replacement);
    expect(listeners(expected).size).toBe(0);
    expect(gameServer.weeklyPayoutTableListeners.has(expected)).toBe(false);
    expect(listeners(replacement).size).toBe(1);
    expect(gameServer.weeklyPayoutTableListeners.has(replacement)).toBe(true);
  });

  it('releases a cash generation retired by direct recovery', async () => {
    const gameServer = server();
    const engine = engineFor('weekly-custody-cash');
    gameServer.tableEngines.set('weekly-custody-cash', engine);
    gameServer.adoptWeeklyPayout(engine);
    expect(listeners(engine).size).toBe(1);

    // Deferred re-admission retires the generation and schedules the table's
    // own recovery turn instead of admitting a successor through the database.
    gameServer.running = true;
    try {
      await gameServer.performDirectTableEngineRecovery(
        'weekly-custody-cash',
        engine,
        'test',
        true
      );
      expect(gameServer.tableEngines.has('weekly-custody-cash')).toBe(false);
      expect(listeners(engine).size).toBe(0);
      expect(gameServer.weeklyPayoutTableListeners.has(engine)).toBe(false);
    } finally {
      gameServer.clearDirectTableRecovery('weekly-custody-cash');
      gameServer.running = false;
    }
  });

  it('releases every engine still published when weekly payout custody stops', async () => {
    const gameServer = server();
    const first = engineFor('weekly-custody-stop-1');
    const second = engineFor('weekly-custody-stop-2');
    gameServer.tableEngines.set('weekly-custody-stop-1', first);
    gameServer.tableEngines.set('weekly-custody-stop-2', second);
    gameServer.adoptWeeklyPayout(first);
    gameServer.adoptWeeklyPayout(second);
    expect(listeners(first).size).toBe(1);
    expect(listeners(second).size).toBe(1);

    await gameServer.stopWeeklyPayout();
    expect(listeners(first).size).toBe(0);
    expect(listeners(second).size).toBe(0);
    expect(gameServer.weeklyPayoutTableListeners.has(first)).toBe(false);
    expect(gameServer.weeklyPayoutTableListeners.has(second)).toBe(false);
  });
});
