/**
 * Cancellation is one database decision. The process may refuse to call the
 * database when it cannot read the surviving registrations, but it never
 * derives money or closes rows itself. A returned value is usable only when
 * it is the exact, internally consistent receipt persisted by the RPC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  openRows: {
    data: [{ id: 'registration-1' }],
    error: null as { message: string } | null,
  },
  rpcData: null as unknown,
  rpcError: null as { message: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock('../services/supabase.js', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in']) c[method] = () => c;
    c.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(state.openRows).then(resolve, reject);
    return c;
  };
  return {
    supabase: {
      from: vi.fn(() => chain()),
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ name, args });
        return { data: state.rpcData, error: state.rpcError };
      }),
    },
  };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => ({ persisted: true, alertId: 'alert-1' })),
}));

import { reportError } from '../services/errorReporter.js';
import {
  refundAndCloseCancelledTournament,
  verifyTournamentCancellationReceipt,
} from './tournamentRecovery.js';

const TOURNAMENT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-000000000002';
const SYSTEM_ACTOR = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
const PLAYER_1 = '00000000-0000-4000-8000-000000000003';
const PLAYER_2 = '00000000-0000-4000-8000-000000000004';
const OBLIGATION_1 = '00000000-0000-4000-8000-000000000005';
const OBLIGATION_2 = '00000000-0000-4000-8000-000000000006';
const KEY_1 = `tourney:${TOURNAMENT}:obl:${OBLIGATION_1}:0`;
const KEY_2 = `tourney:${TOURNAMENT}:obl:${OBLIGATION_2}:500`;

function receipt() {
  return {
    ok: true,
    success: true,
    fully_settled: true,
    receipt_version: 1,
    tournament_id: TOURNAMENT,
    actor_id: ACTOR,
    status: 'CANCELLED',
    refunded_count: 2,
    total_refunded: 34.5,
    fees_reversed: 3.5,
    player_count: 2,
    table_count: 1,
    refunds: [
      {
        user_id: PLAYER_1,
        gross_paid: 20,
        amount_refunded: 20,
        amount_paid_before: 0,
        amount_paid_now: 20,
        obligation_id: OBLIGATION_1,
        idempotency_key: KEY_1,
      },
      {
        user_id: PLAYER_2,
        gross_paid: 14.5,
        amount_refunded: 14.5,
        amount_paid_before: 5,
        amount_paid_now: 9.5,
        obligation_id: OBLIGATION_2,
        idempotency_key: KEY_2,
      },
    ],
    settled_at: '2026-09-08T03:44:40.000Z',
  };
}

describe('a stored tournament cancellation receipt', () => {
  it('accepts exact refund evidence and PostgREST JSON-string transport', () => {
    const verified = verifyTournamentCancellationReceipt(
      JSON.stringify(receipt()),
      TOURNAMENT,
      ACTOR
    );
    expect(verified).toMatchObject({
      tournamentId: TOURNAMENT,
      actorId: ACTOR,
      refundedCount: 2,
      totalRefunded: 34.5,
      feesReversed: 3.5,
      playerCount: 2,
      tableCount: 1,
    });
  });

  it.each([
    ['wrong tournament', { tournament_id: PLAYER_1 }],
    ['wrong actor', { actor_id: PLAYER_1 }],
    ['failed result', { ok: false }],
    ['unsuccessful result', { success: false }],
    ['prior receipt version', { receipt_version: 0 }],
    ['nonterminal status', { status: 'COMPLETING' }],
    ['not fully settled', { fully_settled: false }],
    ['wrong refund count', { refunded_count: 1 }],
    ['wrong refund sum', { total_refunded: 30 }],
    ['numeric string total', { total_refunded: '34.5' }],
    ['sub-cent refund', { total_refunded: 34.501 }],
    ['fee larger than all refunds', { fees_reversed: 35 }],
    ['negative row count', { table_count: -1 }],
    ['invalid settlement timestamp', { settled_at: 'not-a-timestamp' }],
    [
      'duplicate refund user',
      {
        refunds: [receipt().refunds[0], { ...receipt().refunds[1], user_id: PLAYER_1 }],
      },
    ],
    [
      'partially refunded line',
      {
        refunds: [receipt().refunds[0], { ...receipt().refunds[1], amount_refunded: 10 }],
      },
    ],
    [
      'line whose before and current payments do not make its settled total',
      {
        refunds: [receipt().refunds[0], { ...receipt().refunds[1], amount_paid_now: 9 }],
      },
    ],
    [
      'line whose key does not name its obligation and prior paid cents',
      {
        refunds: [receipt().refunds[0], { ...receipt().refunds[1], idempotency_key: KEY_1 }],
      },
    ],
    [
      'newly paid line without its durable key',
      {
        refunds: [receipt().refunds[0], { ...receipt().refunds[1], idempotency_key: null }],
      },
    ],
  ])('refuses %s', (_name, patch) => {
    expect(
      verifyTournamentCancellationReceipt({ ...receipt(), ...patch }, TOURNAMENT, ACTOR)
    ).toBeNull();
  });
});

describe('the engine cancellation helper', () => {
  beforeEach(() => {
    state.openRows = { data: [{ id: 'registration-1' }], error: null };
    state.rpcData = receipt();
    state.rpcError = null;
    state.rpcCalls = [];
    vi.mocked(reportError).mockClear();
  });

  it('asks one database transaction to cancel, refund, reverse fees, close, and receipt', async () => {
    await refundAndCloseCancelledTournament(
      TOURNAMENT,
      'Cancelled Event',
      'operator cancellation',
      ACTOR
    );

    expect(state.rpcCalls).toEqual([
      {
        name: 'atomic_cancel_tournament',
        args: { p_tournament_id: TOURNAMENT, p_admin_id: ACTOR },
      },
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('keeps the legacy three-argument caller compatible with the system actor', async () => {
    state.rpcData = { ...receipt(), actor_id: SYSTEM_ACTOR };
    await refundAndCloseCancelledTournament(
      TOURNAMENT,
      'Cancelled Event',
      'scheduled cancellation'
    );

    expect(state.rpcCalls).toEqual([
      {
        name: 'atomic_cancel_tournament',
        args: { p_tournament_id: TOURNAMENT, p_admin_id: SYSTEM_ACTOR },
      },
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('does nothing when the survivor preflight is unreadable', async () => {
    state.openRows = { data: [], error: { message: 'timed out' } };
    await refundAndCloseCancelledTournament(
      TOURNAMENT,
      'Cancelled Event',
      'operator cancellation',
      ACTOR
    );

    expect(state.rpcCalls).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('closing nothing this pass') }),
      'GameServer.cancel_refund_open_rows_unreadable'
    );
  });

  it('reports an RPC refusal and never treats it as a close', async () => {
    state.rpcError = { message: 'refund obligation remained open' };
    await refundAndCloseCancelledTournament(
      TOURNAMENT,
      'Cancelled Event',
      'operator cancellation',
      ACTOR
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('refund obligation remained open'),
      }),
      'GameServer.cancel_refund_atomic_failed'
    );
  });

  it('reports a malformed receipt even when transport says the RPC succeeded', async () => {
    state.rpcData = { ...receipt(), total_refunded: 999 };
    await refundAndCloseCancelledTournament(
      TOURNAMENT,
      'Cancelled Event',
      'operator cancellation',
      ACTOR
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('incomplete receipt') }),
      'GameServer.cancel_refund_receipt_invalid'
    );
  });

  it('does not acknowledge a receipt whose player count cannot cover the survivor preflight', async () => {
    state.openRows = {
      data: [{ id: 'registration-1' }, { id: 'registration-2' }, { id: 'registration-3' }],
      error: null,
    };
    await refundAndCloseCancelledTournament(
      TOURNAMENT,
      'Cancelled Event',
      'operator cancellation',
      ACTOR
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('incomplete receipt') }),
      'GameServer.cancel_refund_receipt_invalid'
    );
  });
});
