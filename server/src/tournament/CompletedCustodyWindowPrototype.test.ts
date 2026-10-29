import { afterEach, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { TournamentManager } from './TournamentManager.js';
import {
  completeF06Custody,
  createCompletedF06DiagnosticWindow,
  appendCompletedF06DiagnosticWindow,
  inspectCompletedF06DiagnosticWindow,
  inspectCompletedF06OmittedHistory,
  COMPLETED_F06_DIAGNOSTIC_LIMIT,
} from './completedF06Custody.js';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc: vi.fn(() => {
      throw Error('Unexpected RPC');
    }),
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const id = (n: number) => `bb100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owners: any[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.fenceForTournamentLeaseLoss();
  vi.restoreAllMocks();
});
it('qualifies34 real released generations with32 retained seals and constant-size authentic omitted history', async () => {
  const game: any = Object.assign(Object.create(GameServer.prototype), {
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
  });
  let window = createCompletedF06DiagnosticWindow(id(1));
  const oldObjects: object[] = [];
  let lastPacket!: Parameters<typeof completeF06Custody>[0];
  let firstEntry!: ReturnType<typeof completeF06Custody>;
  let lastEntry!: ReturnType<typeof completeF06Custody>;
  for (let n = 0; n < 34; n++) {
    const generation = id(100 + n);
    const owner: any = new TournamentManager(id(1), game, generation, performance.now() + 30000);
    owners.push(owner);
    const engine: any = new ServerTableEngine(id(2), {
      scope: 'tournament',
      verified: true,
      tournamentId: id(1),
      generation,
      proofDeadlineMonotonicMs: performance.now() + 30000,
    });
    engine.installF06Allocator(
      generation,
      async () => 1,
      () => true,
      '1'
    );
    await engine.stop();
    owner.tableEngines.set(id(2), engine);
    vi.spyOn(owner, 'resolveTournamentSeatMoveQuarantine').mockResolvedValue(false);
    owner.fenceForTournamentLeaseLoss();
    await expect(owner.stop()).rejects.toThrow('failed to stop');
    lastPacket = {
      manager: owner,
      tournamentId: id(1),
      originGeneration: generation,
      engines: owner.captureDrainedF06Originals(),
      sources: [],
      proof: {},
      current: () => true,
    };
    lastEntry = completeF06Custody(lastPacket, []);
    expect(lastEntry.status).toBe('sealed');
    if (n === 0) firstEntry = lastEntry;
    oldObjects.push(owner, engine);
    window = appendCompletedF06DiagnosticWindow(window, lastEntry);
    expect(window.sealed.length).toBeLessThanOrEqual(COMPLETED_F06_DIAGNOSTIC_LIMIT);
  }
  expect(appendCompletedF06DiagnosticWindow(window, firstEntry)).toBe(window);
  expect(appendCompletedF06DiagnosticWindow(window, lastEntry)).toBe(window);
  expect(window.sealed).toHaveLength(32);
  expect(window.omitted?.count).toBe(2);
  expect(Object.values(window.omitted!)).toHaveLength(5);
  expect(
    Object.values(window.omitted!).every((value) => ['string', 'number'].includes(typeof value))
  ).toBe(true);
  expect(inspectCompletedF06DiagnosticWindow(window, id(1))).toBe(window);
  expect(inspectCompletedF06OmittedHistory(window.omitted, id(1))).toBe(window.omitted);
  const reaches = (value: unknown, target: object, seen = new Set<unknown>()): boolean => {
    if (value === target) return true;
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((child) => reaches(child, target, seen));
  };
  for (const object of oldObjects) expect(reaches(window, object)).toBe(false);
  const copied = JSON.parse(JSON.stringify(window.omitted));
  expect(inspectCompletedF06OmittedHistory(copied, id(1))).toBeNull();
  expect(inspectCompletedF06OmittedHistory({ ...copied, processEpoch: id(999) }, id(1))).toBeNull();
  expect(inspectCompletedF06OmittedHistory(window.omitted, id(90))).toBeNull();
  expect(() =>
    appendCompletedF06DiagnosticWindow(JSON.parse(JSON.stringify(window)), lastEntry)
  ).toThrow('history unavailable');
  expect(() =>
    appendCompletedF06DiagnosticWindow(window, JSON.parse(JSON.stringify(lastEntry)))
  ).toThrow('seal unavailable');
  expect(window.omitted?.count).toBe(2);
  const priorWindow = window;
  const unsealed = completeF06Custody(lastPacket, null);
  window = appendCompletedF06DiagnosticWindow(window, unsealed);
  window = appendCompletedF06DiagnosticWindow(window, unsealed);
  expect(window.unsealed).toEqual([unsealed]);
  const unseenUnsealed = completeF06Custody(lastPacket, null);
  expect(() => appendCompletedF06DiagnosticWindow(priorWindow, unseenUnsealed)).toThrow(
    'history unavailable'
  );
  window = appendCompletedF06DiagnosticWindow(window, unseenUnsealed);
  expect(window.unsealed).toEqual([unsealed, unseenUnsealed]);
  expect(window.unsealed[0]).toBe(unsealed);
  const foreignPacket = { ...lastPacket, tournamentId: id(999) };
  const foreign = completeF06Custody(foreignPacket, null);
  expect(() => appendCompletedF06DiagnosticWindow(window, foreign)).toThrow(
    'original identity unavailable'
  );
  expect('original' in foreign && foreign.original).toBe(foreignPacket);
  const unreadablePacket = { ...lastPacket };
  Object.defineProperty(unreadablePacket, 'tournamentId', {
    get() {
      throw Error('identity unreadable');
    },
  });
  const unreadable = completeF06Custody(unreadablePacket, null);
  expect(() => appendCompletedF06DiagnosticWindow(window, unreadable)).toThrow(
    'original identity unavailable'
  );
  expect('original' in unreadable && unreadable.original).toBe(unreadablePacket);
  expect(window.unsealed).toEqual([unsealed, unseenUnsealed]);
  expect(window.omitted?.count).toBe(2);
  expect(inspectCompletedF06DiagnosticWindow(priorWindow, id(1))).toBeNull();
  expect(() => appendCompletedF06DiagnosticWindow(window, { ...unsealed })).toThrow(
    'seal unavailable'
  );
  expect(window.sealed).toHaveLength(32);
  expect(window.omitted?.count).toBe(2);
});
