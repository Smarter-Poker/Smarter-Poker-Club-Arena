import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn(async () => {}) }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import {
  settleTournamentObligation,
  type SettleTournamentObligationInput,
} from './settleObligation.js';

const input: SettleTournamentObligationInput = {
  tournamentId: 'event',
  kind: 'place',
  place: 1,
  userId: 'player',
  amount: 100,
  source: 'engine.test',
};
const receipt = { ok: true, paid: 100, already_paid: 0 };
async function run(patch: Record<string, unknown>) {
  const rpc = vi.fn(async () => ({ data: receipt, error: null }));
  const result = await settleTournamentObligation(
    { rpc },
    { ...input, ...patch } as SettleTournamentObligationInput,
    { retryDelayMs: () => 0 }
  );
  return { rpc, result };
}
describe('settlement input cannot become a different obligation', () => {
  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    undefined,
    null,
    true,
    false,
    '',
    '100',
    {},
    [],
    Number.MAX_VALUE,
  ])('rejects malformed amount %s without sending a payment', async (amount) => {
    const { rpc, result } = await run({ amount });
    expect(result).toMatchObject({
      ok: false,
      fully_settled: false,
      refused_reason: 'invalid_input',
      paid: 0,
    });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([undefined, null, NaN, Infinity, 0, -1, 1.9, '1', true, 2147483648])(
    'rejects invalid finishing place %s without truncating it',
    async (place) => {
      const { rpc, result } = await run({ place });
      expect(result).toMatchObject({ ok: false, refused_reason: 'invalid_input' });
      expect(rpc).not.toHaveBeenCalled();
    }
  );
  it('keeps an explicit zero a no-op without certifying an old obligation', async () => {
    const { rpc, result } = await run({ amount: 0 });
    expect(result).toMatchObject({ ok: true, fully_settled: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('preserves a valid amount and finishing place', async () => {
    const { rpc, result } = await run({ amount: 100, place: 2 });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      'fn_settle_tournament_obligation',
      expect.objectContaining({ p_amount: 100, p_place: 2 })
    );
  });
  it('preserves a user-keyed refund without a finishing place', async () => {
    const { rpc, result } = await run({ kind: 'refund', place: undefined });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      'fn_settle_tournament_obligation',
      expect.objectContaining({ p_place: null })
    );
  });
});
