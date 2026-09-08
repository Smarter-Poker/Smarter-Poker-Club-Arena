import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn(async () => {}) }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { settleTournamentObligation } from './settleObligation.js';
const input = {
  tournamentId: 'event',
  kind: 'place' as const,
  place: 1,
  userId: 'winner',
  amount: 100,
  source: 'audit',
};
const partial = {
  ok: true,
  paid: 40,
  already_paid: 0,
  amount_owed: 100,
  amount_paid: 40,
  remaining: 60,
  fully_settled: false,
  obligation_id: 'obligation',
};
beforeEach(() => vi.clearAllMocks());
async function run(receipt: unknown) {
  const rpc = vi.fn(async () => ({ data: receipt, error: null }));
  const result = await settleTournamentObligation({ rpc }, input, { maxAttempts: 1 });
  expect(rpc).toHaveBeenCalledOnce();
  return result;
}
describe('successful partial settlements remain financial incidents', () => {
  it.each([
    partial,
    { ...partial, paid: 0, already_paid: 40 },
    { ...partial, amount_owed: 120, remaining: 80 },
  ])('reports the recorded unpaid remainder without changing the receipt: %j', async (receipt) => {
    const result = await run(receipt);
    expect(result).toMatchObject({ ok: true, remaining: receipt.remaining, amount_paid: 40 });
    expect(raiseFinancialAlert).toHaveBeenCalledWith(
      'critical',
      'Tournament.obligation_partial',
      expect.any(String),
      expect.objectContaining({
        tournament_id: 'event',
        user_id: 'winner',
        amount_owed: receipt.amount_owed,
        amount_paid: 40,
        remaining: receipt.remaining,
        obligation_id: 'obligation',
        dedupe_key: 'partial:event:place:place:1',
      })
    );
  });
  it('does not report debt for a confirmed full replay', async () => {
    await run({
      ...partial,
      paid: 0,
      already_paid: 100,
      amount_paid: 100,
      remaining: 0,
      fully_settled: true,
    });
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });
  it('does not invent an unpaid amount from an invalid receipt', async () => {
    await run({ ...partial, amount_paid: 80 });
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });
});
