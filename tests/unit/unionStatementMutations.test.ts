import { describe, expect, it } from 'vitest';
import {
  parseUnionPresettlementReceipt,
  parseUnionStatementPaidReceipt,
} from '../../src/utils/unionStatementMutations';

const receiptId = '1d243df4-a97b-4d21-840a-890c5ccdc162';

describe('union statement mutation receipts', () => {
  it('accepts a presettlement receipt only when its exact amount matches the request', () => {
    expect(
      parseUnionPresettlementReceipt(
        { success: true, presettlement_id: receiptId, amount: 15.25 },
        15.25
      )
    ).toEqual({ success: true, presettlement_id: receiptId, amount: 15.25 });

    expect(() =>
      parseUnionPresettlementReceipt(
        { success: true, presettlement_id: receiptId, amount: 15.26 },
        15.25
      )
    ).toThrow(/does not match the request/i);
  });

  it('rejects malformed presettlement success and accepts an explicit failure', () => {
    expect(() => parseUnionPresettlementReceipt({ success: true, amount: 15.25 }, 15.25)).toThrow(
      /identity/i
    );
    expect(
      parseUnionPresettlementReceipt({ success: false, error: 'not authorized' }, 15.25)
    ).toEqual({ success: false, error: 'not authorized' });
  });

  it('accepts exact paid, already-paid, and reopened receipts', () => {
    expect(
      parseUnionStatementPaidReceipt(
        {
          success: true,
          invoice_id: 'invoice-a',
          status: 'paid',
          paid_total: 120.25,
          owed: 120.25,
          fully_settled: true,
        },
        'invoice-a',
        true
      )
    ).toMatchObject({ success: true, status: 'paid', already_settled: false });

    expect(
      parseUnionStatementPaidReceipt(
        {
          success: true,
          already_settled: true,
          invoice_id: 'invoice-a',
          status: 'paid',
          paid_total: 120.25,
          owed: 120.25,
        },
        'invoice-a',
        true
      )
    ).toMatchObject({ success: true, status: 'paid', already_settled: true });

    expect(
      parseUnionStatementPaidReceipt(
        {
          success: true,
          invoice_id: 'invoice-a',
          status: 'generated',
          paid_total: 0,
          owed: 120.25,
          fully_settled: false,
        },
        'invoice-a',
        false
      )
    ).toMatchObject({ success: true, status: 'generated', fully_settled: false });
  });

  it('rejects a mismatched invoice and contradictory settlement totals', () => {
    expect(() =>
      parseUnionStatementPaidReceipt(
        {
          success: true,
          invoice_id: 'invoice-b',
          status: 'paid',
          paid_total: 120.25,
          owed: 120.25,
          fully_settled: true,
        },
        'invoice-a',
        true
      )
    ).toThrow(/another invoice/i);

    expect(() =>
      parseUnionStatementPaidReceipt(
        {
          success: true,
          invoice_id: 'invoice-a',
          status: 'paid',
          paid_total: 120.24,
          owed: 120.25,
          fully_settled: true,
        },
        'invoice-a',
        true
      )
    ).toThrow(/does not reconcile/i);
  });
});
