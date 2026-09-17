import { describe, expect, it } from 'vitest';
import { creditAdminMoney, creditAdminRow, creditAdminTotal, readCreditMoney } from '../src/utils/creditAdminData';

const row = (overrides: Record<string, unknown> = {}) => creditAdminRow({
  id: 'agent-a', user_id: 'player-a', club_id: 'club-a', status: 'active',
  credit_limit: '100.00', agent_wallet_balance: '500.00', credit_used: '25.31',
  ...overrides,
}, 'Agent A');

describe('Credit admin money is recorded debt, not unused capacity', () => {
  it('keeps drawn debt independent of the credit ceiling and wallet', () => {
    expect(row().debtOwed).toBe(25.31);
    expect(row({ credit_limit: '1000', agent_wallet_balance: '0' }).debtOwed).toBe(25.31);
    expect(row({ credit_limit: null, agent_wallet_balance: null }).debtOwed).toBe(25.31);
    expect(row({ credit_used: '0.00' }).debtOwed).toBe(0);
  });

  it.each([null, undefined, '', ' ', 'NaN', Infinity, NaN, true, '-1', '1.231', '1x', '1e3']) (
    'preserves invalid or missing money as unavailable: %s', (value) => {
      expect(readCreditMoney(value)).toBeNull();
      expect(row({ credit_used: value }).debtOwed).toBeNull();
      expect(creditAdminTotal([row({ credit_used: value })], 'debtOwed')).toBeNull();
    }
  );

  it('sums exact cents and preserves an unavailable row instead of substituting zero', () => {
    expect(creditAdminTotal([row({ credit_used: '0.10' }), row({ credit_used: '0.20' })], 'debtOwed')).toBe(0.3);
    expect(creditAdminTotal([row(), row({ credit_used: null })], 'debtOwed')).toBeNull();
    expect(creditAdminMoney(null)).toBe('Unavailable');
    expect(readCreditMoney('1.2300')).toBe(1.23);
  });

  it('refuses cents lost during number conversion even below the safe integer cent bound', () => {
    expect(readCreditMoney('90071992547409.91')).toBeNull();
    expect(readCreditMoney('90071992547409.90')).toBeNull();
    expect(readCreditMoney('90071992547409.89')).toBe(90071992547409.89);
    expect(readCreditMoney('90071992547409.92')).toBeNull();
    expect(creditAdminTotal([
      row({ credit_used: '90071992547409.89' }), row({ credit_used: '0.01' }),
    ], 'debtOwed')).toBeNull();
  });

  it('bounds malformed decimal input before BigInt parsing and refuses missing identities', () => {
    expect(readCreditMoney('9'.repeat(100_000))).toBeNull();
    expect(readCreditMoney(`0.${'0'.repeat(100_000)}1`)).toBeNull();
    expect(() => row({ club_id: null })).toThrow(/identity/);
  });
});
