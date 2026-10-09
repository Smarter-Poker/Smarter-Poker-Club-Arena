import {
  readSessionPurchaseRequest,
  readOrCreateSessionPurchaseRequest,
  clearSessionPurchaseRequestIfMatches,
  type SessionPurchaseRequest,
} from './sessionPurchaseRequest';

export type UnionMutationFailure = { success: false; error: string };

export type UnionPresettlementReceipt = {
  success: true;
  presettlement_id: string;
  amount: number;
  operation_id: string;
  union_id: string;
  club_id: string;
  duplicate: boolean;
  invoice_id: string;
  received_at: string;
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
  expectedAmount: number,
  expected: { operationId: string; unionId: string; clubId: string }
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
  if (
    row.operation_id !== expected.operationId ||
    row.union_id !== expected.unionId ||
    row.club_id !== expected.clubId ||
    typeof row.duplicate !== 'boolean'
  )
    throw new Error('Presettlement receipt does not match the payment identity');
  const invoiceId = textValue(row.invoice_id, 'Presettlement invoice identity');
  const receivedAt = textValue(row.received_at, 'Presettlement received time');
  if (!UUID.test(invoiceId) || !Number.isFinite(Date.parse(receivedAt)))
    throw new Error('Presettlement invoice receipt is invalid');
  return {
    success: true,
    presettlement_id: id,
    amount,
    operation_id: expected.operationId,
    union_id: expected.unionId,
    club_id: expected.clubId,
    duplicate: row.duplicate,
    invoice_id: invoiceId,
    received_at: receivedAt,
  };
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

export const UNION_PRESETTLEMENT_NOTE = 'Recorded on the statement board';
export interface PendingUnionPresettlement {
  scope: string;
  operationId: string;
  amount: number;
}

function presettlementScope(actorId: string, unionId: string, clubId: string): string {
  if (![actorId, unionId, clubId].every((value) => typeof value === 'string' && value.trim()))
    throw new Error('The Payment Account Could Not Be Verified');
  return JSON.stringify(['union-presettlement:v1', actorId, unionId, clubId]);
}
function paymentPayload(amount: number): string {
  return JSON.stringify([
    moneyValue(amount, 'Payment amount', true).toFixed(2),
    null,
    null,
    UNION_PRESETTLEMENT_NOTE,
  ]);
}
function pendingPayment(scope: string, stored: SessionPurchaseRequest): PendingUnionPresettlement {
  const terms: unknown = JSON.parse(stored.payloadKey);
  if (!Array.isArray(terms) || typeof terms[0] !== 'string')
    throw new Error('The Saved Payment Could Not Be Verified');
  const amount = Number(terms[0]);
  if (paymentPayload(amount) !== stored.payloadKey)
    throw new Error('The Saved Payment Could Not Be Verified');
  return { scope, operationId: stored.requestId, amount };
}
export function readPendingUnionPresettlement(
  actorId: string,
  unionId: string,
  clubId: string
): PendingUnionPresettlement | null {
  const scope = presettlementScope(actorId, unionId, clubId);
  const stored = readSessionPurchaseRequest(scope);
  return stored ? pendingPayment(scope, stored) : null;
}
export function reserveUnionPresettlement(
  actorId: string,
  unionId: string,
  clubId: string,
  amount: number
): PendingUnionPresettlement {
  const scope = presettlementScope(actorId, unionId, clubId);
  const payload = paymentPayload(amount);
  const stored = readOrCreateSessionPurchaseRequest(scope, payload);
  if (stored.payloadKey !== payload)
    throw new Error('An Earlier Payment Is Unconfirmed. Retry Its Original Amount First.');
  return pendingPayment(scope, stored);
}
export function acknowledgeUnionPresettlement(request: PendingUnionPresettlement): void {
  if (!clearSessionPurchaseRequestIfMatches(request.scope, request.operationId))
    throw new Error('The Confirmed Payment Could Not Be Cleared. Retry To Check Its Receipt.');
}
