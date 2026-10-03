export type UnionMutationFailure = { success: false; error: string };

export type UnionPresettlementReceipt = {
  success: true;
  presettlement_id: string;
  amount: number;
};

export type UnionStatementPaidReceipt = {
  success: true;
  invoice_id: string;
  status: 'generated' | 'paid';
  paid_total: number;
  owed: number;
  already_settled: boolean;
  fully_settled: boolean;
};

type JsonRecord = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function moneyValue(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${label} is invalid`);
  }
  const amountCents = Math.round(value * 100);
  if (!Number.isSafeInteger(amountCents) || Math.abs(value * 100 - amountCents) > 0.000001) {
    throw new Error(`${label} is not an exact chip-cent amount`);
  }
  return amountCents / 100;
}

function failureValue(row: JsonRecord, label: string): UnionMutationFailure {
  return { success: false, error: textValue(row.error, `${label} error`) };
}

export function parseUnionPresettlementReceipt(
  value: unknown,
  expectedAmount: number
): UnionPresettlementReceipt | UnionMutationFailure {
  const row = objectValue(value, 'Presettlement receipt');
  if (typeof row.success !== 'boolean') throw new Error('Presettlement receipt success is invalid');
  if (!row.success) return failureValue(row, 'Presettlement receipt');

  const id = textValue(row.presettlement_id, 'Presettlement receipt identity');
  if (!UUID.test(id)) throw new Error('Presettlement receipt identity is invalid');
  const amount = moneyValue(row.amount, 'Presettlement receipt amount', true);
  const requested = moneyValue(expectedAmount, 'Requested presettlement amount', true);
  if (Math.round(amount * 100) !== Math.round(requested * 100)) {
    throw new Error('Presettlement receipt amount does not match the request');
  }
  return { success: true, presettlement_id: id, amount };
}

export function parseUnionStatementPaidReceipt(
  value: unknown,
  expectedInvoiceId: string,
  expectedPaid: boolean
): UnionStatementPaidReceipt | UnionMutationFailure {
  const row = objectValue(value, 'Statement settlement receipt');
  if (typeof row.success !== 'boolean') {
    throw new Error('Statement settlement receipt success is invalid');
  }
  if (!row.success) return failureValue(row, 'Statement settlement receipt');

  const invoiceId = textValue(row.invoice_id, 'Statement settlement invoice identity');
  if (invoiceId !== expectedInvoiceId) {
    throw new Error('Statement settlement receipt belongs to another invoice');
  }
  const status = textValue(row.status, 'Statement settlement status');
  const paidTotal = moneyValue(row.paid_total, 'Statement settlement paid total');
  const owed = moneyValue(row.owed, 'Statement settlement owed total');
  const alreadySettled = row.already_settled === true;

  if (expectedPaid) {
    if (status !== 'paid' || paidTotal !== owed) {
      throw new Error('Paid statement settlement receipt does not reconcile');
    }
    if (!alreadySettled && row.fully_settled !== true) {
      throw new Error('Paid statement settlement receipt is incomplete');
    }
    if (row.fully_settled !== undefined && row.fully_settled !== true) {
      throw new Error('Paid statement settlement receipt is contradictory');
    }
    return {
      success: true,
      invoice_id: invoiceId,
      status: 'paid',
      paid_total: paidTotal,
      owed,
      already_settled: alreadySettled,
      fully_settled: true,
    };
  }

  if (status !== 'generated' || paidTotal !== 0 || row.fully_settled !== false || alreadySettled) {
    throw new Error('Reopened statement settlement receipt does not reconcile');
  }
  return {
    success: true,
    invoice_id: invoiceId,
    status: 'generated',
    paid_total: paidTotal,
    owed,
    already_settled: false,
    fully_settled: false,
  };
}
