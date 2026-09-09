import { describe, expect, it, vi } from 'vitest';
import {
  admitOwnedTableEngine,
  replaceOwnedTableEngine,
  stopOwnedTournamentManager,
  unregisterOwnedTournamentTableEngine,
} from './TournamentManagerOwnership.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('stopOwnedTournamentManager', () => {
  it('awaits teardown before releasing the owned slot', async () => {
    const teardown = deferred();
    const manager = { stop: vi.fn(() => teardown.promise) };
    const managers = new Map([['tournament', manager]]);

    const retiring = stopOwnedTournamentManager(managers, 'tournament', manager);
    await Promise.resolve();
    expect(managers.get('tournament')).toBe(manager);

    teardown.resolve();
    await expect(retiring).resolves.toBe(true);
    expect(managers.has('tournament')).toBe(false);
  });

  it('cannot delete a replacement installed while old teardown is in flight', async () => {
    const teardown = deferred();
    const oldManager = { stop: vi.fn(() => teardown.promise) };
    const replacement = { stop: vi.fn(async () => undefined) };
    const managers = new Map([['tournament', oldManager]]);

    const retiring = stopOwnedTournamentManager(managers, 'tournament', oldManager);
    await Promise.resolve();
    managers.set('tournament', replacement);
    teardown.resolve();

    await expect(retiring).resolves.toBe(false);
    expect(managers.get('tournament')).toBe(replacement);
    expect(replacement.stop).not.toHaveBeenCalled();
  });

  it('does not stop a manager that no longer owns the slot', async () => {
    const stale = { stop: vi.fn(async () => undefined) };
    const replacement = { stop: vi.fn(async () => undefined) };
    const managers = new Map([['tournament', replacement]]);

    await expect(stopOwnedTournamentManager(managers, 'tournament', stale)).resolves.toBe(false);
    expect(stale.stop).not.toHaveBeenCalled();
    expect(managers.get('tournament')).toBe(replacement);
  });

  it('keeps a failed teardown quarantined instead of admitting overlap', async () => {
    const failure = new Error('table teardown failed');
    const manager = { stop: vi.fn(async () => Promise.reject(failure)) };
    const onStopError = vi.fn();
    const managers = new Map([['tournament', manager]]);

    await expect(
      stopOwnedTournamentManager(managers, 'tournament', manager, onStopError)
    ).resolves.toBe(false);
    expect(onStopError).toHaveBeenCalledWith(failure);
    expect(managers.get('tournament')).toBe(manager);
  });
});

describe('unregisterOwnedTournamentTableEngine', () => {
  it('atomically releases the exact stopped engine and its tournament classification', () => {
    const engine = {};
    const engines = new Map([['table', engine]]);
    const tournamentTables = new Set(['table']);
    const onReleased = vi.fn();

    expect(
      unregisterOwnedTournamentTableEngine(engines, tournamentTables, 'table', engine, onReleased)
    ).toBe(true);
    expect(engines.has('table')).toBe(false);
    expect(tournamentTables.has('table')).toBe(false);
    expect(onReleased).toHaveBeenCalledOnce();
  });

  it('cannot remove or declassify a successor engine', () => {
    const retired = {};
    const successor = {};
    const engines = new Map([['table', successor]]);
    const tournamentTables = new Set(['table']);
    const onReleased = vi.fn();

    expect(
      unregisterOwnedTournamentTableEngine(engines, tournamentTables, 'table', retired, onReleased)
    ).toBe(false);
    expect(engines.get('table')).toBe(successor);
    expect(tournamentTables.has('table')).toBe(true);
    expect(onReleased).not.toHaveBeenCalled();
  });
});

describe('table-engine generation admission', () => {
  it('admits one generation synchronously and fails closed for an independent caller', () => {
    const incumbent = { stop: vi.fn(async () => undefined) };
    const contender = { stop: vi.fn(async () => undefined) };
    const engines = new Map<string, typeof incumbent>();
    const tournamentTables = new Set<string>();

    expect(admitOwnedTableEngine(engines, tournamentTables, 'table', incumbent)).toBe(true);
    expect(admitOwnedTableEngine(engines, tournamentTables, 'table', contender)).toBe(false);
    expect(engines.get('table')).toBe(incumbent);
    expect(tournamentTables.has('table')).toBe(true);
    expect(incumbent.stop).not.toHaveBeenCalled();
    expect(contender.stop).not.toHaveBeenCalled();
  });

  it('keeps the incumbent installed until its teardown has completed', async () => {
    const teardown = deferred();
    const incumbent = { stop: vi.fn(() => teardown.promise) };
    const replacement = { stop: vi.fn(async () => undefined) };
    const engines = new Map([['table', incumbent]]);
    const tournamentTables = new Set(['table']);

    const replacing = replaceOwnedTableEngine(
      engines,
      tournamentTables,
      'table',
      incumbent,
      replacement
    );
    await Promise.resolve();
    expect(engines.get('table')).toBe(incumbent);

    teardown.resolve();
    await expect(replacing).resolves.toBe(true);
    expect(engines.get('table')).toBe(replacement);
    expect(tournamentTables.has('table')).toBe(true);
  });

  it('cannot overwrite a generation that won the race while teardown was in flight', async () => {
    const teardown = deferred();
    const incumbent = { stop: vi.fn(() => teardown.promise) };
    const replacement = { stop: vi.fn(async () => undefined) };
    const winner = { stop: vi.fn(async () => undefined) };
    const engines = new Map([['table', incumbent]]);
    const tournamentTables = new Set(['table']);

    const replacing = replaceOwnedTableEngine(
      engines,
      tournamentTables,
      'table',
      incumbent,
      replacement
    );
    await Promise.resolve();
    engines.set('table', winner);
    teardown.resolve();

    await expect(replacing).resolves.toBe(false);
    expect(engines.get('table')).toBe(winner);
    expect(replacement.stop).not.toHaveBeenCalled();
  });

  it('rechecks an admission quarantine after teardown before publishing the replacement', async () => {
    const teardown = deferred();
    const incumbent = { stop: vi.fn(() => teardown.promise) };
    const replacement = { stop: vi.fn(async () => undefined) };
    const engines = new Map([['table', incumbent]]);
    const tournamentTables = new Set(['table']);
    let allowed = true;

    const replacing = replaceOwnedTableEngine(
      engines,
      tournamentTables,
      'table',
      incumbent,
      replacement,
      () => allowed
    );
    await Promise.resolve();
    allowed = false;
    teardown.resolve();

    await expect(replacing).resolves.toBe(false);
    expect(engines.get('table')).toBe(incumbent);
  });

  it('leaves a failed teardown quarantined and propagates its failure', async () => {
    const failure = new Error('could not flush snapshot');
    const incumbent = { stop: vi.fn(async () => Promise.reject(failure)) };
    const replacement = { stop: vi.fn(async () => undefined) };
    const engines = new Map([['table', incumbent]]);
    const tournamentTables = new Set(['table']);

    await expect(
      replaceOwnedTableEngine(engines, tournamentTables, 'table', incumbent, replacement)
    ).rejects.toBe(failure);
    expect(engines.get('table')).toBe(incumbent);
    expect(replacement.stop).not.toHaveBeenCalled();
  });
});
