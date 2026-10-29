import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { TournamentManager } from './TournamentManager.js';
import { completeF06Custody } from './completedF06Custody.js';
import { verifyTournamentCompletionReceipt } from './completionSettlementReceipt.js';
import { verifySatelliteQualifierReceipt } from './satelliteQualifierReceipt.js';
import nativeCohorts from './__fixtures__/satellite-qualifier-native-receipts.json';
import { verifySatelliteSettlementReceipt } from './satelliteSettlementReceipt.js';
import { accountingTerminalReceipts } from './__fixtures__/accountingTerminalReceipts.js';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc: vi.fn(() => {
      throw Error('Unexpected financial RPC');
    }),
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const id = (n: number) => `aa100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TID = id(1),
  GEN = id(2),
  TABLE = id(3),
  WINNER = id(4);
const managers: any[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const manager of managers.splice(0)) manager.fenceForTournamentLeaseLoss();
  vi.restoreAllMocks();
});
function server(): any {
  return Object.assign(Object.create(GameServer.prototype), {
    tournamentEngines: new Map(),
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    completedF06TournamentCustody: new Map(),
    completedF06DiagnosticWindows: new Map(),
    drainedF06TournamentCustody: new Map(),
    durableMixedF06Custody: new Map(),
    mixedF06AdmissionContinuations: new Map(),
  });
}
function engine(table: string, tournament = TID): any {
  const value = new ServerTableEngine(table, {
    scope: 'tournament',
    verified: true,
    tournamentId: tournament,
    generation: GEN,
    proofDeadlineMonotonicMs: performance.now() + 30000,
  });
  value.installF06Allocator(
    GEN,
    async () => 1,
    () => true,
    '1'
  );
  return value;
}
async function sealed(game: any, tournament = TID) {
  const owner: any = new TournamentManager(tournament, game, GEN, performance.now() + 30000);
  managers.push(owner);
  const original = engine(TABLE, tournament);
  await original.stop();
  owner.tableEngines.set(TABLE, original);
  vi.spyOn(owner, 'resolveTournamentSeatMoveQuarantine').mockResolvedValue(false);
  owner.fenceForTournamentLeaseLoss();
  await expect(owner.stop()).rejects.toThrow('failed to stop');
  const packet = {
    manager: owner,
    tournamentId: tournament,
    originGeneration: GEN,
    engines: owner.captureDrainedF06Originals(),
    sources: [],
    proof: {},
    current: () => true,
  };
  const entry = completeF06Custody(packet, []);
  expect(entry.status).toBe('sealed');
  return { entry, packet };
}
function receipt(kind: string) {
  if (kind === 'qualifiers') {
    const raw = structuredClone(nativeCohorts.two_survivors);
    raw.tournament_id = TID;
    raw.source_closeout.source_table_ids = [TABLE];
    return verifySatelliteQualifierReceipt(raw, TID, raw.qualifier_ids);
  }
  if (kind === 'satellite')
    return verifySatelliteSettlementReceipt(
      {
        receipt_version: 2,
        ok: true,
        fully_settled: true,
        status: 'COMPLETED',
        tournament_id: TID,
        target_id: id(5),
        winner_id: WINNER,
        field_size: 1,
        pool: 100,
        ticket_cost: 100,
        ticket_award_count: 1,
        seat_count: 0,
        cash_ticket_count: 1,
        entry_ticket_count: 0,
        awards: [
          {
            user_id: WINNER,
            position: 1,
            amount: 100,
            delivery_kind: 'cash',
            payout_id: id(6),
            registration_id: null,
            ticket_id: null,
          },
        ],
        seats: [],
        remainder: null,
        winner_amount: 100,
        source_table_count: 1,
        source_seat_count: 1,
        released_seat_count: 1,
        source_closeout: {
          source_table_count: 1,
          source_table_ids: [TABLE],
          source_seat_count: 1,
          source_seat_ids: [id(7)],
          released_seat_count: 1,
          released_seat_ids: [id(7)],
          closed_at: '2026-10-29T00:00:00Z',
        },
        settled_at: '2026-10-29T00:00:00Z',
      },
      TID,
      WINNER
    );
  const raw: any = JSON.parse(
    JSON.stringify(accountingTerminalReceipts[0]).replaceAll(
      accountingTerminalReceipts[0].tournament_id,
      TID
    )
  );
  raw.table_closure.closed_table_ids = [TABLE];
  if (kind === 'deal') {
    raw.mode = raw.settlement_mode = 'final_table_deal';
    raw.deal_shares = raw.cash.deal_shares = raw.payouts;
  }
  return verifyTournamentCompletionReceipt(
    raw,
    TID,
    kind === 'deal' ? 'final_table_deal' : 'places',
    raw.winner_id
  );
}
it.each([
  ['normal', false],
  ['satellite', false],
  ['deal', false],
  ['qualifiers', false],
  ['normal', true],
  ['satellite', true],
  ['deal', true],
  ['qualifiers', true],
] as const)(
  'retires authenticated sealed metadata only after real verified %s cleanup',
  async (kind, throwRetirement) => {
    const game = server();
    const { entry, packet } = await sealed(game);
    for (let n = 0; n < 34; n++) game.archiveCompletedF06Custody(packet, []);
    const windowBefore = game.completedF06DiagnosticWindows.get(TID);
    expect(windowBefore.omitted.count).toBe(2);
    const unsealed = completeF06Custody(packet, null);
    const foreign = (await sealed(game, id(90))).entry;
    game.completedF06TournamentCustody.set(TID, new Set([entry, unsealed, foreign]));
    const manager: any = new TournamentManager(TID, game, id(8), performance.now() + 30000);
    managers.push(manager);
    game.tournamentEngines.set(TID, manager);
    const live = engine(TABLE);
    manager.tableEngines.set(TABLE, live);
    game.tableEngines.set(TABLE, live);
    vi.spyOn(manager, 'broadcastCommittedOutcome').mockResolvedValue(undefined);
    vi.spyOn(manager, 'cleanupBroadcastChannel').mockResolvedValue(undefined);
    const verified = receipt(kind);
    expect(verified).not.toBeNull();
    const method =
      kind === 'qualifiers'
        ? 'cleanupCommittedSatelliteQualifiers'
        : kind === 'normal'
          ? 'cleanupCommittedTournament'
          : kind === 'satellite'
            ? 'cleanupCommittedSatellite'
            : 'settleFinalTableDeal';
    if (throwRetirement)
      vi.spyOn(game, 'retireCompletedF06CustodyMetadata').mockImplementationOnce(() => {
        throw Error('metadata unavailable');
      });
    await expect(manager[method](verified)).resolves.toBe(true);
    expect(live.getLifecycleDiagnosticSnapshot().terminal).toBe(true);
    expect(game.tableEngines.has(TABLE)).toBe(false);
    expect(game.completedF06TournamentCustody.get(TID)).toEqual(
      new Set(throwRetirement ? [entry, unsealed, foreign] : [unsealed, foreign])
    );
    expect(game.completedF06DiagnosticWindows.has(TID)).toBe(throwRetirement);
    if (throwRetirement) expect(game.completedF06DiagnosticWindows.get(TID)).toBe(windowBefore);
    expect(manager.tournamentFinished).toBe(true);
    expect(manager.committedSatelliteQualifierReceipt ?? null).toBeNull();
    expect(manager.committedFinishReceipt ?? null).toBeNull();
    expect(manager.committedSatelliteReceipt ?? null).toBeNull();
    expect(manager.committedFinalTableDealReceipt ?? null).toBeNull();
    if (throwRetirement) {
      const { reportError } = await import('../services/errorReporter.js');
      expect(reportError).toHaveBeenCalledTimes(1);
      vi.mocked(reportError).mockImplementationOnce(() => {
        throw Error('report unavailable');
      });
      game.retireCompletedF06CustodyMetadata.mockImplementationOnce(() => {
        throw Error('metadata unavailable');
      });
      expect(() => manager.retireCompletedCustodyAfterTerminalCleanup(TID)).not.toThrow();
    }
    const announcements = manager.broadcastCommittedOutcome.mock.calls.length;
    manager.retireCompletedCustodyAfterTerminalCleanup(TID);
    manager.retireCompletedCustodyAfterTerminalCleanup(TID);
    expect(manager.broadcastCommittedOutcome).toHaveBeenCalledTimes(announcements);
    const { supabase } = await import('../services/supabase/client.js');
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  }
);
it.each([
  'active',
  'mixed',
  'continuation',
  'stale-manager',
  'wrong-receipt',
  'unknown-index',
  'physical-owner',
  'copied-window',
  'unsealed-window',
])('preserves exact custody when terminal retirement is not owned: %s', async (reason) => {
  const game = server();
  const { entry, packet } = await sealed(game);
  const entries = new Set([entry]);
  game.completedF06TournamentCustody.set(TID, entries);
  const manager: any = new TournamentManager(TID, game, id(8), performance.now() + 30000);
  managers.push(manager);
  game.tournamentEngines.set(TID, manager);
  manager.fenceForTournamentLeaseLoss();
  if (reason === 'copied-window') game.completedF06DiagnosticWindows.set(TID, { schema: 'copied' });
  if (reason === 'unsealed-window') {
    const { createCompletedF06DiagnosticWindow, appendCompletedF06DiagnosticWindow } =
      await import('./completedF06Custody.js');
    const window = appendCompletedF06DiagnosticWindow(
      createCompletedF06DiagnosticWindow(TID),
      completeF06Custody(packet, null)
    );
    game.completedF06DiagnosticWindows.set(TID, window);
  }
  if (reason === 'active') game.drainedF06TournamentCustody.set(TID, packet);
  if (reason === 'mixed') game.durableMixedF06Custody.set(TID, {});
  if (reason === 'continuation') game.mixedF06AdmissionContinuations.set(TID, {});
  if (reason === 'unknown-index') game.durableMixedF06Custody = undefined;
  if (reason === 'physical-owner') manager.tableEngines.set(TABLE, packet.engines[0][1]);
  const result = game.retireCompletedF06CustodyMetadata(
    TID,
    reason === 'stale-manager' ? packet.manager : manager,
    reason === 'wrong-receipt' ? id(90) : TID
  );
  expect(result).toBe(0);
  expect(game.completedF06TournamentCustody.get(TID)).toBe(entries);
  expect(entries.has(entry)).toBe(true);
});
it('preserves metadata after physical or channel cleanup refuses', async () => {
  for (const refusal of ['physical', 'channel']) {
    const game = server();
    const { entry } = await sealed(game);
    const entries = new Set([entry]);
    game.completedF06TournamentCustody.set(TID, entries);
    const manager: any = new TournamentManager(TID, game, id(8), performance.now() + 30000);
    managers.push(manager);
    game.tournamentEngines.set(TID, manager);
    const live = engine(TABLE);
    manager.tableEngines.set(TABLE, live);
    game.tableEngines.set(TABLE, live);
    const extra = engine(id(99));
    if (refusal === 'physical') manager.tableEngines.set(id(99), extra);
    vi.spyOn(manager, 'broadcastCommittedOutcome').mockResolvedValue(undefined);
    vi.spyOn(manager, 'cleanupBroadcastChannel').mockImplementation(async () => {
      if (refusal === 'channel') throw Error('channel unavailable');
    });
    await expect(manager.cleanupCommittedTournament(receipt('normal'))).resolves.toBe(false);
    expect(game.completedF06TournamentCustody.get(TID)).toBe(entries);
    expect(entries.has(entry)).toBe(true);
    await extra.stop();
    await live.stop();
  }
});
