import { describe, expect, it, vi } from 'vitest';
import type { GameServer as GameServerType } from './GameServer.js';
import type { ServerTableEngine } from './engine/ServerTableEngine.js';

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
    // Both engines model a stopped table session that never parked a time
    // bank. For one of those the real
    // ServerTableEngineBase.hasUnretiredStoppedTimeBankCustody() is false - no
    // stopped capture, no pending accounting, no outstanding presence write -
    // so retireStoppedTimeBanksForClosedSession() takes its first branch,
    // returns true and mutates nothing. The refusal branch, a closed session
    // still holding an unretired capture, is pinned against the real class in
    // engine/ParkedTimeBank.test.ts.
    const stoppedEngineWithNoParkedBank = (): ServerTableEngine => {
      const hasUnretiredStoppedTimeBankCustody = () => false;
      return {
        hasUnretiredStoppedTimeBankCustody,
        retireStoppedTimeBanksForClosedSession: () => !hasUnretiredStoppedTimeBankCustody(),
      } as ServerTableEngine;
    };
    const stale = stoppedEngineWithNoParkedBank();
    const replacement = stoppedEngineWithNoParkedBank();
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
