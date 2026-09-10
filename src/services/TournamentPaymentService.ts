import { supabase } from '../lib/supabase';

export type TournamentPaymentState = 'paid' | 'partially_paid' | 'owed' | 'not_due';
export interface TournamentPayment {
  id: string;
  tournamentId: string;
  tournamentName: string;
  clubId: string | null;
  kind: string;
  amountOwed: number;
  amountPaid: number;
  remaining: number;
  state: TournamentPaymentState;
  createdAt: string;
  updatedAt: string;
}
export interface TournamentPaymentCursor {
  createdAt: string;
  id: string;
}
export interface TournamentPaymentPage {
  payments: TournamentPayment[];
  next: TournamentPaymentCursor | null;
}
export interface TournamentPaymentFilter {
  tournamentId?: string | null;
  clubId?: string | null;
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Tournament payment response is invalid');
  }
  return raw as Record<string, unknown>;
}
function text(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('Tournament payment identity is missing');
  }
  return raw;
}
function date(raw: unknown): string {
  const value = text(raw);
  if (!Number.isFinite(Date.parse(value))) throw new Error('Tournament payment date is invalid');
  return value;
}
function amount(raw: unknown): number {
  if (
    (typeof raw !== 'number' && typeof raw !== 'string') ||
    (typeof raw === 'string' && raw.trim() === '')
  ) {
    throw new Error('Tournament payment amount is missing');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error('Tournament payment amount is invalid');
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) {
    throw new Error('Tournament payment amount is not an exact chip-cent amount');
  }
  return cents / 100;
}

export function parseTournamentPaymentPage(
  raw: unknown,
  expectedUserId: string,
  filter: TournamentPaymentFilter = {}
): TournamentPaymentPage {
  const page = record(raw);
  if (
    page.user_id !== expectedUserId ||
    !Array.isArray(page.payments) ||
    typeof page.has_more !== 'boolean'
  ) {
    throw new Error('Tournament payment response does not match this account');
  }
  const payments = page.payments.map((item) => {
    const row = record(item);
    const tournamentId = text(row.tournament_id);
    const clubId = row.club_id === null ? null : text(row.club_id);
    if (
      (filter.tournamentId && tournamentId !== filter.tournamentId) ||
      (filter.clubId && clubId !== filter.clubId)
    ) {
      throw new Error('Tournament payment response does not match this view');
    }
    const amountOwed = amount(row.amount_owed);
    const amountPaid = amount(row.amount_paid);
    if (amountPaid > amountOwed) throw new Error('Tournament payment totals are inconsistent');
    const remaining = Math.round((amountOwed - amountPaid) * 100) / 100;
    const state: TournamentPaymentState =
      remaining === 0
        ? amountOwed === 0
          ? 'not_due'
          : 'paid'
        : amountPaid === 0
          ? 'owed'
          : 'partially_paid';
    return {
      id: text(row.id),
      tournamentId,
      tournamentName: text(row.tournament_name),
      clubId,
      kind: text(row.kind),
      amountOwed,
      amountPaid,
      remaining,
      state,
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    };
  });
  let next: TournamentPaymentCursor | null = null;
  if (page.has_more) {
    const last = payments[payments.length - 1];
    next = { createdAt: date(page.next_before_created_at), id: text(page.next_before_id) };
    if (!last || next.id !== last.id || next.createdAt !== last.createdAt) {
      throw new Error('Tournament payment cursor does not match the last record');
    }
  } else if (page.next_before_created_at !== null || page.next_before_id !== null) {
    throw new Error('Tournament payment cursor is inconsistent');
  }
  return { payments, next };
}

export async function getMyTournamentPayments(
  expectedUserId: string,
  filter: TournamentPaymentFilter = {},
  cursor: TournamentPaymentCursor | null = null
): Promise<TournamentPaymentPage> {
  const { data, error } = await supabase.rpc('fn_ca_my_tournament_payments', {
    p_tournament_id: filter.tournamentId ?? null,
    p_club_id: filter.clubId ?? null,
    p_before_created_at: cursor?.createdAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_limit: 50,
  });
  if (error) throw error;
  return parseTournamentPaymentPage(data, expectedUserId, filter);
}
