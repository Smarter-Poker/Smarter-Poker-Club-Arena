import { supabase } from '../lib/supabase';
import { getIdentityDNAStatus } from '../core/IdentityDNA';
import { captureCashoutAccountGuard } from './CashoutService';
import { resolveClubUUID } from '../utils/clubIdResolver';

export const CLUB_WEEKLY_STATEMENT_LIMIT = 50;
export const CLUB_WEEKLY_EXPORT_LIMIT = 1000;
export const CLUB_WEEKLY_INVOICE_TYPE = 'club_weekly_accounting';

// Read money and JSON numeric facts as text. Never recover cents from a rounded
// JavaScript JSON number or reinterpret an individual/correction invoice.
const COLUMNS = 'id,club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,' +
  'gross_amount::text,deductions::text,net_amount::text,status,created_at,message_sent,' +
  'accounting_version:breakdown->>accounting_version,summary_club_id:breakdown->>club_id,' +
  'summary_period_id:breakdown->>period_id,currency:breakdown->>currency,' +
  'ready_to_issue:breakdown->>ready_to_issue,summary_status:breakdown->>status,' +
  'period_start:breakdown->>period_start,period_end:breakdown->>period_end,' +
  'total_rake_funding:breakdown->>total_rake_funding,total_paid_by_club:breakdown->>total_paid_by_club,' +
  'retained_by_club:breakdown->>retained_by_club';

const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59;
}

function dateWindow(value: unknown): value is string {
  // Existing export filters accept a date at midnight as well as an instant.
  // Preserve that input and created_at filter contract; do not turn an end
  // date into an invented end-of-day or accounting-period boundary.
  return typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(value)
    ? timestamp(`${value}T00:00:00Z`)
    : timestamp(value));
}

function instant(value: string): bigint {
  // PostgreSQL preserves microseconds; Date.parse keeps only milliseconds.
  // Values have already passed the calendar/instant validator above.
  const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}

function cents(value: unknown, signed = false): bigint {
  if (typeof value !== 'string' || value.length > 128) throw new Error('Weekly Statement Amount Is Unavailable');
  // Captured settlement_invoices gross_amount/deductions/net_amount are
  // numeric(12,2): at most ten integral digits, plus two fractional digits.
  // JSON breakdown numbers may retain trailing zero scale; never round them.
  const match = /^(-?)(0|[1-9]\d{0,9})(?:\.(\d+))?$/.exec(value);
  if (!match || (!signed && match[1]) || /[1-9]/.test((match[3] ?? '').slice(2))) {
    throw new Error('Weekly Statement Amount Is Unavailable');
  }
  const amount = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0').slice(0, 2));
  return match[1] ? -amount : amount;
}
function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export function formatWeeklyChips(value: string): string {
  const [whole, fraction] = value.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

export interface ClubWeeklyStatement {
  id: string;
  clubId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  rakeFunding: string;
  paidByClub: string;
  retainedByClub: string;
}

/** Reuse the existing canonical auth generation; this reader adds no counter. */
export function captureWeeklyAccountingAccount(expectedUserId?: string) {
  const identity = getIdentityDNAStatus();
  if (!identity.loaded || !identity.authenticated || !uuid(identity.userId) ||
      (expectedUserId !== undefined && expectedUserId !== identity.userId)) {
    throw new Error('Weekly Statements Require The Current Account');
  }
  return { userId: identity.userId, isCurrent: captureCashoutAccountGuard(identity.userId) };
}

export async function readClubWeeklyStatements(options: {
  clubId: string;
  userId?: string;
  limit?: number;
  periodStart?: string;
  periodEnd?: string;
  isCurrent?: () => boolean;
  cursor?: { createdAt: string; id: string; clubId: string; actorId: string };
}): Promise<{ rows: ClubWeeklyStatement[]; limit: number }> {
  const captured = { ...options, cursor: options.cursor ? { ...options.cursor } : undefined };
  const account = captureWeeklyAccountingAccount(captured.userId);
  const check = () => {
    if (!account.isCurrent() || (captured.isCurrent && captured.isCurrent() !== true)) {
      throw new Error('Weekly Statement Account Or Club Changed. Refresh The Original View.');
    }
  };
  const limit = captured.limit ?? CLUB_WEEKLY_STATEMENT_LIMIT;
  if (!captured.clubId || !Number.isSafeInteger(limit) || limit < 1 || limit > CLUB_WEEKLY_EXPORT_LIMIT ||
      (captured.periodStart !== undefined && !dateWindow(captured.periodStart)) ||
      (captured.periodEnd !== undefined && !dateWindow(captured.periodEnd)) ||
      (captured.periodStart && captured.periodEnd && instant(captured.periodStart) > instant(captured.periodEnd))) {
    throw new Error('Weekly Statement Club, Date Window Or Limit Is Invalid');
  }
  check();
  const resolved = await resolveClubUUID(captured.clubId);
  check();
  if (!uuid(resolved)) throw new Error('Weekly Statement Club Is Unavailable');
  const clubId = resolved.toLowerCase();
  const cursor = captured.cursor;
  if (cursor && (!timestamp(cursor.createdAt) || !uuid(cursor.id) || cursor.id !== cursor.id.toLowerCase() ||
      cursor.clubId !== clubId || cursor.actorId !== account.userId ||
      (captured.periodStart && instant(cursor.createdAt) < instant(captured.periodStart)) ||
      (captured.periodEnd && instant(cursor.createdAt) > instant(captured.periodEnd)))) {
    throw new Error('Weekly Statement Cursor Scope Is Invalid');
  }
  let query = supabase.from('settlement_invoices').select(COLUMNS)
    .eq('club_id', clubId).eq('invoice_type', CLUB_WEEKLY_INVOICE_TYPE);
  if (captured.periodStart) query = query.gte('created_at', captured.periodStart);
  if (captured.periodEnd) query = query.lte('created_at', captured.periodEnd);
  if (cursor) {
    // Closed ISO/UUID grammars above exclude all query syntax characters.
    // This cursor narrows a visible page; it is not an immutable snapshot.
    query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  }
  const { data, error } = await query.order('created_at', { ascending: false })
    .order('id', { ascending: false }).limit(limit);
  check();
  if (error) throw new Error('Weekly Statements Are Unavailable');
  if (!Array.isArray(data) || data.length > limit) throw new Error('Weekly Statement Rows Could Not Be Verified');
  const seen = new Set<string>();
  const periods = new Set<string>();
  let previous: { createdAt: string; id: string } | undefined = cursor;
  const rows = data.map((value: unknown): ClubWeeklyStatement => {
    if (!object(value) || !uuid(value.id) || !uuid(value.period_id) || value.club_id !== clubId ||
        value.invoice_type !== CLUB_WEEKLY_INVOICE_TYPE || value.from_entity_type !== 'club' ||
        value.to_entity_type !== 'club' || value.from_entity_id !== clubId || value.to_entity_id !== clubId ||
        value.accounting_version !== '3' || value.summary_club_id !== clubId || value.summary_period_id !== value.period_id ||
        value.currency !== 'CHIPS' || value.ready_to_issue !== 'true' || value.summary_status !== 'complete' ||
        value.status !== 'generated' || value.message_sent !== true || !timestamp(value.created_at) ||
        !timestamp(value.period_start) || !timestamp(value.period_end) || instant(value.period_start) >= instant(value.period_end) ||
        seen.has(value.id) || periods.has(value.period_id)) throw new Error('Weekly Statement Scope Could Not Be Verified');
    if ((captured.periodStart && instant(value.created_at) < instant(captured.periodStart)) ||
        (captured.periodEnd && instant(value.created_at) > instant(captured.periodEnd))) {
      throw new Error('Weekly Statement Date Scope Could Not Be Verified');
    }
    if (previous && (instant(value.created_at) > instant(previous.createdAt) ||
        (instant(value.created_at) === instant(previous.createdAt) && value.id.toLowerCase() >= previous.id))) {
      throw new Error('Weekly Statement Page Order Could Not Be Verified');
    }
    previous = { createdAt: value.created_at, id: value.id.toLowerCase() };
    const funding = cents(value.gross_amount), paid = cents(value.deductions), retained = cents(value.net_amount, true);
    if (funding - paid !== retained || funding !== cents(value.total_rake_funding) ||
        paid !== cents(value.total_paid_by_club) || retained !== cents(value.retained_by_club, true)) {
      throw new Error('Weekly Statement Amounts Could Not Be Verified');
    }
    seen.add(value.id); periods.add(value.period_id);
    return { id: value.id, clubId, periodId: value.period_id, periodStart: value.period_start,
      periodEnd: value.period_end, createdAt: value.created_at, rakeFunding: decimal(funding),
      paidByClub: decimal(paid), retainedByClub: decimal(retained) };
  });
  check();
  return { rows, limit };
}
