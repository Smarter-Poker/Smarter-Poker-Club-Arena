import { describe, expect, it } from 'vitest';
import {
  parseUnionPresettlementReceipt,
  parseUnionStatementPaidReceipt,
  reserveUnionPresettlement,
  readPendingUnionPresettlement,
  acknowledgeUnionPresettlement,
} from '../../src/utils/unionStatementMutations';

const receiptId = '1d243df4-a97b-4d21-840a-890c5ccdc162';
const expected = {
  operationId: 'ab000000-0000-4000-8000-000000000001',
  unionId: 'union-a',
  clubId: 'club-a',
};
const binding = {
  operation_id: expected.operationId,
  union_id: expected.unionId,
  club_id: expected.clubId,
  duplicate: false,
};

describe('union statement mutation receipts', () => {
  it('accepts a presettlement receipt only when its exact amount matches the request', () => {
    expect(
      parseUnionPresettlementReceipt(
        { success: true, presettlement_id: receiptId, amount: 15.25, ...binding },
        15.25,
        expected
      )
    ).toEqual({ success: true, presettlement_id: receiptId, amount: 15.25, ...binding });

    expect(() =>
      parseUnionPresettlementReceipt(
        { success: true, presettlement_id: receiptId, amount: 15.26, ...binding },
        15.25,
        expected
      )
    ).toThrow(/does not match the request/i);
  });

  it('rejects malformed presettlement success and accepts an explicit failure', () => {
    expect(() =>
      parseUnionPresettlementReceipt({ success: true, amount: 15.25 }, 15.25, expected)
    ).toThrow(/identity/i);
    expect(
      parseUnionPresettlementReceipt({ success: false, error: 'not authorized' }, 15.25, expected)
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

  it.each([
    { operation_id: 'another-operation' },
    { union_id: 'another-union' },
    { club_id: 'another-club' },
    { duplicate: 'true' },
  ])('refuses a receipt with a different payment binding: %o', (mismatch) => {
    expect(() =>
      parseUnionPresettlementReceipt(
        { success: true, presettlement_id: receiptId, amount: 15.25, ...binding, ...mismatch },
        15.25,
        expected
      )
    ).toThrow(/payment identity/);
  });

  it('keeps unresolved payloads and scopes stable in browser storage until acknowledged', () => {
    sessionStorage.clear();
    const first = reserveUnionPresettlement('actor-a', 'union-a', 'club-a', 15.25);
    expect(readPendingUnionPresettlement('actor-a', 'union-a', 'club-a')).toEqual(first);
    expect(() => reserveUnionPresettlement('actor-a', 'union-a', 'club-a', 20)).toThrow(
      /Original Amount/
    );
    expect(readPendingUnionPresettlement('actor-b', 'union-a', 'club-a')).toBeNull();
    expect(readPendingUnionPresettlement('actor-a', 'union-b', 'club-a')).toBeNull();
    expect(reserveUnionPresettlement('actor-a', 'union-a', 'club-a', 15.25)).toEqual(first);
    acknowledgeUnionPresettlement(first);
    const next = reserveUnionPresettlement('actor-a', 'union-a', 'club-a', 15.25);
    expect(next.operationId).not.toBe(first.operationId);
    expect(() => acknowledgeUnionPresettlement(first)).toThrow(/Could Not Be Cleared/);
    expect(readPendingUnionPresettlement('actor-a', 'union-a', 'club-a')).toEqual(next);
  });
});
