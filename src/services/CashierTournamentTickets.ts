/**
 * CASHIER TOURNAMENT TICKETS (2026-10-15)
 *
 * Dan: "SEND TICKET" SHOULD HAVE A DROP DOWN WHERE ANY AND ALL "FUTURE OR
 * CURRENTLY RUNNING TOURNAMENTS" SHOULD BE DISPLAYED TO "SELECT" AND AWARD
 * THAT USER A TICKET INTO THAT TOURNAMENT. FUNDS SHOULD BE SUBTRACTED FROM
 * THE SENDERS BALANCE.
 *
 * Server side: migration 20261015132042_cashier_sends_a_ticket_into_one_tournament.
 *
 *   listTicketableTournaments(clubId)   -> fn_cashier_ticketable_tournaments
 *   buildTournamentTicketItem(...)      -> one p_items entry for
 *                                          fn_cashier_batch_transfer(p_kind 'ticket')
 *   issueTournamentEntryTicket(...)     -> fn_issue_tournament_entry_ticket (single send)
 *
 * The SERVER prices the ticket from the tournament. The `amount` a batch item
 * carries is only the price the cashier was shown: if the tournament's price
 * has moved, that one item is refused ("The Ticket Price Changed, Review It
 * And Send Again") and nothing is charged. The holder uses the ticket by
 * pressing Register on that tournament; the existing ticket finder offers it.
 */
import { supabase } from '../lib/supabase';

/** One row of the Send Ticket drop-down. */
export interface TicketableTournament {
  tournamentId: string;
  name: string;
  startTime: string | null;
  /** 'ANNOUNCED' | 'REGISTERING' | 'RUNNING' (running only while late registration is open). */
  status: string;
  lateRegistration: boolean;
  /** The exact ticket price the sender is charged: prize + bounty + fee. */
  price: number;
  entryPrize: number;
  entryBounty: number;
  entryFee: number;
  isUnionEvent: boolean;
  currentPlayers: number | null;
  maxPlayers: number | null;
}

/** A p_items entry for fn_cashier_batch_transfer with p_kind = 'ticket'. */
export interface CashierTournamentTicketItem {
  user_id: string;
  tournament_id: string;
  /** The price the cashier saw; the server refuses the item if it differs. */
  amount: number;
  note?: string;
  idempotency_key: string;
}

/** What one batch result (or a single issue) returns for a tournament ticket. */
export interface TournamentTicketIssueResult {
  success: boolean;
  replayed?: boolean;
  ticket_id?: string;
  your_balance?: number | null;
  tournament_id?: string;
  tournament_name?: string;
  start_time?: string | null;
  price?: number;
  entry_prize?: number;
  entry_bounty?: number;
  entry_fee?: number;
  error?: string;
  /** Machine reason on a refusal: price_changed, registration_closed, tournament_full,
   *  already_registered, already_holds_ticket, not_visible_to_club, ... */
  reason?: string;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number.isFinite(num(v)) ? num(v) : null;

/**
 * Every future or running tournament this club's cashier may ticket, soonest
 * first. Throws with the server's own message when the caller may not issue
 * tickets in this club, so the UI never shows an empty list for a refusal.
 */
export async function listTicketableTournaments(clubId: string): Promise<TicketableTournament[]> {
  const { data, error } = await supabase.rpc('fn_cashier_ticketable_tournaments', {
    p_club_id: clubId,
  });
  if (error) throw new Error('Could Not Load Tournaments. Please Try Again.');
  const res = data as { success?: boolean; error?: string; tournaments?: unknown } | null;
  if (!res || res.success !== true || !Array.isArray(res.tournaments)) {
    throw new Error(res?.error || 'Could Not Load Tournaments. Please Try Again.');
  }
  const rows: TicketableTournament[] = [];
  for (const raw of res.tournaments as Array<Record<string, unknown>>) {
    const price = num(raw.price);
    const id = typeof raw.tournament_id === 'string' ? raw.tournament_id : '';
    // A row the client cannot price exactly is never offered.
    if (!id || !Number.isFinite(price) || price <= 0) continue;
    rows.push({
      tournamentId: id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Tournament',
      startTime: typeof raw.start_time === 'string' ? raw.start_time : null,
      status: typeof raw.status === 'string' ? raw.status : '',
      lateRegistration: raw.late_registration === true,
      price,
      entryPrize: num(raw.entry_prize),
      entryBounty: num(raw.entry_bounty),
      entryFee: num(raw.entry_fee),
      isUnionEvent: raw.is_union_event === true,
      currentPlayers: numOrNull(raw.current_players),
      maxPlayers: numOrNull(raw.max_players),
    });
  }
  return rows;
}

/**
 * The retry key for one recipient's ticket in one submission. Stable across
 * a retry of the same submission (so an uncertain outcome replays instead of
 * charging twice) and distinct from the plain-ticket key shape.
 */
export function tournamentTicketIdempotencyKey(
  clubId: string,
  submissionId: string,
  userId: string,
  tournamentId: string
): string {
  return `ticket:${clubId}:${submissionId}:${userId}:tournament:${tournamentId}`;
}

/** One fn_cashier_batch_transfer item for a ticket into `tournament`. */
export function buildTournamentTicketItem(args: {
  clubId: string;
  submissionId: string;
  userId: string;
  tournament: Pick<TicketableTournament, 'tournamentId' | 'price'>;
  note?: string | null;
}): CashierTournamentTicketItem {
  const item: CashierTournamentTicketItem = {
    user_id: args.userId,
    tournament_id: args.tournament.tournamentId,
    amount: args.tournament.price,
    idempotency_key: tournamentTicketIdempotencyKey(
      args.clubId,
      args.submissionId,
      args.userId,
      args.tournament.tournamentId
    ),
  };
  const note = args.note?.trim();
  if (note) item.note = note;
  return item;
}

/** A single ticket outside a batch. The result is the server's, unchanged. */
export async function issueTournamentEntryTicket(args: {
  clubId: string;
  holderId: string;
  tournament: Pick<TicketableTournament, 'tournamentId' | 'price'>;
  idempotencyKey: string;
  note?: string | null;
}): Promise<TournamentTicketIssueResult> {
  const { data, error } = await supabase.rpc('fn_issue_tournament_entry_ticket', {
    p_club_id: args.clubId,
    p_holder_id: args.holderId,
    p_tournament_id: args.tournament.tournamentId,
    p_note: args.note?.trim() || null,
    p_idempotency_key: args.idempotencyKey,
    p_expected_price: args.tournament.price,
  });
  if (error) {
    // The outcome is unknown, not refused: retry with the SAME key.
    throw new Error('Could Not Confirm The Ticket. Retry To Check, You Will Not Be Charged Twice.');
  }
  const res = data as TournamentTicketIssueResult | null;
  if (!res || typeof res.success !== 'boolean') {
    throw new Error('Could Not Confirm The Ticket. Retry To Check, You Will Not Be Charged Twice.');
  }
  return res;
}
