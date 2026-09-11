import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let tableStateHub: (typeof import('../transport/TableStateHub.js'))['tableStateHub'];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tableStateHub } = await import('../transport/TableStateHub.js'));
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T12:10:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(tableStateHub, 'emitEvent').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function manager(row: Record<string, any>, tableIds: string[]) {
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: 'level-restart',
    tournamentCache: structuredClone(row),
    running: true,
    currentLevel: row.current_level,
    onBreak: false,
    addOnBreakActive: false,
    blindTimer: null,
    blindTimerStartedAt: Date.parse(row.level_started_at),
    tableEngines: new Map(tableIds.map((id) => [id, {}])),
    lifecycleEpoch: { current: () => 1, isCurrent: () => state.running },
    lifecycleIsCurrent: () => state.running,
    assertLifecycleCurrent: () => {
      if (!state.running) throw new Error('stale manager');
    },
    createManagedTableEngine: () => ({ setHub: vi.fn() }),
    wireEliminationWake: vi.fn(),
    admitManagedTableEngine: vi.fn(),
    startManagedTableEngine: vi.fn(),
    restoreDrawnFirstButtons: vi.fn().mockResolvedValue(undefined),
    drainTableEngineStartJobs: vi.fn().mockResolvedValue(undefined),
    startEliminationChecker: vi.fn(),
    unregisterEliminationScheduler: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
    trackLifecycleJob: (promise: Promise<unknown>) => promise,
    setLifecycleTimeout: (callback: () => unknown, delay: number) => ({ callback, delay }),
    clearLifecycleTimeout: vi.fn(),
  });
  return state;
}

describe('durable blind-level transition', () => {
  it.each(['stopped', 'continued'])(
    'keeps one level deadline after publication with the manager %s',
    async (mode) => {
      const structure = [
        { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
        { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
      ];
      const row: Record<string, any> = {
        starting_chips: 1000,
        current_level: 0,
        level_started_at: '2026-09-10T12:00:00.000Z',
        blind_structure: structure,
        on_break: false,
        prize_pool_finalized: true,
      };
      const tableIds = ['table-one', 'table-two'];
      const tables = new Map(
        tableIds.map((id) => [id, { small_blind: 25, big_blind: 50, ante: 0, stakes: '25/50' }])
      );
      const old = manager(row, tableIds);
      old.broadcast.mockImplementation(async () => {
        vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
      });
      vi.spyOn(supabase, 'from').mockImplementation(
        (relation: string) =>
          ({
            update: (patch: Record<string, unknown>) => ({
              eq: async (_column: string, id: string) => {
                if (relation === 'tournaments') {
                  Object.assign(row, patch);
                  if ('current_level' in patch && mode === 'stopped') old.running = false;
                } else if (relation === 'tables') {
                  Object.assign(tables.get(id)!, patch);
                } else throw new Error('unexpected write: ' + relation);
                return { error: null };
              },
            }),
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: structuredClone(row), error: null }),
                in: async () => ({ data: tableIds.map((id) => ({ id })), error: null }),
              }),
            }),
          }) as never
      );
      await old.advanceBlindLevel(structure);
      if (mode === 'stopped') expect(old.blindTimer).toBeNull();
      expect(row.current_level).toBe(1);
      for (const table of tables.values()) {
        expect(table).toEqual({ small_blind: 50, big_blind: 100, ante: 0, stakes: '50/100' });
      }

      vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
      const replacement = mode === 'stopped' ? manager(row, []) : old;
      if (mode === 'stopped') await replacement.resumeLifecycle(1);
      expect(replacement.running).toBe(true);
      expect(replacement.currentLevel).toBe(1);
      expect([...replacement.tableEngines.keys()]).toEqual(tableIds);
      expect(replacement.resolveBlindLevel(row.blind_structure, replacement.currentLevel)).toEqual(
        structure[1]
      );
      expect(replacement.blindTimer?.delay).toBe(598_000);
      expect(row.level_started_at).toBe('2026-09-10T12:10:00.000Z');
    }
  );
});

describe('blind rows at manager recovery', () => {
  it.each(['repaired', 'unavailable'])(
    'reconciles persisted blinds before any dealer admission when the table write is %s',
    async (mode) => {
      const structure = [
        { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
        { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
      ];
      const row: Record<string, any> = {
        starting_chips: 1000,
        current_level: 0,
        level_started_at: '2026-09-10T12:00:00.000Z',
        blind_structure: structure,
        on_break: false,
        prize_pool_finalized: true,
      };
      const tableIds = ['table-one', 'table-two'];
      const tables = new Map(
        tableIds.map((id) => [id, { small_blind: 25, big_blind: 50, ante: 0, stakes: '25/50' }])
      );
      const expected = { small_blind: 50, big_blind: 100, ante: 0, stakes: '50/100' };
      const old = manager(row, tableIds);
      let recovering = false;
      const recoveryWrites: string[] = [];
      vi.spyOn(supabase, 'from').mockImplementation(
        (relation: string) =>
          ({
            update: (patch: Record<string, unknown>) => ({
              eq: async (_column: string, id: string) => {
                if (relation === 'tournaments') Object.assign(row, patch);
                else if (relation === 'tables') {
                  if (recovering) recoveryWrites.push(id);
                  if (id === 'table-two' && (!recovering || mode === 'unavailable')) {
                    return { error: { message: 'table blind write unavailable' } };
                  }
                  Object.assign(tables.get(id)!, patch);
                } else throw new Error('unexpected write: ' + relation);
                return { error: null };
              },
            }),
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: structuredClone(row), error: null }),
                in: async () => ({
                  data: tableIds.map((id) => ({ id, ...tables.get(id) })),
                  error: null,
                }),
              }),
            }),
          }) as never
      );
      await old.advanceBlindLevel(structure);
      expect(row.current_level).toBe(1);
      expect(tables.get('table-one')).toEqual(expected);
      expect(tables.get('table-two')?.big_blind).toBe(50);
      old.running = false;
      recovering = true;
      const replacement = manager(row, []);
      const admitted: unknown[][] = [];
      replacement.startManagedTableEngine.mockImplementation(() => {
        admitted.push(structuredClone([...tables.values()]));
      });
      await replacement.resumeLifecycle(1);
      expect(recoveryWrites).toEqual(['table-two']);

      if (mode === 'unavailable') {
        expect(admitted).toEqual([]);
        expect(replacement.running).toBe(false);
        expect(replacement.tableEngines.size).toBe(0);
      } else {
        expect(replacement.running).toBe(true);
        expect(admitted).toEqual([
          [expected, expected],
          [expected, expected],
        ]);
        expect(replacement.currentLevel).toBe(1);
      }
    }
  );
});
