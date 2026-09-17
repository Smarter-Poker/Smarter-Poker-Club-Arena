import { supabase } from '../lib/supabase';
import { captureWeeklyAccountingAccount } from './ClubWeeklyAccountingReader';

export type AccountingScopeKind = 'union' | 'club';
export interface AccountingWeek { periodStart: string; periodEnd: string }
export interface AccountingObservationInput extends AccountingWeek {
  actorId: string;
  scopeKind: AccountingScopeKind;
  scopeId: string;
  isCurrent?: () => boolean;
}
export interface AccountingRunObservation {
  contract_version: 1;
  actor_user_id: string;
  scope_kind: AccountingScopeKind;
  scope_id: string;
  period_start: string;
  period_end: string;
  observed_at: string;
  expected_run_at: string;
  record_found: boolean;
  state: 'no_recorded_run' | 'running' | 'incomplete' | 'posted' | 'unavailable';
  recorded_scheduled_at: string | null;
  attempts: number | null;
  started_at: string | null;
  finished_at: string | null;
  posted: boolean;
}
const FIELDS = ['contract_version', 'actor_user_id', 'scope_kind', 'scope_id', 'period_start',
  'period_end', 'observed_at', 'expected_run_at', 'record_found', 'state',
  'recorded_scheduled_at', 'attempts', 'started_at', 'finished_at', 'posted'];
export const isAccountingUUID = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
const unavailable = () => new Error('Automatic Accounting Status Is Unavailable');

function dateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw unavailable();
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw unavailable();
  return result;
}
function zonedDate(value: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
}
function localInstant(day: string, hour: number, zone: string): string {
  const desired = dateOnly(day).getTime() + hour * 3_600_000;
  let instant = desired;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    const part = (type: string) => parts.find(p => p.type === type)?.value;
    const local = Date.parse(`${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
    if (!Number.isFinite(local)) throw unavailable();
    instant += desired - local;
  }
  return new Date(instant).toISOString();
}
/** Preserve the Pacific calendar week, including 167/169-hour DST weeks. */
export function accountingWeekEndingOn(day: string): AccountingWeek {
  const end = dateOnly(day);
  if (end.getUTCDay() !== 1) throw unavailable();
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 7);
  return { periodStart: localInstant(start.toISOString().slice(0, 10), 0, 'America/Los_Angeles'),
    periodEnd: localInstant(day, 0, 'America/Los_Angeles') };
}
export function latestClosedAccountingWeek(now = new Date()): AccountingWeek {
  const day = dateOnly(zonedDate(now, 'America/Los_Angeles'));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return accountingWeekEndingOn(day.toISOString().slice(0, 10));
}
export function accountingWeekEndDate(week: AccountingWeek): string {
  return zonedDate(new Date(week.periodEnd), 'America/Los_Angeles');
}
export function accountingRunExpectedAt(week: AccountingWeek): string {
  return localInstant(accountingWeekEndDate(week), 4, 'America/Chicago');
}
/** Bounded UTC spelling and calendar validation; retain PostgreSQL microseconds. */
export function accountingInstant(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 32) throw unavailable();
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!match) throw unavailable();
  dateOnly(match[1]);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw unavailable();
  return BigInt(ms) * 1000n + BigInt((match[5] ?? '').padEnd(6, '0').slice(3));
}
export function validateAccountingScope(input: AccountingObservationInput): AccountingObservationInput {
  if (!isAccountingUUID(input.actorId) || !isAccountingUUID(input.scopeId) ||
      !['club', 'union'].includes(input.scopeKind)) throw unavailable();
  const end = accountingInstant(input.periodEnd), start = accountingInstant(input.periodStart);
  const week = accountingWeekEndingOn(zonedDate(new Date(input.periodEnd), 'America/Los_Angeles'));
  if (start !== accountingInstant(week.periodStart) || end !== accountingInstant(week.periodEnd)) throw unavailable();
  return { ...input, scopeId: input.scopeId.toLowerCase(), ...week };
}

export function parseAccountingRunObservation(value: unknown, requested: AccountingObservationInput): AccountingRunObservation {
  const input = validateAccountingScope(requested);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== FIELDS.length || FIELDS.some(key => !Object.prototype.hasOwnProperty.call(row, key)) ||
      row.contract_version !== 1 || row.actor_user_id !== input.actorId || row.scope_kind !== input.scopeKind || row.scope_id !== input.scopeId ||
      typeof row.record_found !== 'boolean' || typeof row.posted !== 'boolean' || typeof row.state !== 'string' ||
      accountingInstant(row.period_start) !== accountingInstant(input.periodStart) || accountingInstant(row.period_end) !== accountingInstant(input.periodEnd) ||
      accountingInstant(row.expected_run_at) !== accountingInstant(accountingRunExpectedAt(input))) throw unavailable();
  const observed = accountingInstant(row.observed_at);
  const empty = row.recorded_scheduled_at === null && row.attempts === null && row.started_at === null && row.finished_at === null;
  if (!row.record_found) {
    if (row.posted || !empty || row.state !== (input.scopeKind === 'club' ? 'unavailable' : 'no_recorded_run')) throw unavailable();
  } else if (row.state === 'unavailable') {
    if (row.posted || !empty) throw unavailable();
  } else {
    if (!['running', 'incomplete', 'posted'].includes(String(row.state)) || typeof row.attempts !== 'number' || !Number.isSafeInteger(row.attempts) ||
        (row.attempts as number) < 1 || accountingInstant(row.recorded_scheduled_at) !== accountingInstant(row.expected_run_at)) throw unavailable();
    const started = accountingInstant(row.started_at);
    if (started < accountingInstant(row.expected_run_at) || started > observed) throw unavailable();
    if (row.state === 'running') {
      if (row.posted || row.finished_at !== null) throw unavailable();
    } else if (accountingInstant(row.finished_at) < started || accountingInstant(row.finished_at) > observed || row.posted !== (row.state === 'posted')) throw unavailable();
  }
  // posted means this exact v1 server observation attested its complete-v3
  // journal/period contract. It is not a new audit or a device-delivery receipt.
  return row as unknown as AccountingRunObservation;
}

export async function readAccountingRunObservation(requested: AccountingObservationInput): Promise<AccountingRunObservation> {
  const input = validateAccountingScope({ ...requested });
  const account = captureWeeklyAccountingAccount(input.actorId);
  const current = () => {
    if (!account.isCurrent() || (input.isCurrent && input.isCurrent() !== true)) throw unavailable();
  };
  current();
  const { data, error } = await supabase.rpc('fn_accounting_run_observation_v1', {
    p_expected_actor_id: input.actorId, p_scope_kind: input.scopeKind, p_scope_id: input.scopeId,
    p_period_start: input.periodStart, p_period_end: input.periodEnd,
  });
  current();
  if (error) throw unavailable();
  const result = parseAccountingRunObservation(data, input);
  current();
  return result;
}
