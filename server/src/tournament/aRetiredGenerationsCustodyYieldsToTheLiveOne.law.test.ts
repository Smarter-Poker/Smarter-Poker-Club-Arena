/**
 * LAW: A RETIRED GENERATION'S RETIREMENT RESERVATION YIELDS TO THE LIVE ONE
 * (2026-09-29).
 *
 * Production, 2026-09-29 01:14Z, engine fa480b9b: the $100 Freeroll 6:00 PM
 * (cb8f2dd1, 171 players) lost lease generation 83b3ec21 while break
 * e487977d (source table b6af1747, `park_requested`, custody claimed by
 * 83b3ec21 at revision 1) was waiting for seats. `withCustody` keeps such a
 * reservation so the SAME generation can replay it; the generation was then
 * stopped and its lease released, so nothing could ever present that
 * identity again. Every later admission (one every 20-40 s) resumed, met
 * `f06_retirement_custody_held` in `createManagedTableEngine(b6af1747)`,
 * fenced the dealers it had just built (`f06_engine_admission_fenced`) and
 * was released. No hand was dealt from 01:15Z. 87a68e55 (51 players, since
 * 23:20Z), 6a18ddaa (13), 1f918c8c (4) and 4ed38a9f were in the same loop.
 *
 * The durable layer already hands custody to the live generation: every F06
 * door is lease-fenced (`f06_authority`), `fn_f06_claim_custody` and
 * `fn_f06_admit_parked_movement` replace an old generation's custody by
 * revision CAS, and `fn_f06_hand_number_state` refuses every hand on a source
 * with an open break (`source_excluded`). Only the process-local reservation
 * had no successor. Now the live manager, before it builds any dealer, reads
 * each such break under ITS lease (`fn_f06_break_state`, the receipt) and
 * GameServer yields the reservation only when nothing of the old generation
 * remains in the process. Every other case still refuses.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  breakId = id(3),
  dead = id(4),
  live = id(5),
  custody = id(6);
const LIFECYCLE = '428628';

afterEach(() => {
  vi.restoreAllMocks();
});

function durableRow(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    reason: null,
    break_id: breakId,
    tournament_id: event,
    source_table_id: source,
    lifecycle: LIFECYCLE,
    state: 'park_requested',
    revision: '1',
    custody_id: custody,
    custody_generation: dead,
    terminal_handoff_required: false,
    members: [],
    ...overrides,
  };
}

async function world(row: Record<string, unknown> | Error = durableRow()) {
  const gate = new TournamentRetirementCustody<any>();
  // The retired generation's retirement that could not be acknowledged:
  // exactly what TournamentManager.retireTournamentBreak leaves when the
  // roster awaits seats.
  await expect(
    gate.withCustody(
      {
        tournamentId: event,
        breakId,
        tableId: source,
        tableIncarnation: LIFECYCLE,
        leaseGeneration: dead,
        custodyId: custody,
        durableRevision: '1',
      },
      new Map(),
      new Map(),
      () => true,
      async () => {
        throw new Error('F06 original roster awaits seats at the other open tables');
      },
      async () => {}
    )
  ).rejects.toThrow('awaits seats');
  expect(gate.admissionAllowed(source)).toBe(false);

  const server: any = Object.create(GameServer.prototype);
  Object.assign(server, {
    running: true,
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentRetirementCustody: gate,
    maintenanceBreak: { adopt: vi.fn() },
    tournamentEngines: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    drainedF06TournamentCustody: new Map(),
    durableMixedF06Custody: new Map(),
    mixedF06AdmissionContinuations: new Map(),
    tournamentDiagnosticRetirements: new Map(),
  });
  const manager: any = new TournamentManager(event, server, live, performance.now() + 3_600_000);
  Object.assign(manager, { running: true, eliminationSweepDeadlineAt: 0 });
  const token = {};
  manager.lifecycleEpoch.current = () => token;
  manager.lifecycleIsCurrent = () => true;
  manager.requestEliminationSweep = vi.fn(() => true);
  server.tournamentEngines.set(event, manager);

  const calls: Array<[string, any]> = [];
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
    calls.push([name, p]);
    if (name !== 'fn_f06_break_state') throw new Error(`unexpected ${name}`);
    if (row instanceof Error) return { data: null, error: { message: row.message } };
    return { data: row, error: null };
  }) as any);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return { gate, server, manager, token, calls };
}

describe("a retired generation's retirement reservation yields to the live one", () => {
  it('yields after the durable break row, read under the live lease, names the same break', async () => {
    const { gate, manager, token, calls } = await world();
    expect(() => manager.createManagedTableEngine(source)).toThrow('f06_retirement_custody_held');

    await manager.adoptAbandonedRetirementCustody(token);

    expect(calls).toEqual([
      [
        'fn_f06_break_state',
        expect.objectContaining({
          p_tournament_id: event,
          p_lease_generation: live,
          p_break_id: breakId,
        }),
      ],
    ]);
    expect(gate.admissionAllowed(source)).toBe(true);
    // The successor can build this table's dealer again; the durable
    // source_excluded guard (not modelled here) still refuses its hands until
    // the break it now owns is acknowledged.
    expect(() => manager.createManagedTableEngine(source)).not.toThrow();
    expect(manager.durableTournamentBreaks.get(breakId)?.revision).toBe('1');
    expect(manager.requestEliminationSweep).toHaveBeenCalledWith(
      'f06_abandoned_retirement_yielded'
    );
  });

  it('keeps refusing while anything of the old generation remains in the process', async () => {
    const cases: Array<(server: any, manager: any) => void> = [
      (server) => server.tournamentManagerPendingLeaseReleases.set(event, dead),
      (server) => server.tournamentManagerLeaseReleaseOperations.set(event, Promise.resolve(true)),
      (server) => server.drainedF06TournamentCustody.set(event, {}),
      (server) => server.durableMixedF06Custody.set(event, {}),
      (server) => server.mixedF06AdmissionContinuations.set(event, {}),
      (server) =>
        server.tournamentDiagnosticRetirements.set(
          event,
          new Set([{ getTournamentLeaseGeneration: () => dead }])
        ),
      (server) => {
        server.tournamentManagerQuarantine = {
          heldBy: () => ({ getTournamentLeaseGeneration: () => dead }),
        };
      },
      // The asking manager is not the registered one.
      (server) => server.tournamentEngines.set(event, {}),
      // An engine is still registered on the table.
      (server) => server.tableEngines.set(source, {}),
    ];
    for (const arrange of cases) {
      const { gate, server, manager, token, calls } = await world();
      arrange(server, manager);
      await manager.adoptAbandonedRetirementCustody(token);
      expect(gate.admissionAllowed(source)).toBe(false);
      expect(calls.length <= 1).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it('keeps refusing when the durable receipt is missing or names something else', async () => {
    const rows: Array<Record<string, unknown> | Error> = [
      new Error('TOURNAMENT_MANAGER_FENCED'),
      durableRow({ source_table_id: id(9) }),
      durableRow({ lifecycle: '428629' }),
    ];
    for (const row of rows) {
      const { gate, manager, token } = await world(row);
      await manager.adoptAbandonedRetirementCustody(token);
      expect(gate.admissionAllowed(source)).toBe(false);
      expect(() => manager.createManagedTableEngine(source)).toThrow('f06_retirement_custody_held');
      vi.restoreAllMocks();
    }
  });

  it("never yields the live generation's own reservation", async () => {
    const { gate, manager, token, calls } = await world();
    manager.tournamentLeaseGeneration = dead;
    await manager.adoptAbandonedRetirementCustody(token);
    expect(calls).toEqual([]);
    expect(gate.admissionAllowed(source)).toBe(false);
  });

  it('resume asks before it builds any dealer', () => {
    const base = readFileSync(
      fileURLToPath(new URL('./TournamentManagerBase.ts', import.meta.url)),
      'utf8'
    );
    const resume = base.slice(base.indexOf('private async resumeLifecycle('));
    const ask = resume.indexOf('await this.adoptAbandonedRetirementCustody(lifecycle);');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(resume.indexOf('this.createManagedTableEngine('));
    expect(ask).toBeLessThan(resume.indexOf('await this.createTablesAndSeatPlayers('));
  });
});
