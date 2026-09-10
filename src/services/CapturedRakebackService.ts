import { supabase } from '../lib/supabase';

export interface LegacyRakebackPeriod {
  id: string;
  club_id: string;
  period_start: string;
  period_end: string;
  rake_generated: number;
  rakeback_rate: number;
  rakeback_earned: number;
  status: string;
}

export interface CapturedRakebackPeriod extends Omit<LegacyRakebackPeriod, 'id'> {
  paid_amount: number;
  pending_amount: number;
  exact_entitlement: number;
  unpaid_exact_entitlement: number;
  unresolved_sources: number;
  status: 'open' | 'needs_review' | 'pending' | 'fraction_pending' | 'settled_so_far';
}

export interface CapturedRakeback {
  source_active: boolean;
  source_final: false;
  periods: CapturedRakebackPeriod[];
}

export interface RakebackClaimRequest {
  version: 1;
  requestId: string;
  expectedUserId: string;
  clubId: string | null;
}

export interface CapturedRakebackPeriodClaim {
  success: boolean;
  period_id: string;
  new_payout: number;
  source_accruals_added: number;
  paid_receipts: unknown[];
  deferred: unknown[];
  source_final: false;
}

export interface CapturedRakebackClaim {
  success: true;
  request_id: string;
  total_payout: number;
  periods_claimed: number;
  periods: CapturedRakebackPeriodClaim[];
  source_final: false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = 'ca:captured-rakeback:v1:';
const STATUSES = new Set(['open', 'needs_review', 'pending', 'fraction_pending', 'settled_so_far']);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Rakeback Response Could Not Be Verified. Please Retry.');
  }
  return value as Record<string, unknown>;
}

function amount(value: unknown): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error('Rakeback Amount Could Not Be Verified. Please Retry.');
  }
  return Number(value);
}

function cents(value: unknown): number {
  const valueNumber = amount(value);
  const decimal = typeof value === 'string' ? value : String(valueNumber);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2}0*)?$/.test(decimal)) {
    throw new Error('Rakeback Must Be A Whole-Cent Amount.');
  }
  const scaled = valueNumber * 100;
  const rounded = Math.round(scaled);
  if (
    !Number.isSafeInteger(rounded) ||
    Math.abs(scaled - rounded) > Number.EPSILON * Math.max(1, scaled) * 2
  ) {
    throw new Error('Rakeback Must Be A Safe Whole-Cent Amount.');
  }
  return rounded;
}

function cash(value: unknown): number {
  return cents(value) / 100;
}

function week(start: unknown, end: unknown): void {
  if (
    typeof start !== 'string' ||
    typeof end !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end)
  ) {
    throw new Error('Rakeback Week Could Not Be Verified.');
  }
  const first = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  if (
    !Number.isFinite(first.getTime()) ||
    !Number.isFinite(last.getTime()) ||
    first.toISOString().slice(0, 10) !== start ||
    last.toISOString().slice(0, 10) !== end ||
    first.getUTCDay() !== 1 ||
    last.getUTCDay() !== 0 ||
    last.getTime() - first.getTime() !== 6 * 86400000
  ) {
    throw new Error('Rakeback Week Could Not Be Verified.');
  }
}

export function parseCapturedRakeback(value: unknown): CapturedRakeback {
  const data = record(value);
  if (
    typeof data.source_active !== 'boolean' ||
    data.source_final !== false ||
    !Array.isArray(data.periods)
  ) {
    throw new Error('Rakeback Availability Could Not Be Verified. Please Retry.');
  }
  if (!data.source_active && data.periods.length > 0) {
    throw new Error('Rakeback Availability Contradicts Its Periods. Please Retry.');
  }
  const seen = new Set<string>();
  const periods = data.periods.map((value) => {
    const row = record(value);
    if (
      typeof row.club_id !== 'string' ||
      !UUID.test(row.club_id) ||
      typeof row.period_start !== 'string' ||
      !Number.isFinite(Date.parse(row.period_start)) ||
      typeof row.period_end !== 'string' ||
      !Number.isFinite(Date.parse(row.period_end)) ||
      typeof row.status !== 'string' ||
      !STATUSES.has(row.status)
    )
      throw new Error('Rakeback Period Could Not Be Verified. Please Retry.');
    week(row.period_start, row.period_end);
    const key = row.club_id.toLowerCase() + ':' + row.period_start;
    if (seen.has(key) || !Number.isSafeInteger(amount(row.unresolved_sources))) {
      throw new Error('Rakeback Period Could Not Be Verified.');
    }
    seen.add(key);
    return {
      club_id: row.club_id,
      period_start: row.period_start,
      period_end: row.period_end,
      status: row.status as CapturedRakebackPeriod['status'],
      rake_generated: amount(row.rake_generated),
      rakeback_rate: amount(row.rakeback_rate),
      rakeback_earned: cash(row.rakeback_earned),
      paid_amount: cash(row.paid_amount),
      pending_amount: cash(row.pending_amount),
      exact_entitlement: amount(row.exact_entitlement),
      unpaid_exact_entitlement: amount(row.unpaid_exact_entitlement),
      unresolved_sources: amount(row.unresolved_sources),
    };
  });
  return { source_active: data.source_active, source_final: false, periods };
}

export async function getCapturedRakeback(): Promise<CapturedRakeback> {
  const { data, error } = await supabase.rpc('fn_get_captured_rakeback');
  if (error) throw error;
  return parseCapturedRakeback(data);
}

export async function getLegacyRakeback(userId: string): Promise<LegacyRakebackPeriod[]> {
  const { data, error } = await supabase
    .from('rakeback_periods')
    .select(
      'id, club_id, period_start, period_end, rake_generated, rakeback_rate, rakeback_earned, status'
    )
    .eq('user_id', userId)
    .order('period_start', { ascending: false })
    .limit(12);
  if (error) throw error;
  return data || [];
}

function actorPrefix(userId: string): string {
  if (!UUID.test(userId)) throw new Error('Please Sign In Again To Verify Your Account.');
  return PREFIX + userId.toLowerCase() + ':';
}

export function readRakebackRequests(userId: string): RakebackClaimRequest[] {
  const prefix = actorPrefix(userId) + 'request:';
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  keys.sort();
  return keys.flatMap((key) => {
    const stored = localStorage.getItem(key);
    if (stored === null) return [];
    const data = record(JSON.parse(stored));
    if (
      data.version !== 1 ||
      data.expectedUserId !== userId ||
      typeof data.requestId !== 'string' ||
      !UUID.test(data.requestId) ||
      (data.clubId !== null && (typeof data.clubId !== 'string' || !UUID.test(data.clubId))) ||
      key !== prefix + data.requestId
    )
      throw new Error(
        'Saved Claim Could Not Be Verified. Please Contact Support Before Claiming Again.'
      );
    return [data as unknown as RakebackClaimRequest];
  });
}

export function hasCapturedRakebackActivation(userId: string): boolean {
  const marker = localStorage.getItem(actorPrefix(userId) + 'active');
  if (marker !== null && marker !== 'true')
    throw new Error('Saved Rakeback Availability Could Not Be Verified.');
  return marker === 'true' || readRakebackRequests(userId).length > 0;
}

export function observeRakebackActivation(userId: string, active: boolean): boolean {
  const previouslyActive = hasCapturedRakebackActivation(userId);
  if (active) {
    const key = actorPrefix(userId) + 'active';
    localStorage.setItem(key, 'true');
    if (localStorage.getItem(key) !== 'true')
      throw new Error('Please Allow Browser Storage Before Claiming.');
  }
  if (previouslyActive && !active) {
    throw new Error('Rakeback Availability Changed. Please Retry. Your Saved Claim Is Preserved.');
  }
  return active;
}

export function prepareRakebackRequest(userId: string): RakebackClaimRequest {
  const previous = readRakebackRequests(userId)[0];
  if (previous) return previous;
  if (!hasCapturedRakebackActivation(userId)) throw new Error('Rakeback Is Not Available Yet.');
  const request: RakebackClaimRequest = {
    version: 1,
    requestId: crypto.randomUUID(),
    expectedUserId: userId,
    clubId: null,
  };
  const key = actorPrefix(userId) + 'request:' + request.requestId;
  const value = JSON.stringify(request);
  localStorage.setItem(key, value);
  if (localStorage.getItem(key) !== value)
    throw new Error('Please Allow Browser Storage Before Claiming.');
  return request;
}

export function clearRakebackRequest(request: RakebackClaimRequest): void {
  const key = actorPrefix(request.expectedUserId) + 'request:' + request.requestId;
  const saved = readRakebackRequests(request.expectedUserId).find(
    (item) => item.requestId === request.requestId
  );
  if (saved && saved.clubId !== request.clubId)
    throw new Error('Saved Claim Scope Changed. Please Contact Support.');
  localStorage.removeItem(key);
}

export async function claimCapturedRakeback(
  request: RakebackClaimRequest
): Promise<CapturedRakebackClaim> {
  const { data, error } = await supabase.rpc('fn_claim_captured_rakeback', {
    p_request_id: request.requestId,
    p_expected_user_id: request.expectedUserId,
    p_club_id: request.clubId,
  });
  if (error) throw error;
  const result = record(data);
  if (
    result.success !== true ||
    result.request_id !== request.requestId ||
    result.source_final !== false ||
    !Array.isArray(result.periods) ||
    !Number.isInteger(result.periods_claimed) ||
    Number(result.periods_claimed) < 0
  )
    throw new Error(
      'Claim Response Could Not Be Verified. Use Recover Claim To Check The Same Request.'
    );
  const totalCents = cents(result.total_payout);
  let periodCents = 0;
  let paidPeriods = 0;
  const seenPeriods = new Set<string>();
  for (const value of result.periods) {
    const period = record(value);
    if (
      typeof period.success !== 'boolean' ||
      typeof period.period_id !== 'string' ||
      !UUID.test(period.period_id) ||
      seenPeriods.has(period.period_id.toLowerCase()) ||
      period.source_final !== false ||
      !Array.isArray(period.paid_receipts) ||
      !Array.isArray(period.deferred) ||
      !Number.isSafeInteger(period.source_accruals_added) ||
      Number(period.source_accruals_added) < 0
    ) {
      throw new Error('Claim Period Receipt Could Not Be Verified. Use Recover Claim.');
    }
    seenPeriods.add(period.period_id.toLowerCase());
    const paid = cents(period.new_payout);
    if (period.success === false && (paid !== 0 || period.deferred.length === 0)) {
      throw new Error('Deferred Claim Could Not Be Verified. Use Recover Claim.');
    }
    periodCents += paid;
    if (!Number.isSafeInteger(periodCents)) throw new Error('Claim Total Could Not Be Verified.');
    if (paid > 0) paidPeriods++;
  }
  if (periodCents !== totalCents || paidPeriods !== result.periods_claimed) {
    throw new Error('Claim Period Totals Could Not Be Verified. Use Recover Claim.');
  }
  return { ...result, total_payout: totalCents / 100 } as unknown as CapturedRakebackClaim;
}

export async function claimLegacyRakeback(clubId: string | null): Promise<number> {
  const { data, error } = await supabase.rpc('fn_claim_rakeback', { p_club_id: clubId });
  if (error) throw error;
  const result = record(data);
  if (result.success !== true) throw new Error('Legacy Claim Could Not Be Verified.');
  return cash(result.total_payout);
}
