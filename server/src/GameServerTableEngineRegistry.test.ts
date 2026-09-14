import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameServer as GameServerType } from './GameServer.js';
import type { ServerTableEngine } from './engine/ServerTableEngine.js';

vi.mock('./services/errorReporter.js', () => ({ reportError: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('GameServer tournament table-engine ownership', () => {
  it('does not let a stale engine unregister the replacement now owning that table', async () => {
    // GameServer imports the production Supabase singleton. Supply the same
    // harmless test placeholder its client uses so this focused registry test
    // does not emit an unrelated missing-secret fatal report at module load.
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
    const [{ GameServer }, { tableStateHub }] = await Promise.all([
      import('./GameServer.js'),
      import('./transport/TableStateHub.js'),
    ]);
    const dropTable = vi.spyOn(tableStateHub, 'dropTable').mockImplementation(() => {});
    const tableId = 'table-1';
    const stale = {} as ServerTableEngine;
    const replacement = {} as ServerTableEngine;
    const registry = new Map<string, ServerTableEngine>([[tableId, replacement]]);
    const owned = new Set<string>([tableId]);
    const server = Object.assign(Object.create(GameServer.prototype), {
      tableEngines: registry,
      tournamentOwnedTables: owned,
    }) as GameServerType;

    expect(server.unregisterTableEngine(tableId, stale)).toBe(false);
    expect(registry.get(tableId)).toBe(replacement);
    expect(owned.has(tableId)).toBe(true);
    expect(dropTable).not.toHaveBeenCalled();

    expect(server.unregisterTableEngine(tableId, replacement)).toBe(true);
    expect(registry.has(tableId)).toBe(false);
    expect(owned.has(tableId)).toBe(false);
    expect(dropTable).toHaveBeenCalledOnce();
    expect(dropTable).toHaveBeenCalledWith(tableId);

    const alreadyAbsentId = 'table-already-absent';
    owned.add(alreadyAbsentId);
    expect(server.unregisterTableEngine(alreadyAbsentId, stale)).toBe(true);
    expect(owned.has(alreadyAbsentId)).toBe(false);
    expect(dropTable).toHaveBeenCalledTimes(2);
    expect(dropTable).toHaveBeenLastCalledWith(alreadyAbsentId);
  });
});

describe('replacement custody when shutdown wins the old-engine wait', () => {
  async function fixture() {
    const [{ GameServer }, { tableStateHub }, { reportError }] = await Promise.all([
      import('./GameServer.js'),
      import('./transport/TableStateHub.js'),
      import('./services/errorReporter.js'),
    ]);
    const drop = vi.spyOn(tableStateHub, 'dropTable').mockImplementation(() => {});
    let releaseOld!: () => void;
    const oldStopped = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const expected = {
      stop: vi.fn(() => oldStopped),
      hasClaimedTournamentMoveBoundary: vi.fn(() => false),
    } as unknown as ServerTableEngine;
    const registry = new Map<string, ServerTableEngine>([['table-1', expected]]);
    const owned = new Set(['table-1']);
    const server = Object.assign(Object.create(GameServer.prototype), {
      running: true,
      tableEngines: registry,
      tournamentOwnedTables: owned,
      maintenanceBreak: { adopt: vi.fn() },
    }) as GameServerType;
    return { server, registry, owned, expected, releaseOld, drop, reportError };
  }

  it.each([false, true])(
    'retains a rejected replacement unless physical release is %s',
    async (released) => {
      const f = await fixture();
      const failure = new Error('replacement teardown refused');
      const replacement = {
        stop: vi.fn().mockRejectedValue(failure),
        hasReleasedProcessOwnership: vi.fn(() => released),
      } as unknown as ServerTableEngine;
      const pending = f.server.replaceTableEngine('table-1', f.expected, replacement);
      (f.server as unknown as { running: boolean }).running = false;
      f.releaseOld();
      if (released) {
        await expect(pending).resolves.toBe(false);
        expect(f.registry.has('table-1')).toBe(false);
        expect(f.owned.has('table-1')).toBe(false);
        expect(f.drop).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toBe(failure);
        expect(f.registry.get('table-1')).toBe(replacement);
        expect(f.owned.has('table-1')).toBe(true);
        expect(f.drop).not.toHaveBeenCalled();
      }
      if (released) {
        expect(f.reportError).toHaveBeenCalledWith(
          failure,
          'GameServer.shutdown_replacement_cleanup_failed',
          { tableId: 'table-1' }
        );
      }
    }
  );

  it('keeps the exact replacement during its stop and preserves a later owner', async () => {
    const f = await fixture();
    let releaseNew!: () => void;
    let started!: () => void;
    const startedStop = new Promise<void>((resolve) => {
      started = resolve;
    });
    const newStopped = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const replacement = {
      stop: vi.fn(() => {
        started();
        return newStopped;
      }),
    } as unknown as ServerTableEngine;
    const pending = f.server.replaceTableEngine('table-1', f.expected, replacement);
    (f.server as unknown as { running: boolean }).running = false;
    f.releaseOld();
    await startedStop;
    expect(f.registry.get('table-1')).toBe(replacement);
    expect(f.owned.has('table-1')).toBe(true);
    expect(f.drop).not.toHaveBeenCalled();
    const successor = {} as ServerTableEngine;
    f.registry.set('table-1', successor);
    releaseNew();
    await expect(pending).resolves.toBe(false);
    expect(f.registry.get('table-1')).toBe(successor);
    expect(f.owned.has('table-1')).toBe(true);
    expect(f.drop).not.toHaveBeenCalled();
  });
});
