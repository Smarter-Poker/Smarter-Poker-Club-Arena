import { supabase } from '../lib/supabase';
import type { CapturedRakebackReadV2, CapturedRakebackClaimV2 } from '../types/capturedRakeback';
import { parseCapturedRakeback, parseCapturedRakebackClaim } from './CapturedRakebackV2';
export { parseCapturedRakeback } from './CapturedRakebackV2';

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

export interface RakebackClaimRequest {
  // Storage envelope version stays stable so unresolved requests survive the ABI upgrade.
  version: 1;
  requestId: string;
  expectedUserId: string;
  clubId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = 'ca:captured-rakeback:v1:';

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

export async function getCapturedRakeback(userId: string): Promise<CapturedRakebackReadV2> {
  const { data, error } = await supabase.rpc('fn_get_captured_rakeback', { p_club_id: null });
  if (error) throw error;
  return parseCapturedRakeback(data, userId);
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
): Promise<CapturedRakebackClaimV2> {
  const { data, error } = await supabase.rpc('fn_claim_captured_rakeback', {
    p_request_id: request.requestId,
    p_expected_user_id: request.expectedUserId,
    p_club_id: request.clubId,
  });
  if (error) throw error;
  return parseCapturedRakebackClaim(data, request);
}

export async function claimLegacyRakeback(clubId: string | null): Promise<number> {
  const { data, error } = await supabase.rpc('fn_claim_rakeback', { p_club_id: clubId });
  if (error) throw error;
  const result = record(data);
  if (result.success !== true) throw new Error('Legacy Claim Could Not Be Verified.');
  return cash(result.total_payout);
}
