import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), report: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: transport.from, rpc: transport.rpc },
  maintenanceSupabase: { from: transport.from, rpc: transport.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: transport.report }));
vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('No network in terminal fixture');
  })
);
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TournamentSweepWorkCursor } = await import('./TournamentSweepWorkCursor.js');
const TOURNAMENT_ID = 'f370585d-40ea-4085-bb8f-c7e8c74f3fb4';
const WINNER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUNNER_ID = '11111111-aaaa-4bbb-8ccc-222222222222';
const BUBBLE_ID = '33333333-aaaa-4bbb-8ccc-444444444444';
const TABLE_ID = '44444444-aaaa-4bbb-8ccc-555555555555';
const SEAT_A_ID = '55555555-aaaa-4bbb-8ccc-666666666666';
const SEAT_B_ID = '66666666-aaaa-4bbb-8ccc-777777777777';

function receipt(): any {
  const payouts = [
    { user_id: WINNER_ID, place: 1, amount: 70 },
    { user_id: RUNNER_ID, place: 2, amount: 20 },
  ];
  return {
    ok: true,
    fully_settled: true,
    status: 'COMPLETED',
    tournament_id: TOURNAMENT_ID,
    winner_id: WINNER_ID,
    mode: 'places',
    settlement_mode: 'places',
    payouts,
    deal_shares: [],
    winner_amount: 70,
    bubble_protection: { user_id: BUBBLE_ID, position: 3, amount: 10 },
    cash: {
      ok: true,
      fully_settled: true,
      status: 'COMPLETING',
      payouts,
      deal_shares: [],
      winner_amount: 70,
      bubble_protection: { user_id: BUBBLE_ID, position: 3, amount: 10 },
    },
    mystery_bounty: {
      ok: true,
      reason: 'not_a_mystery_tournament',
      pool_cents: 0,
      settled_cents: 0,
      unclaimed_cents: 0,
      residual_paid_cents: 0,
      balanced: true,
      variance_cents: 0,
    },
    bounty: {
      ok: true,
      funded: true,
      residual: 0,
      reason: 'not_a_bounty_tournament',
    },
    closed_table_count: 1,
    source_seat_count: 2,
    released_seat_count: 2,
    table_closure: {
      closed_table_count: 1,
      closed_table_ids: [TABLE_ID],
      source_seat_count: 2,
      source_seat_ids: [SEAT_A_ID, SEAT_B_ID],
      released_seat_count: 2,
      released_seat_ids: [SEAT_A_ID, SEAT_B_ID],
    },
    rake: {
      amount: 3,
      destination: 'club_treasury:55555555-aaaa-4bbb-8ccc-666666666666',
      attributed: true,
      attributed_users: 2,
      settled_at: '2026-09-08T05:00:00.000Z',
      attributed_at: '2026-09-08T05:00:00.000Z',
    },
    escrow: { prize_balance: 0, bounty_balance: 0, fee_balance: 0 },
    cash_payout_total: 100,
    bounty_payout_total: 0,
    receipt_version: 1,
    settled_at: '2026-09-08T05:00:00.000Z',
  };
}

function custodyReceipt(): any {
  const r = receipt();
  r.tournament_id = TOURNAMENT_ID;
  r.receipt_version = 3;
  r.fully_settled = false;
  r.player_result = 'final';
  r.accounting_complete = false;
  r.accounting_state = 'fee_custody_unresolved';
  r.rake = {
    amount: 17,
    destination: 'tournament_escrow',
    attributed: false,
    attributed_users: 0,
    settled_at: null,
    attributed_at: null,
    accounting: {
      accounting_version: 3,
      tournament_id: TOURNAMENT_ID,
      status: 'fee_custody_unresolved',
      player_result: 'final',
      payable: false,
      accounting_complete: false,
      obligation_id: TABLE_ID,
      source_fingerprint: 'f67bf12ee0b00c954b6f8403de9718fe',
      source_count: 34,
      held_amount: 17,
      current_held_amount: 17,
      held_at: r.settled_at,
      reason: 'tournament_fee_sources_require_reconciliation',
      custody_store: 'tournament_escrow',
      recognized_source_count: 0,
      bank_amount: 0,
      banked_at: null,
      bank_receipt_id: null,
      resolution: null,
    },
  };
  r.escrow = {
    prize_balance: 0,
    bounty_balance: 0,
    fee_balance: 17,
    closed_at: null,
    close_note: null,
  };
  return r;
}

function fixture(
  options: {
    feeCustody?: boolean;
    deal?: boolean;
    uncommitted?: boolean;
    receiptMissing?: boolean;
    readError?: boolean;
    resolverError?: boolean;
    invalidReceipt?: boolean;
    loseOwner?: boolean;
    unrelatedRefusal?: boolean;
    cleanupFails?: boolean;
  } = {}
) {
  const manager = Object.create(TournamentManagerEliminations.prototype) as any;
  const engine = { stop: vi.fn().mockResolvedValue(undefined) };
  const token = {};
  const mode = options.deal ? 'final_table_deal' : 'places';
  const terminalReceipt = options.feeCustody ? custodyReceipt() : receipt();
  if (options.deal) {
    terminalReceipt.mode = mode;
    terminalReceipt.settlement_mode = mode;
    terminalReceipt.deal_shares = terminalReceipt.payouts;
    terminalReceipt.cash.deal_shares = terminalReceipt.payouts;
  }
  let current = true;
  Object.assign(manager, {
    tournamentId: TOURNAMENT_ID,
    running: true,
    tournamentFinished: false,
    pendingManagerWakes: new Map([['wake', 'late_registration']]),
    pendingManagerWakeGenerations: new Map([['wake', 1]]),
    isProcessingEliminations: false,
    tournamentEntryRepricePending: true,
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    eliminationWorkBudgetExpired: () => false,
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    captureLifecycleToken: () => token,
    lifecycleIsCurrent: (t: unknown) => current && manager.running && t === token,
    tableEngines: new Map([[TABLE_ID, engine]]),
    gameServer: {
      unregisterTableEngine: vi.fn().mockReturnValue(!options.cleanupFails),
      stopClosedTournamentTableEngine: vi.fn().mockResolvedValue(false),
    },
    blindTimer: 'live-clock',
    pendingBlindTransition: { nextLevel: 99 },
    clearLifecycleTimeout: vi.fn(),
    broadcast: vi.fn().mockResolvedValue(true),
    cleanupBroadcastChannel: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(async () => {
      manager.running = false;
    }),
    recalculateEliminatedPrizes: vi.fn(),
  });
  transport.from.mockImplementation((table: string) => {
    expect(table).toBe('tournament_terminal_settlements');
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: string) => {
        expect([column, value]).toEqual(['tournament_id', TOURNAMENT_ID]);
        return query;
      }),
      maybeSingle: vi.fn(async () => ({
        data: options.receiptMissing ? null : { settlement_mode: mode, winner_id: WINNER_ID },
        error: options.readError ? { message: 'receipt read unavailable' } : null,
      })),
    };
    return query;
  });
  transport.rpc.mockImplementation(async (name: string, args: unknown) => {
    if (name === 'fn_close_tournament_entry_window')
      return {
        data: {
          ok: false,
          reason: options.unrelatedRefusal ? 'entry_boundary_unknown' : 'tournament_not_running',
        },
        error: null,
      };
    expect(name).toBe('fn_resolve_tournament_terminal_outcome');
    expect(args).toEqual({
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: WINNER_ID,
      p_settlement_mode: mode,
    });
    if (options.loseOwner) current = false;
    return {
      error: options.resolverError ? { message: 'outcome unavailable' } : null,
      data: {
        ok: true,
        tournament_id: TOURNAMENT_ID,
        mode,
        status: 'COMPLETED',
        terminal_committed: !options.uncommitted,
        definitively_not_committed: options.uncommitted === true,
        receipt: options.invalidReceipt
          ? { ...terminalReceipt, winner_id: RUNNER_ID }
          : terminalReceipt,
      },
    };
  });
  return { manager, engine };
}

beforeEach(() => vi.clearAllMocks());
describe('external committed completion outranks an obsolete entry reprice', () => {
  it.each([false, true])(
    'retires the exact dealer, clock and manager from the actual sweep (finished=%s)',
    async (finished) => {
      const { manager, engine } = fixture();
      manager.tournamentFinished = finished;
      await manager.runEliminationSweep(new AbortController().signal);
      expect(engine.stop).toHaveBeenCalledOnce();
      expect(manager.gameServer.unregisterTableEngine).toHaveBeenCalledWith(TABLE_ID, engine);
      expect(manager.stop).toHaveBeenCalledOnce();
      expect(manager.blindClockTerminalCommitted).toBe(true);
      expect(manager.clearLifecycleTimeout).toHaveBeenCalledWith('live-clock');
      expect(manager.pendingBlindTransition).toBeNull();
      expect(manager.recalculateEliminatedPrizes).not.toHaveBeenCalled();
      expect(transport.rpc.mock.calls.map(([name]) => name)).toEqual([
        'fn_close_tournament_entry_window',
        'fn_resolve_tournament_terminal_outcome',
      ]);
    }
  );
  it('uses the existing deal presentation tail without invoking any deal payer', async () => {
    const { manager, engine } = fixture({ deal: true });
    await expect(manager.reconcileTournamentEntryWindow('engine.manager_wake')).resolves.toBe(
      false
    );
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(manager.broadcast).toHaveBeenCalledWith('final_table_deal', expect.any(Object));
    expect(transport.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_close_tournament_entry_window',
      'fn_resolve_tournament_terminal_outcome',
    ]);
  });
  it('adopts the final v3 player result without attributing held fees', async () => {
    const { manager, engine } = fixture({ feeCustody: true });
    await expect(manager.reconcileTournamentEntryWindow('engine.manager_wake')).resolves.toBe(
      false
    );
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(transport.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_close_tournament_entry_window',
      'fn_resolve_tournament_terminal_outcome',
    ]);
    expect(transport.report).not.toHaveBeenCalled();
  });
  it.each([
    'receiptMissing',
    'readError',
    'resolverError',
    'invalidReceipt',
    'uncommitted',
    'loseOwner',
  ] as const)('does not retire or reprice on %s', async (condition) => {
    const { manager, engine } = fixture({ [condition]: true });
    await expect(manager.reconcileTournamentEntryWindow('engine.manager_wake')).resolves.toBe(
      false
    );
    expect(engine.stop).not.toHaveBeenCalled();
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.recalculateEliminatedPrizes).not.toHaveBeenCalled();
    expect(manager.tournamentEntryRepricePending).toBe(true);
    if (condition !== 'loseOwner')
      expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });
  it('keeps the exact receipt for cleanup-only retry when a table owner cannot yet release', async () => {
    const { manager, engine } = fixture({ cleanupFails: true });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.committedFinishReceipt?.winnerId).toBe(WINNER_ID);
    expect(manager.blindClockTerminalCommitted).toBe(true);
    expect(manager.stop).not.toHaveBeenCalled();
    manager.gameServer.unregisterTableEngine.mockReturnValue(true);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(engine.stop).toHaveBeenCalledTimes(2);
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(transport.rpc).toHaveBeenCalledTimes(2);
  });
  it('does not add receipt reads to unrelated entry refusals', async () => {
    const { manager } = fixture({ unrelatedRefusal: true });
    await expect(manager.reconcileTournamentEntryWindow('engine.manager_wake')).resolves.toBe(
      false
    );
    expect(transport.from).not.toHaveBeenCalled();
  });
  it('leaves ordinary open entry handling unchanged and adds no receipt read', async () => {
    const { manager } = fixture();
    manager.clearTournamentEntryCloseTimer = vi.fn();
    transport.rpc.mockResolvedValue({
      data: { ok: true, entry_closed: false, window_mode: 'levels' },
      error: null,
    });
    await expect(manager.reconcileTournamentEntryWindow('engine.manager_wake')).resolves.toBe(true);
    expect(transport.from).not.toHaveBeenCalled();
    expect(manager.stop).not.toHaveBeenCalled();
  });
});
