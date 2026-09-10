import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { UUID_SHAPE as UUID } from '../lib/uuidShape.js';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const source = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const methods = [
  'readFinalTableDealConsensus(',
  'checkFinalTableDeal(): Promise<boolean>',
  'completeFinalTableDealAtBoundary(\n    tableId: string,',
]
  .map((marker) => 'async ' + sliceMethod(source, marker))
  .join('\n');
const compiled = ts.transpileModule('class Probe { ' + methods + ' }\nreturn Probe;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const roster = [
  { user_id: id(1), chips: 100 },
  { user_id: id(2), chips: 200 },
];
const ready = () => ({
  ok: true,
  proposal_id: id(3),
  revision: 'a'.repeat(64),
  voter_ids: roster.map((p) => p.user_id),
  required: 2,
  ready: true,
});
class Refused extends Error {}
class Committed extends Error {}
class Unknown extends Error {}

function setup() {
  const rpc = vi.fn().mockResolvedValue({ data: ready(), error: null });
  const from = vi.fn(() => {
    const query: any = {
      select: () => query,
      eq: () => query,
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: roster, error: null }).then(resolve, reject),
    };
    return query;
  });
  const terminal = vi
    .fn()
    .mockResolvedValue({ dealShares: roster.map((p) => ({ userId: p.user_id, amount: 10 })) });
  const engine = {
    parkForTerminalCloseout: vi.fn().mockResolvedValue(true),
    releaseTerminalCloseoutPause: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
  };
  const Probe = new Function(
    'supabase',
    'UUID',
    'isMaintenanceFrozen',
    'requestTournamentTerminalReceipt',
    'TerminalSettlementRefusedError',
    'TerminalSettlementCommittedError',
    'TerminalSettlementOutcomeUnknownError',
    'reportError',
    'raiseFinancialAlert',
    'TournamentManagerEliminations',
    compiled
  )({ rpc, from }, UUID, () => false, terminal, Refused, Committed, Unknown, vi.fn(), vi.fn(), {
    FINAL_TABLE_DEAL_PAUSE_MS: 50,
  });
  const controller = Object.assign(new Probe(), {
    tournamentId: id(10),
    tournamentCache: { status: 'RUNNING', final_table_deal_enabled: true, table_size: 9 },
    lastDealPollAt: 0,
    lastDealVoteCount: 0,
    finalTableDealHandled: false,
    tournamentFinished: false,
    tableEngines: new Map([[id(20), engine]]),
    gameServer: { getTableEngine: () => engine },
    isOnBreak: () => false,
    handForHandActive: false,
    broadcast: vi.fn().mockResolvedValue(undefined),
    authoritativeFinalTableDealEngine: vi.fn().mockResolvedValue({ tableId: id(20), engine }),
    settleFinalTableDeal: vi.fn().mockResolvedValue(true),
  });
  return { controller, rpc, from, terminal, engine };
}

describe('final-table consent stays bound through the physical hand boundary', () => {
  it('requires the current proposal before parking and again before its bound terminal request', async () => {
    const { controller, rpc, from, terminal, engine } = setup();
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(rpc.mock.calls).toEqual([
      ['fn_get_tournament_deal_consensus', { p_tournament_id: id(10) }],
      ['fn_get_tournament_deal_consensus', { p_tournament_id: id(10) }],
    ]);
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(id(10), 'final_table_deal', null, {
      dealProposal: { proposalId: id(3), revision: 'a'.repeat(64) },
    });
    expect(from).not.toHaveBeenCalledWith('tournament_deal_votes');
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
      engine.parkForTerminalCloseout.mock.invocationCallOrder[0]
    );
    expect(engine.parkForTerminalCloseout.mock.invocationCallOrder[0]).toBeLessThan(
      rpc.mock.invocationCallOrder[1]
    );
    expect(rpc.mock.invocationCallOrder[1]).toBeLessThan(terminal.mock.invocationCallOrder[0]);
  });

  it.each([
    { ...ready(), ok: false },
    { ...ready(), proposal_id: null, revision: null, voter_ids: [], ready: false },
    { ...ready(), voter_ids: [id(1)], ready: false },
    { ...ready(), voter_ids: [id(1)] },
    { ...ready(), voter_ids: [id(1), id(1)] },
    { ...ready(), voter_ids: [id(1), id(99)] },
    { ...ready(), voter_ids: [id(1), 'not-an-id'] },
    { ...ready(), required: 3 },
    { ...ready(), required: '2' },
    { ...ready(), ready: 'true' },
    { ...ready(), proposal_id: 'stale' },
    { ...ready(), revision: 'not-a-revision' },
    { ...ready(), revision: 'A'.repeat(64) },
    { ...ready(), proposal_id: null },
    null,
  ])('does not park or settle absent, incomplete or malformed consent %j', async (data) => {
    const { controller, rpc, terminal, engine } = setup();
    rpc.mockResolvedValue({ data, error: null });
    await controller.checkFinalTableDeal();
    expect(engine.parkForTerminalCloseout).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });

  it.each([
    { ...ready(), proposal_id: id(4) },
    { ...ready(), revision: 'b'.repeat(64) },
    { ...ready(), ready: false, voter_ids: [id(1)] },
    { ...ready(), voter_ids: [id(1), id(99)] },
    null,
  ])('releases a proven pre-RPC refusal when parked consent changes %j', async (data) => {
    const { controller, rpc, terminal, engine } = setup();
    rpc
      .mockResolvedValueOnce({ data: ready(), error: null })
      .mockResolvedValueOnce({ data, error: null });
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce();
    expect(terminal).not.toHaveBeenCalled();
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(controller.finalTableDealHandled).toBe(false);
    expect(controller.tournamentFinished).toBe(false);
  });

  it('does not request consensus or money when the engine cannot prove its parked hand boundary', async () => {
    const { controller, rpc, terminal, engine } = setup();
    engine.parkForTerminalCloseout.mockResolvedValue(false);
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(terminal).not.toHaveBeenCalled();
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    'a transport exception during consent cannot become an unknown money outcome (parked=%s)',
    async (parked) => {
      const { controller, rpc, terminal, engine } = setup();
      if (parked) rpc.mockResolvedValueOnce({ data: ready(), error: null });
      rpc.mockRejectedValueOnce(new Error('consensus response unavailable'));
      await expect(controller.checkFinalTableDeal()).resolves.toBe(!parked);
      expect(terminal).not.toHaveBeenCalled();
      expect(engine.parkForTerminalCloseout).toHaveBeenCalledTimes(parked ? 1 : 0);
      expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledTimes(parked ? 1 : 0);
      expect(controller.finalTableDealHandled).toBe(false);
      expect(controller.tournamentFinished).toBe(false);
    }
  );
});
