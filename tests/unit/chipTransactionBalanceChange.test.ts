import { describe, expect, it } from 'vitest';
import { chipTransactionBalanceChange } from '../../src/components/wallet/chipTransactionBalanceChange';

describe('personal chip movement from ledger endpoints', () => {
  it.each([
    ['tournament_buyin', 'viewer', null, -10],
    ['cashout', null, 'viewer', 10],
    ['transfer', 'viewer', 'other', -10],
    ['transfer', 'other', 'viewer', 10],
    ['agent_wallet_self_stake', 'viewer', 'viewer', 0],
    ['agent_wallet_claim_back', 'viewer', 'other', 10],
    ['agent_wallet_claim_back', 'other', 'viewer', -10],
    ['club_bank_send', 'viewer', 'other', 0],
    ['club_bank_send', 'viewer', 'viewer', 10],
    ['club_bank_claim_back', 'viewer', 'other', 0],
    ['club_bank_claim_back', 'other', 'viewer', -10],
    ['club_bank_reversal', 'viewer', 'viewer', -10],
  ])(
    '%s from %s to %s changes the viewer by %s',
    (transaction_type, from_user_id, to_user_id, expected) => {
      expect(
        chipTransactionBalanceChange(
          { transaction_type, from_user_id, to_user_id, amount: '10.00' },
          'viewer'
        )
      ).toBe(expected);
    }
  );
  it('keeps legacy signed rows and does not double-negate a debit', () => {
    expect(chipTransactionBalanceChange({ amount: -10 }, 'viewer')).toBe(-10);
    expect(chipTransactionBalanceChange({ amount: -10, from_user_id: 'viewer' }, 'viewer')).toBe(
      -10
    );
  });
});
it('refuses an invalid ledger amount instead of manufacturing a balance', () => {
  expect(() => chipTransactionBalanceChange({ amount: 'invalid' }, 'viewer')).toThrow(
    'Invalid chip transaction amount'
  );
});
it('keeps an internal transfer visible without inventing personal inflow', () => {
  expect(
    chipTransactionBalanceChange(
      {
        transaction_type: 'agent_wallet_self_stake',
        from_user_id: 'viewer',
        to_user_id: 'viewer',
        amount: 25,
      },
      'viewer'
    )
  ).toBe(0);
});
