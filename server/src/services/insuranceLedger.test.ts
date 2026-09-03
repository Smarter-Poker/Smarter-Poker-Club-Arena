/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AUDIT M3 / Q4 — logInsuranceSettlement (the insurance bank-ledger write)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * By the time this function runs, the table stacks have already been mutated
 * (+payout, -premium) and already persisted by syncStacks(). This is the
 * offsetting bank entry. The original implementation returned `Promise<void>`
 * and swallowed every failure, so a lost write minted or burned chips silently.
 *
 * The invariants that matter here:
 *   1. failure is OBSERVABLE (the return value can carry bad news at all)
 *   2. a transient failure is RETRIED — safe only because the RPC is idempotent
 *      on the (table_id, hand_number, player_id) unique index, which was proven
 *      against production before this was written
 *   3. a definitive failure reports with the PLAYER ID in the context string —
 *      the original shipped a broken template literal ('...paramspl') that
 *      dropped it
 *   4. a definitive failure raises a DURABLE financial alert, because Sentry
 *      does not survive as a reconcilable database row
 *   5. the function is TOTAL: it never rejects, whatever the transport does
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted is REQUIRED here, not stylistic: supabase.ts calls reportError at
// module scope when SUPABASE_SERVICE_ROLE_KEY is absent (it always is under the
// test runner). vi.mock factories are hoisted above plain `const` declarations,
// so a bare `const mockReportError = vi.fn()` is still in its TDZ when that
// module-load call fires, and the suite dies on import with
// "Cannot access 'mockReportError' before initialization".
const { mockRpc, mockMaybeSingle, mockReportError, mockRaiseAlert, queryChain } = vi.hoisted(() => {
  const rpc = vi.fn();
  const maybeSingle = vi.fn();
  // One chainable object satisfies .select().eq().eq().eq().maybeSingle().
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = () => maybeSingle();
  return {
    mockRpc: rpc,
    mockMaybeSingle: maybeSingle,
    mockReportError: vi.fn(),
    mockRaiseAlert: vi.fn(),
    queryChain: chain,
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => queryChain,
  }),
}));

vi.mock('./errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  reportWarning: vi.fn(),
  initSentry: vi.fn(),
  flushSentry: vi.fn(),
  setServerContext: vi.fn(),
}));

// supabase.ts reaches for this with a dynamic import inside the failure branch
// (financialAlerts.ts imports supabase.ts for the client, so a static import
// would close the cycle). vi.mock intercepts dynamic imports too.
vi.mock('./financialAlerts.js', () => ({
  raiseFinancialAlert: (...args: unknown[]) => mockRaiseAlert(...args),
}));

import { logInsuranceSettlement } from './supabase.js';

const TX_ID = '4b0e1f2c-9a3d-4c8e-8f11-2a7d5e6b9c04';
const PLAYER_ID = '2b5a987d-6c5e-4857-b817-dceb1c5e4e5a';

const PARAMS = {
  tableId: '5531cf64-b952-4d34-8734-d84b0b01234f',
  clubId: 'fade0000-0000-0000-0000-000000000001',
  handNumber: 4242,
  playerId: PLAYER_ID,
  equityPercent: 55.5,
  premium: 100,
  insuredAmount: 500,
  payout: 0,
  playerWon: false,
};

describe('logInsuranceSettlement', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockMaybeSingle.mockReset();
    mockReportError.mockReset();
    mockRaiseAlert.mockReset();
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockRaiseAlert.mockResolvedValue({ persisted: true, alertId: 'alert-1' });
  });

  it('records a settlement and returns the transaction id on the first attempt', async () => {
    mockRpc.mockResolvedValue({ data: { id: TX_ID }, error: null });

    const result = await logInsuranceSettlement(PARAMS);

    expect(result).toEqual({ ok: true, transactionId: TX_ID, attempts: 1 });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fnName).toBe('record_insurance_transaction');
    expect(args).toEqual({
      p_table_id: PARAMS.tableId,
      p_club_id: PARAMS.clubId,
      p_hand_number: PARAMS.handNumber,
      p_player_id: PARAMS.playerId,
      p_equity_percent: PARAMS.equityPercent,
      p_premium: PARAMS.premium,
      p_insured_amount: PARAMS.insuredAmount,
      p_payout: PARAMS.payout,
      p_player_won: PARAMS.playerWon,
      // EV CASHOUT 2026-08-28: kind rides every ledger row ('insurance'
      // default; 'ev_cashout' logs redirected winnings in p_premium).
      p_kind: 'insurance',
    });
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('unwraps a single-row composite that PostgREST returned as an array', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: TX_ID }], error: null });
    const result = await logInsuranceSettlement(PARAMS);
    expect(result).toEqual({ ok: true, transactionId: TX_ID, attempts: 1 });
  });

  it('AUDIT M3: retries a transient RPC error and succeeds without alerting', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'ETIMEDOUT' } })
      .mockResolvedValueOnce({ data: { id: TX_ID }, error: null });

    const result = await logInsuranceSettlement(PARAMS);

    expect(result).toEqual({ ok: true, transactionId: TX_ID, attempts: 2 });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockReportError).not.toHaveBeenCalled();
    // A recovered write is not a discrepancy. Alerting here would train the
    // operator to ignore the channel that matters.
    expect(mockRaiseAlert).not.toHaveBeenCalled();
  });

  it('AUDIT M3: retries a thrown transport error too', async () => {
    mockRpc
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ data: { id: TX_ID }, error: null });

    const result = await logInsuranceSettlement(PARAMS);

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('AUDIT M3: an unrecognised success shape triggers a confirm-read, not a false alarm', async () => {
    // The RPC said "no error" but we could not read an id out of the payload.
    // Guessing either way is wrong: guess success and we hide a lost ledger
    // write; guess failure and every settlement raises a CRITICAL. So confirm.
    mockRpc.mockResolvedValue({ data: { unexpected: 'shape' }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: { id: TX_ID }, error: null });

    const result = await logInsuranceSettlement(PARAMS);

    expect(result).toEqual({ ok: true, transactionId: TX_ID, attempts: 1 });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('AUDIT M3: reports not_persisted when the confirm-read finds no row', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await logInsuranceSettlement(PARAMS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_persisted');
    expect(result.attempts).toBe(3);
  });

  it('AUDIT M3: gives up after 3 attempts and returns an observable failure', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    const result = await logInsuranceSettlement(PARAMS);

    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('rpc_error');
    expect(result.attempts).toBe(3);
    // Pre-fix this returned undefined and the caller had nothing to branch on.
    expect(result).not.toBeUndefined();
  });

  it('AUDIT M3: the failure report carries the real player id, not the literal "paramspl"', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await logInsuranceSettlement(PARAMS);

    expect(mockReportError).toHaveBeenCalledTimes(1);
    const [, context, extra] = mockReportError.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(context).toBe(`logInsuranceSettlement.RPC_failed_for_player_${PLAYER_ID}`);
    expect(context).not.toContain('paramspl');
    // Everything an operator needs to settle the discrepancy by hand.
    expect(extra).toMatchObject({
      tableId: PARAMS.tableId,
      clubId: PARAMS.clubId,
      handNumber: PARAMS.handNumber,
      playerId: PLAYER_ID,
      premium: PARAMS.premium,
      insuredAmount: PARAMS.insuredAmount,
      payout: PARAMS.payout,
      reason: 'rpc_error',
    });
  });

  it('AUDIT M3: a definitive failure raises a durable CRITICAL financial alert', async () => {
    // premium 100 collected, payout 0 paid: the table stack went DOWN by 100
    // with no bank entry on the other side, so 100 chips were burned.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await logInsuranceSettlement(PARAMS);

    expect(mockRaiseAlert).toHaveBeenCalledTimes(1);
    const [severity, source, message, context] = mockRaiseAlert.mock.calls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(severity).toBe('critical');
    expect(source).toBe('logInsuranceSettlement.insurance_ledger_write_failed');
    expect(message).toContain('3 attempts');
    expect(context).toEqual({
      table_id: PARAMS.tableId,
      club_id: PARAMS.clubId,
      hand_number: PARAMS.handNumber,
      player_id: PLAYER_ID,
      equity_percent: PARAMS.equityPercent,
      premium: PARAMS.premium,
      insured_amount: PARAMS.insuredAmount,
      payout: PARAMS.payout,
      player_won: PARAMS.playerWon,
      net_chip_delta: PARAMS.payout - PARAMS.premium,
      attempts: 3,
      reason: 'rpc_error',
    });
  });

  it('AUDIT M3: a failed alert cannot break the settlement it was reporting on', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    mockRaiseAlert.mockRejectedValue(new Error('alert transport down'));

    const result = await logInsuranceSettlement(PARAMS);

    // The caller still gets its observable failure even when the alarm fails.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('rpc_error');
  });

  it('AUDIT M3: reports reason "threw" when every attempt throws', async () => {
    mockRpc.mockRejectedValue(new Error('down'));

    const result = await logInsuranceSettlement(PARAMS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('threw');
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('is total - it never rejects, so the settlement loop cannot be aborted by it', async () => {
    mockRpc.mockImplementation(() => {
      throw new Error('synchronous explosion');
    });

    await expect(logInsuranceSettlement(PARAMS)).resolves.toMatchObject({ ok: false });
  });
});
