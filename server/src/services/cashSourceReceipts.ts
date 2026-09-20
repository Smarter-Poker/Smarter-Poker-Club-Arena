import { pacificAccountingWeek } from './pacificAccountingWeek.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const identity = (x: unknown): x is string => typeof x === 'string' && uuid.test(x);
export interface CashSourceCredit {
  player_id: string;
  club_id: string;
  rake_credit: number;
  period_start: string;
  period_end: string;
}
export interface CashSourceReceipt {
  receipt_id: string;
  rake_record_id: string;
  earned_at: string;
  status: 'accrued' | 'blocked';
  attempt: number;
  source_fingerprint: string;
  reason: string | null;
  credits: CashSourceCredit[];
}

/** A refused source is handled only after its durable refusal is read back.
 * It remains a failure count, never a successful commission or weekly close. */
export function readCashSourceBatch(data: unknown, sourceIds?: string[]): CashSourceReceipt[] {
  const r = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (
    !object(r) ||
    r.receipt_version !== 3 ||
    !integer(r.ok) ||
    !integer(r.failed) ||
    !integer(r.blocked) ||
    r.failed !== r.blocked ||
    r.error != null ||
    (r.failed === 0 && r.first_error != null) ||
    !Array.isArray(r.receipts) ||
    r.ok + r.blocked !== r.receipts.length ||
    r.receipts.length > 2000 ||
    (sourceIds &&
      (new Set(sourceIds).size !== sourceIds.length || sourceIds.length !== r.receipts.length))
  ) {
    throw new Error('Missing or incomplete durable cash source batch receipt');
  }
  const seen = new Set<string>();
  let accrued = 0;
  const receipts = r.receipts.map((value): CashSourceReceipt => {
    if (
      !object(value) ||
      value.receipt_version !== 3 ||
      value.recorded !== true ||
      !identity(value.receipt_id) ||
      !identity(value.rake_record_id) ||
      seen.has(value.rake_record_id) ||
      (sourceIds && !sourceIds.includes(value.rake_record_id)) ||
      !integer(value.attempt) ||
      value.attempt < 1 ||
      typeof value.earned_at !== 'string' ||
      typeof value.source_fingerprint !== 'string' ||
      !/^[0-9a-f]{32}$/.test(value.source_fingerprint) ||
      !Array.isArray(value.credits) ||
      !['accrued', 'blocked'].includes(String(value.status))
    ) {
      throw new Error('Invalid durable cash source identity');
    }
    seen.add(value.rake_record_id);
    if (value.status === 'blocked') {
      if (typeof value.reason !== 'string' || !value.reason || value.credits.length !== 0)
        throw new Error('Invalid cash source refusal');
      return value as unknown as CashSourceReceipt;
    }
    const week = pacificAccountingWeek(value.earned_at);
    const players = new Set<string>();
    if (value.reason != null || value.credits.length === 0)
      throw new Error('Unproven cash contributor receipt');
    for (const c of value.credits) {
      if (
        !object(c) ||
        !identity(c.player_id) ||
        !identity(c.club_id) ||
        players.has(c.player_id) ||
        typeof c.rake_credit !== 'number' ||
        !Number.isFinite(c.rake_credit) ||
        c.rake_credit < 0 ||
        !Number.isSafeInteger(Math.round(c.rake_credit * 100)) ||
        Math.abs(c.rake_credit * 100 - Math.round(c.rake_credit * 100)) > 0.000001 ||
        c.period_start !== week.periodStart ||
        c.period_end !== week.periodEnd
      ) {
        throw new Error('Invalid cash contributor amount or earning week');
      }
      players.add(c.player_id);
    }
    accrued++;
    return value as unknown as CashSourceReceipt;
  });
  if (accrued !== r.ok) throw new Error('Cash source status and counts disagree');
  return receipts;
}

export function verifyCashSourceRefusal(
  receipt: CashSourceReceipt,
  stored: unknown,
  work: unknown
): void {
  if (
    !object(stored) ||
    !object(work) ||
    !object(stored.result) ||
    stored.id !== receipt.receipt_id ||
    stored.rake_record_id !== receipt.rake_record_id ||
    stored.status !== 'blocked' ||
    stored.attempt !== receipt.attempt ||
    stored.source_fingerprint !== receipt.source_fingerprint ||
    stored.reason !== receipt.reason ||
    stored.result.receipt_version !== 3 ||
    stored.result.recorded !== true ||
    stored.result.receipt_id !== receipt.receipt_id ||
    stored.result.rake_record_id !== receipt.rake_record_id ||
    stored.result.status !== 'blocked' ||
    stored.result.earned_at !== receipt.earned_at ||
    stored.result.attempt !== receipt.attempt ||
    !Array.isArray(stored.result.credits) ||
    stored.result.credits.length !== 0 ||
    stored.result.reason !== receipt.reason ||
    stored.result.source_fingerprint !== receipt.source_fingerprint ||
    work.rake_record_id !== receipt.rake_record_id ||
    !identity(work.receipt_id) ||
    !integer(work.attempts) ||
    work.attempts < receipt.attempt ||
    !['accrued', 'blocked'].includes(String(work.status)) ||
    (work.attempts === receipt.attempt &&
      (work.receipt_id !== receipt.receipt_id || work.status !== 'blocked'))
  )
    throw new Error('Cash source refusal has no matching durable retry receipt');
}
