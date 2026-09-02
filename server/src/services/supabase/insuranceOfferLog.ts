/**
 * INSURANCE OBSERVABILITY 2026-08-28 — the decision funnel, durable.
 *
 * `insurance_transactions` records only settled money. Before this log there
 * was no way to ask "how many offers were shown, and what did players do with
 * them?" — the funnel had no denominator, so nobody could tell whether the
 * repriced fee-on-win rates still felt buyable.
 *
 * One row per event: offered / accepted / declined / timeout / cashed_out /
 * settled, written fire-and-forget. A failed insert is reported and dropped —
 * observability must NEVER touch gameplay, so there are no retries, no awaits
 * on the hot path, and no throws out of this module.
 *
 * Queryable through the `v_insurance_activity` view (per club, per day).
 */
import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

export interface InsuranceOfferEventRow {
  tableId: string;
  clubId: string | null;
  handNumber: number;
  playerId: string;
  event: 'offered' | 'accepted' | 'declined' | 'timeout' | 'cashed_out' | 'settled';
  equityPercent: number | null;
  premium: number | null;
  insuredAmount: number | null;
  pot: number | null;
  street: string | null;
}

export function logInsuranceOfferEvent(row: InsuranceOfferEventRow): void {
  // Fire-and-forget by design; the void swallows the promise on purpose.
  void (async () => {
    try {
      const { error } = await supabase.from('insurance_offer_events').insert({
        table_id: row.tableId,
        club_id: row.clubId,
        hand_number: row.handNumber,
        player_id: row.playerId || null,
        event: row.event,
        equity_percent: row.equityPercent,
        premium: row.premium,
        insured_amount: row.insuredAmount,
        pot: row.pot,
        street: row.street,
      });
      if (error) {
        // Once, quietly — a schema mismatch would otherwise spam every offer.
        reportError(error, 'insuranceOfferLog.insert_failed');
      }
    } catch (err) {
      reportError(err, 'insuranceOfferLog.threw');
    }
  })();
}
