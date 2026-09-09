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
const REGISTRATION_1 = '00000000-0000-4000-8000-000000000006';
const REGISTRATION_2 = '00000000-0000-4000-8000-000000000007';
const ENTITLEMENT_1 = '00000000-0000-4000-8000-000000000008';
const ENTITLEMENT_2 = '00000000-0000-4000-8000-000000000009';
const CLUB = '00000000-0000-4000-8000-00000000000a';
const SATELLITE = '00000000-0000-4000-8000-00000000000b';
const CREDIT_LEDGER = '00000000-0000-4000-8000-00000000000c';
const WALLET_TRANSACTION = '00000000-0000-4000-8000-00000000000d';
const TICKET = '00000000-0000-4000-8000-00000000000e';
const TICKET_LEDGER = '00000000-0000-4000-8000-00000000000f';
const TICKET_TRANSACTION = '00000000-0000-4000-8000-000000000010';
const KEY_1 = `tourney:${TOURNAMENT}:obl:${OBLIGATION_1}:0`;

function receipt() {
  return {
    ok: true,
    success: true,
    fully_settled: true,
    receipt_version: 2,
    tournament_id: TOURNAMENT,
    actor_id: ACTOR,
    status: 'CANCELLED',
    source_player_count: 2,
    refunded_count: 2,
    refund_line_count: 1,
    ticket_return_count: 1,
    total_refunded: 20,
    total_ticket_returned: 14.5,
    fees_reversed: 3.5,
    closed_table_count: 1,
    source_seat_count: 2,
    released_seat_count: 2,
    refunds: [
      {
        registration_id: REGISTRATION_1,
        user_id: PLAYER_1,
        entitlement_id: ENTITLEMENT_1,
        entitlement_kind: 'wallet_charge',
        source_wallet_club_id: CLUB,
        gross_paid: 20,
        amount_paid_before: 0,
        amount_paid_now: 20,
        refund_prize: 15,
        refund_bounty: 2,
        refund_fee: 3,
        obligation_id: OBLIGATION_1,
        idempotency_key: KEY_1,
        credit_ledger_id: CREDIT_LEDGER,
        wallet_transaction_id: WALLET_TRANSACTION,
      },
    ],
    ticket_returns: [
      {
        registration_id: REGISTRATION_2,
        user_id: PLAYER_2,
        entitlement_id: ENTITLEMENT_2,
        entitlement_kind: 'satellite_seat',
        ticket_id: TICKET,
        value: 14.5,
        source_wallet_club_id: CLUB,
        source_satellite_id: SATELLITE,
        refund_prize: 14,
        refund_bounty: 0,
        refund_fee: 0.5,
        ledger_id: TICKET_LEDGER,
        transaction_id: TICKET_TRANSACTION,
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
      refundLineCount: 1,
      ticketReturnCount: 1,
      totalRefunded: 20,
      totalTicketReturned: 14.5,
      feesReversed: 3.5,
      sourcePlayerCount: 2,
      closedTableCount: 1,
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
    ['wrong refund line count', { refund_line_count: 2 }],
    ['wrong ticket line count', { ticket_return_count: 0 }],
    ['wrong refund sum', { total_refunded: 19 }],
    ['wrong ticket sum', { total_ticket_returned: 14 }],
    ['malformed numeric total', { total_refunded: '20e0' }],
    ['sub-cent refund', { total_refunded: 20.001 }],
    ['fee larger than all refunds', { fees_reversed: 35 }],
    ['negative row count', { closed_table_count: -1 }],
    ['released more seats than existed', { released_seat_count: 3 }],
    ['invalid settlement timestamp', { settled_at: 'not-a-timestamp' }],
    [
      'duplicate refund entitlement',
      {
        refund_line_count: 2,
        total_refunded: 40,
        refunds: [receipt().refunds[0], { ...receipt().refunds[0] }],
      },
    ],
    [
      'partially refunded line',
      {
        refunds: [{ ...receipt().refunds[0], amount_paid_now: 19 }],
      },
    ],
    [
      'line whose components do not make its settled total',
      {
        refunds: [{ ...receipt().refunds[0], refund_fee: 2 }],
      },
    ],
    [
      'line whose key does not name its obligation and prior paid cents',
      {
        refunds: [{ ...receipt().refunds[0], idempotency_key: 'wrong-key' }],
      },
    ],
    [
      'newly paid line without its durable key',
      {
        refunds: [{ ...receipt().refunds[0], idempotency_key: null }],
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
