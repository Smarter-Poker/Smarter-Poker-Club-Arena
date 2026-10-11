import { describe, expect, it } from 'vitest';
import {
  cashierBatchAcknowledgement,
  cashierBatchAmounts,
  cashierBatchReceiptText,
} from '../../src/utils/cashierBatch';

describe('cashier batch exact amount and receipt contract', () => {
  it.each(['0', '-1', '1e3', '10.005', '1000000001', ''])(
    'refuses invalid recipient amount %s before any send',
    (amount) => {
      expect(cashierBatchAmounts(['a', 'b'], '10', { b: amount }).ok).toBe(false);
    }
  );
  it('uses only the selected visible recipients and exact cent totals', () => {
    expect(cashierBatchAmounts(['a', 'b'], '0.10', { b: '0.20', hidden: '100' })).toEqual({
      ok: true,
      amounts: { a: 0.1, b: 0.2 },
      total: 0.3,
    });
  });
  it.each(
    [
      [],
      [{ user_id: 'b', success: true }],
      [{ user_id: 'a' }],
      [{ user_id: 'a', success: 'true' }],
      [
        { user_id: 'a', success: true },
        { user_id: 'a', success: true },
      ],
    ].map((results) => ({ results }))
  )('does not invent confirmation from ambiguous results %j', ({ results }) => {
    expect(cashierBatchAcknowledgement(results, 'a').outcome).toBe('Outcome Needs Verification');
  });
  it('distinguishes a refusal from an uncertain acknowledgement', () => {
    expect(
      cashierBatchAcknowledgement([{ user_id: 'a', success: false, error: 'No Authority' }], 'a')
    ).toEqual({ outcome: 'Refused', message: 'No Authority' });
    expect(
      cashierBatchAcknowledgement([{ user_id: 'a', success: true, ticket_id: 'ticket-1' }], 'a')
    ).toEqual({ outcome: 'Confirmed', reference: 'ticket-1' });
  });
  it('copies exact receipts with references and counts only confirmed chips', () => {
    const text = cashierBatchReceiptText(
      [
        {
          userId: 'a',
          name: 'Alice',
          amount: 0.1,
          destination: 'Player Wallet',
          outcome: 'Confirmed',
          reference: 'op-a',
        },
        {
          userId: 'b',
          name: 'Bob',
          amount: 0.2,
          destination: 'Agent Wallet',
          outcome: 'Confirmed',
          reference: 'op-b',
        },
        {
          userId: 'c',
          name: 'Chris',
          amount: 50,
          destination: 'Player Wallet',
          outcome: 'Outcome Needs Verification',
          reference: 'op-c',
        },
      ],
      'batch-1',
      'Alpha'
    );
    expect(text).toContain('Confirmed Total: 0.30 Chips');
    expect(text).toContain(
      'Chris: 50.00 Chips | Player Wallet | Outcome Needs Verification | Reference: op-c'
    );
    expect(text).toContain('Batch: batch-1');
  });
});
