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
  'closeFinalTableDealReview(',
  'checkFinalTableDeal(): Promise<boolean>',
  'checkLegacyFinalTableDeal(): Promise<boolean>',
  'completeLegacyFinalTableDealAtBoundary(\n    tableId: string,',
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
  review_id: id(30),
  review_state: 'reviewing',
  review_expires_at: new Date(Date.now() + 120_000).toISOString(),
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
  const rpc = vi.fn().mockImplementation(async (name: string) => ({
    data:
      name === 'fn_close_tournament_deal_review'
        ? {
            ...ready(),
            review_state: 'cancelled',
            proposal_id: null,
            revision: null,
            voter_ids: [],
            required: 0,
            ready: false,
          }
        : ready(),
    error: null,
  }));
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
    'TournamentManagerBase',
    compiled
  )(
    { rpc, from },
    UUID,
    () => false,
    terminal,
    Refused,
    Committed,
    Unknown,
    vi.fn(),
    vi.fn(),
    {
      FINAL_TABLE_DEAL_PAUSE_MS: 50,
    },
    { FINAL_TABLE_DEAL_POLL_MS: 10_000 }
  );
  const controller = Object.assign(new Probe(), {
    tournamentId: id(10),
    tournamentCache: { status: 'RUNNING', final_table_deal_enabled: true, table_size: 9 },
    lastDealPollAt: 0,
    lastDealVoteCount: 0,
    finalTableDealHandled: false,
    finalTableDealReview: null,
    requestUrgentEliminationSweepAfter: vi.fn(),
    fenceUnknownTerminalOutcome: vi.fn(),
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
  it('parks an explicitly requested review before publishing post-hand consent', async () => {
    const { controller, rpc, terminal, engine } = setup();
    let committedHand = 1;
    const requested = {
      ...ready(),
      review_id: id(30),
      review_state: 'requested',
      review_expires_at: new Date(Date.now() + 120_000).toISOString(),
      proposal_id: null,
      revision: null,
      voter_ids: [],
      required: 0,
      ready: false,
    };
    rpc.mockImplementation(async (name: string) => ({
      data:
        name === 'fn_begin_tournament_deal_review'
          ? {
              ...requested,
              review_state: 'reviewing',
              proposal_id: id(31),
              revision: 'b'.repeat(64),
              required: 2,
            }
          : committedHand === 1
            ? requested
            : {
                ...requested,
                review_state: 'reviewing',
                proposal_id: id(31),
                revision: 'b'.repeat(64),
                required: 2,
              },
      error: null,
    }));
    engine.parkForTerminalCloseout.mockImplementation(async () => {
      committedHand = 2;
      return true;
    });
    controller.requestUrgentEliminationSweepAfter = vi.fn();
    await controller.checkFinalTableDeal();
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce();
    expect(committedHand).toBe(2);
    expect(rpc).toHaveBeenCalledWith('fn_begin_tournament_deal_review', {
      p_tournament_id: id(10),
      p_review_id: id(30),
    });
    expect(terminal).not.toHaveBeenCalled();
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(controller.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('requires the current proposal before parking and again before its bound terminal request', async () => {
    const { controller, rpc, from, terminal, engine } = setup();
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(rpc.mock.calls).toEqual([
      ['fn_get_tournament_deal_consensus', { p_tournament_id: id(10) }],
      ['fn_begin_tournament_deal_review', { p_tournament_id: id(10), p_review_id: id(30) }],
      ['fn_get_tournament_deal_consensus', { p_tournament_id: id(10) }],
    ]);
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledTimes(2);
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
    { ...ready(), voter_ids: [id(1), id(99)] },
    null,
  ])('releases a proven pre-RPC refusal when parked consent changes %j', async (data) => {
    const { controller, rpc, terminal, engine } = setup();
    rpc
      .mockResolvedValueOnce({ data: ready(), error: null })
      .mockResolvedValueOnce({ data, error: null });
    await controller.checkFinalTableDeal();
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce();
    expect(terminal).not.toHaveBeenCalled();
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(controller.finalTableDealHandled).toBe(false);
    expect(controller.tournamentFinished).toBe(false);
  });

  it('does not request consensus or money when the engine cannot prove its parked hand boundary', async () => {
    const { controller, rpc, terminal, engine } = setup();
    engine.parkForTerminalCloseout.mockResolvedValue(false);
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(terminal).not.toHaveBeenCalled();
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    'a transport exception during consent cannot become an unknown money outcome (parked=%s)',
    async (parked) => {
      const { controller, rpc, terminal, engine } = setup();
      if (parked) rpc.mockResolvedValueOnce({ data: ready(), error: null });
      rpc.mockRejectedValueOnce(new Error('consensus response unavailable'));
      await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
      expect(terminal).not.toHaveBeenCalled();
      expect(engine.parkForTerminalCloseout).toHaveBeenCalledTimes(parked ? 1 : 0);
      expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledTimes(parked ? 1 : 0);
      expect(controller.finalTableDealHandled).toBe(false);
      expect(controller.tournamentFinished).toBe(false);
    }
  );

  it('holds one stable post-hand proposal across human decisions and scheduler passes', async () => {
    const { controller, rpc, terminal, engine } = setup();
    let finishHand!: () => void;
    const hand = new Promise<void>((resolve) => {
      finishHand = resolve;
    });
    let handNumber = 1;
    let fenced = false;
    let snapshot = {
      ...ready(),
      review_state: 'requested',
      proposal_id: null as string | null,
      revision: null as string | null,
      voter_ids: [] as string[],
      required: 0,
      ready: false,
    };
    engine.parkForTerminalCloseout.mockImplementation(async () => {
      fenced = true;
      await hand;
      return true;
    });
    rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_begin_tournament_deal_review') {
        expect(fenced).toBe(true);
        expect(handNumber).toBe(2);
        snapshot = {
          ...snapshot,
          review_state: 'reviewing',
          proposal_id: id(31),
          revision: 'b'.repeat(64),
          required: 2,
        };
      }
      return { data: { ...snapshot, voter_ids: [...snapshot.voter_ids] }, error: null };
    });
    const review = controller.checkFinalTableDeal();
    await vi.waitFor(() => expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce());
    expect(rpc).not.toHaveBeenCalledWith('fn_begin_tournament_deal_review', expect.anything());
    expect(terminal).not.toHaveBeenCalled();
    handNumber = 2;
    finishHand();
    await expect(review).resolves.toBe(false);
    expect(snapshot.revision).toBe('b'.repeat(64));
    expect(snapshot.voter_ids).toEqual([]);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();

    snapshot.voter_ids = [id(1)];
    controller.lastDealPollAt = 0;
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce();
    expect(terminal).not.toHaveBeenCalled();
    expect(fenced).toBe(true);
    expect(handNumber).toBe(2);

    snapshot.voter_ids = [id(1), id(2)];
    snapshot.ready = true;
    controller.lastDealPollAt = 0;
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(id(10), 'final_table_deal', null, {
      dealProposal: { proposalId: id(31), revision: 'b'.repeat(64) },
    });
    expect(
      rpc.mock.calls.filter(([name]) => name === 'fn_begin_tournament_deal_review')
    ).toHaveLength(1);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'expired'])(
    'resumes only after the server confirms the exact %s review closed',
    async (state) => {
      const { controller, rpc, terminal, engine } = setup();
      const pending = { ...ready(), voter_ids: [id(1)], ready: false };
      rpc.mockResolvedValue({ data: pending, error: null });
      await controller.checkFinalTableDeal();
      expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
      const closed = {
        ...pending,
        review_state: state,
        proposal_id: null,
        revision: null,
        voter_ids: [],
        required: 0,
        ready: false,
      };
      rpc.mockResolvedValue({ data: closed, error: null });
      controller.lastDealPollAt = 0;
      await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
      expect(rpc).toHaveBeenLastCalledWith('fn_close_tournament_deal_review', {
        p_tournament_id: id(10),
        p_review_id: id(30),
        p_reason: state === 'expired' ? 'expired' : 'cancelled',
      });
      expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
      expect(controller.finalTableDealReview).toBeNull();
      expect(terminal).not.toHaveBeenCalled();
    }
  );

  it('local expiry requests closure but cannot release a dealer until the database proves it', async () => {
    vi.useFakeTimers();
    try {
      const { controller, rpc, terminal, engine } = setup();
      const pending = { ...ready(), voter_ids: [], ready: false };
      rpc.mockResolvedValue({ data: pending, error: null });
      await controller.checkFinalTableDeal();
      vi.setSystemTime(Date.parse(pending.review_expires_at) + 1);
      rpc.mockImplementation(async (name: string) =>
        name === 'fn_close_tournament_deal_review'
          ? { data: null, error: { message: 'close outcome unavailable' } }
          : { data: pending, error: null }
      );
      await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
      expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
      expect(controller.finalTableDealReview.closingReason).toBe('expired');
      rpc.mockResolvedValue({
        data: {
          ...pending,
          review_state: 'expired',
          proposal_id: null,
          revision: null,
          voter_ids: [],
          required: 0,
        },
        error: null,
      });
      await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
      expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
      expect(terminal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['wrong_review', 'completed', 'malformed', 'transport'])(
    'a %s close result cannot reopen the dealer',
    async (kind) => {
      const { controller, rpc, terminal, engine } = setup();
      const pending = { ...ready(), voter_ids: [], ready: false };
      rpc.mockResolvedValue({ data: pending, error: null });
      await controller.checkFinalTableDeal();
      controller.tournamentCache.final_table_deal_enabled = false;
      const closed = {
        ...pending,
        review_state: 'cancelled',
        proposal_id: null,
        revision: null,
        voter_ids: [],
        required: 0,
      };
      if (kind === 'wrong_review') closed.review_id = id(99);
      if (kind === 'completed') closed.review_state = 'completed';
      if (kind === 'malformed') closed.review_state = 'reviewing';
      if (kind === 'transport') rpc.mockRejectedValue(new Error('close response unavailable'));
      else rpc.mockResolvedValue({ data: closed, error: null });
      await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
      expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
      expect(controller.fenceUnknownTerminalOutcome).toHaveBeenCalledTimes(
        kind === 'completed' ? 1 : 0
      );
    }
  );

  it.each(['engine', 'break', 'roster'])(
    'closes the review if its %s authority changes',
    async (changed) => {
      const { controller, rpc, from, terminal, engine } = setup();
      rpc
        .mockResolvedValueOnce({ data: { ...ready(), voter_ids: [], ready: false }, error: null })
        .mockResolvedValueOnce({ data: { ...ready(), voter_ids: [], ready: false }, error: null });
      await controller.checkFinalTableDeal();
      controller.lastDealPollAt = 0;
      if (changed === 'engine')
        controller.authoritativeFinalTableDealEngine.mockResolvedValue(null);
      if (changed === 'break') controller.isOnBreak = () => true;
      if (changed === 'roster')
        from.mockImplementation(() => {
          const q: any = {
            select: () => q,
            eq: () => q,
            then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
          };
          return q;
        });
      await controller.checkFinalTableDeal();
      expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
      expect(terminal).not.toHaveBeenCalled();
    }
  );

  it('an unknown terminal outcome retains the dealer fence and never closes its review', async () => {
    const { controller, rpc, terminal, engine } = setup();
    terminal.mockRejectedValue(new Unknown('terminal response lost'));
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('fn_close_tournament_deal_review', expect.anything());
    expect(controller.fenceUnknownTerminalOutcome).toHaveBeenCalledOnce();
    expect(controller.finalTableDealHandled).toBe(true);
    expect(controller.tournamentFinished).toBe(true);
  });

  it('viewing the card without an explicit session cannot park a dealer', async () => {
    const { controller, rpc, terminal, engine } = setup();
    rpc.mockResolvedValue({
      data: {
        ok: true,
        review_id: null,
        review_state: 'none',
        review_expires_at: null,
        proposal_id: null,
        revision: null,
        voter_ids: [],
        required: 0,
        ready: false,
      },
      error: null,
    });
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(engine.parkForTerminalCloseout).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });

  it('a replacement engine during drain cannot activate the old review', async () => {
    const { controller, rpc, terminal, engine } = setup();
    rpc.mockResolvedValueOnce({
      data: {
        ...ready(),
        review_state: 'requested',
        proposal_id: null,
        revision: null,
        required: 0,
        voter_ids: [],
        ready: false,
      },
      error: null,
    });
    engine.parkForTerminalCloseout.mockImplementation(async () => {
      controller.tableEngines.set(id(20), { isRunning: () => true });
      return true;
    });
    await controller.checkFinalTableDeal();
    expect(rpc).not.toHaveBeenCalledWith('fn_begin_tournament_deal_review', expect.anything());
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(controller.finalTableDealReview).not.toBeNull();
    engine.isRunning.mockReturnValue(false);
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(controller.finalTableDealReview).toBeNull();
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });

  it('unavailable consensus during human review preserves its existing fence', async () => {
    const { controller, rpc, terminal, engine } = setup();
    rpc.mockResolvedValue({ data: { ...ready(), voter_ids: [], ready: false }, error: null });
    await controller.checkFinalTableDeal();
    rpc.mockRejectedValue(new Error('read unavailable'));
    controller.lastDealPollAt = 0;
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(controller.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('prices the surviving roster when a nonrequester busts during the drain', async () => {
    const { controller, rpc, from, terminal, engine } = setup();
    let currentRoster = [...roster, { user_id: id(9), chips: 50 }];
    from.mockImplementation(() => {
      const q: any = {
        select: () => q,
        eq: () => q,
        then: (resolve: any) => Promise.resolve({ data: currentRoster, error: null }).then(resolve),
      };
      return q;
    });
    engine.parkForTerminalCloseout.mockImplementation(async () => {
      currentRoster = [...roster];
      return true;
    });
    const pending = { ...ready(), voter_ids: [], ready: false };
    rpc
      .mockResolvedValueOnce({
        data: {
          ...pending,
          review_state: 'requested',
          proposal_id: null,
          revision: null,
          required: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: pending, error: null });
    await controller.checkFinalTableDeal();
    expect(rpc).toHaveBeenCalledWith('fn_begin_tournament_deal_review', {
      p_tournament_id: id(10),
      p_review_id: id(30),
    });
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(controller.finalTableDealReview.proposalId).toBe(pending.proposal_id);
    expect(terminal).not.toHaveBeenCalled();
  });

  it.each([
    { ready: true },
    { proposal_id: id(3) },
    { revision: 'a'.repeat(64) },
    { required: 2 },
    { voter_ids: [id(1)] },
    { review_expires_at: null },
  ])('a contradictory closed envelope cannot reopen the table %j', async (contradiction) => {
    const { controller, rpc, terminal, engine } = setup();
    const pending = { ...ready(), voter_ids: [], ready: false };
    rpc.mockResolvedValue({ data: pending, error: null });
    await controller.checkFinalTableDeal();
    controller.tournamentCache.final_table_deal_enabled = false;
    rpc.mockResolvedValue({
      data: {
        ...pending,
        review_state: 'cancelled',
        proposal_id: null,
        revision: null,
        required: 0,
        voter_ids: [],
        ...contradiction,
      },
      error: null,
    });
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });
});

describe('Explicit inactive authority preserves legacy dealer boundaries', () => {
  const inactive = { data: { ok: false, reason: 'proposal_authority_not_active' }, error: null };
  it('uses existing unanimity and the physical boundary only while inactive', async () => {
    const { controller, rpc, from, terminal, engine } = setup();
    rpc.mockResolvedValue(inactive);
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(from).toHaveBeenCalledWith('tournament_deal_votes');
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(id(10), 'final_table_deal', null, {
      legacyDealAuthority: 'proposal_authority_not_active',
    });
  });
  it.each([
    { data: inactive.data, error: { message: 'timeout' } },
    { data: { ok: false, reason: 'review_stale' }, error: null },
    { data: { ok: true, reason: 'proposal_authority_not_active' }, error: null },
    { data: null, error: null },
  ])('does not read legacy votes for an error or invalid capability', async (response) => {
    const { controller, rpc, from, terminal, engine } = setup();
    rpc.mockResolvedValue(response);
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(from).not.toHaveBeenCalledWith('tournament_deal_votes');
    expect(terminal).not.toHaveBeenCalled();
    expect(engine.parkForTerminalCloseout).not.toHaveBeenCalled();
  });
  it('does not downgrade a manager that has observed active authority', async () => {
    const { controller, rpc, from, terminal } = setup();
    rpc.mockResolvedValueOnce({
      data: {
        ...ready(),
        review_id: null,
        review_state: 'none',
        review_expires_at: null,
        proposal_id: null,
        revision: null,
        voter_ids: [],
        required: 0,
        ready: false,
      },
      error: null,
    });
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    controller.lastDealPollAt = 0;
    rpc.mockResolvedValue(inactive);
    await expect(controller.checkFinalTableDeal()).resolves.toBe(true);
    expect(from).not.toHaveBeenCalledWith('tournament_deal_votes');
    expect(terminal).not.toHaveBeenCalled();
  });
  it('releases only a proven uncommitted legacy refusal if activation wins the terminal race', async () => {
    const { controller, rpc, terminal, engine } = setup();
    rpc.mockResolvedValue(inactive);
    terminal.mockRejectedValue(new Refused('Exact proposal required after activation'));
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(controller.settleFinalTableDeal).not.toHaveBeenCalled();
    expect(controller.tournamentFinished).toBe(false);
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
  });
  it('keeps an ambiguous legacy outcome fenced rather than reporting a deal', async () => {
    const { controller, rpc, terminal, engine } = setup();
    rpc.mockResolvedValue(inactive);
    terminal.mockRejectedValue(new Unknown('Receipt unavailable after activation'));
    await expect(controller.checkFinalTableDeal()).resolves.toBe(false);
    expect(controller.settleFinalTableDeal).not.toHaveBeenCalled();
    expect(controller.fenceUnknownTerminalOutcome).toHaveBeenCalledOnce();
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
  });
});
