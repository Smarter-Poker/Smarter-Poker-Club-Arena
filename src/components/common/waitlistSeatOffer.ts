/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SEAT OFFER DECISION, WITHOUT THE OLD ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `table_waitlist` is published, RLS-enabled, and REPLICA IDENTITY FULL. That
 * last part looks like it should make `payload.old` complete, and it does not:
 * Supabase documents that a table with RLS enabled sends only the PRIMARY KEY
 * as the old row, and says plainly there is no way around it while RLS is on.
 * `table_waitlist`'s primary key is `id`, so `old.status` is not there.
 *
 * GlobalWaitlistListener branched on exactly that field:
 *
 *   old.status === 'notified'  gated the thaw re-seed. Never true, so a hold
 *                              whose deadline moved across a maintenance break
 *                              kept counting down to an instant that had passed
 *                              and showed "expired" on a live seat.
 *   old.status !== 'notified'  gated the offer itself. `undefined !== 'notified'`
 *                              is ALWAYS true, so every update that left the row
 *                              notified raised a fresh sixty-second toast.
 *
 * One missing field, two opposite failures. The fix is to stop asking about the
 * previous row and compare against what this client has already shown, which it
 * knows for certain. Pure and exported so both outcomes are testable directly,
 * with the old row present and absent, instead of inferred from a mock socket.
 */

export interface WaitlistOfferRow {
  status?: string | null;
  table_id?: string | number | null;
  notified_at?: string | null;
  hold_expires_at?: string | null;
}

export type SeatOfferDecision =
  /** A hold this client has not shown yet: banner, table name, toast. */
  | { action: 'offer'; tableId: string; deadline: string | null }
  /** Same hold, new deadline (the thaw moved it): re-emit, do NOT toast again. */
  | { action: 'reseed'; tableId: string; deadline: string | null }
  /** The hold ended. Forget it so a genuine later re-offer is not deduped. */
  | { action: 'forget'; tableId: string }
  /** A duplicate, or an event that says nothing about a hold. */
  | { action: 'ignore' };

/**
 * The banner needs the DEADLINE, not a duration: a backgrounded tab or a late
 * mount must show the true remaining time instead of restarting at sixty. Falls
 * back to notified_at + 60s for a row written before hold_expires_at existed.
 */
export function holdDeadline(row: WaitlistOfferRow): string | null {
  if (row.hold_expires_at) return row.hold_expires_at;
  if (row.notified_at) {
    return new Date(new Date(row.notified_at).getTime() + 60_000).toISOString();
  }
  return null;
}

/**
 * @param remembered The deadline this client last showed for the row's table, or
 *                   `undefined` if it has shown none. An empty string is a
 *                   remembered offer that had no deadline, which is not the same
 *                   thing as no offer at all.
 */
export function decideSeatOffer(args: {
  eventType?: string;
  row?: WaitlistOfferRow;
  remembered: string | undefined;
}): SeatOfferDecision {
  const { eventType, row, remembered } = args;
  if (!row || row.table_id === undefined || row.table_id === null || row.table_id === '') {
    return { action: 'ignore' };
  }
  const tableId = String(row.table_id);

  if (row.status !== 'notified') return { action: 'forget', tableId };
  if (eventType !== 'UPDATE') return { action: 'ignore' };

  const deadline = holdDeadline(row);
  const key = deadline ?? '';
  if (remembered === undefined) return { action: 'offer', tableId, deadline };
  if (remembered !== key) return { action: 'reseed', tableId, deadline };
  return { action: 'ignore' };
}
