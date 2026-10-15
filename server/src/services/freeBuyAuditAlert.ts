/**
 * THE FREE BUY WATCH CLOSES ITS OWN ALERT (2026-10-15).
 *
 * TournamentRecurringService.auditFreeBuyBoardOnce raises
 * `TournamentRecurring.freeBuyAudit` (financial_alerts, entity free_buy_board)
 * when the board is wrong, and until this change nothing ever resolved it:
 * a clean audit only logged "all correct now", and only when the in-memory
 * problem count of the same process had been above zero. So every episode
 * stayed open for ever after the board was right again:
 *
 *   - 112bf723 (raised 2026-09-11) stayed open 24 days until a migration
 *     closed it by hand (20261005113407);
 *   - f2c43ab2 (raised 2026-10-13 18:01, "Midway Union published no Midday
 *     Free Buy", the scoped launch floor park) was still open on 2026-10-15
 *     although the board had been publishing every slot again since
 *     2026-10-14 23:06.
 *
 * The watch is the only writer of this source, so it is the one that knows
 * the condition has cleared. Every clean audit closes whatever row of this
 * source is still open, read from the database rather than from process
 * memory, so an engine restart between the raise and the clean read cannot
 * strand it. An unreadable board never reaches here (the caller returns on a
 * read error): an unreadable board is not a correct board.
 */

export const FREE_BUY_AUDIT_SOURCE = 'TournamentRecurring.freeBuyAudit';

/**
 * The slice of the Supabase client this module uses. Typed loosely on purpose:
 * the real client's generic builder signatures are not assignable to a
 * hand-written structural copy, and the test passes a recording fake.
 */
export interface FreeBuyAlertStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: 'financial_alerts'): any;
}

export function freeBuyAuditClearedResolution(checked: number, atIso: string): string {
  return (
    `Cleared by the Free Buy board audit at ${atIso}: ${checked} board event(s) read, ` +
    'every slot published and every event to specification.'
  );
}

/**
 * Resolve every open `TournamentRecurring.freeBuyAudit` row. Returns how many
 * rows it closed. Throws on a database error so the caller reports it.
 */
export async function closeFreeBuyBoardAlert(
  db: FreeBuyAlertStore,
  checked: number,
  nowMs: number
): Promise<number> {
  const at = new Date(nowMs).toISOString();
  const { data, error } = (await db
    .from('financial_alerts')
    .update({
      resolved: true,
      resolved_at: at,
      resolution: freeBuyAuditClearedResolution(checked, at),
    })
    .eq('source', FREE_BUY_AUDIT_SOURCE)
    .eq('resolved', false)
    .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };
  if (error) throw new Error(`free_buy_audit_close_failed: ${error.message}`);
  return (data ?? []).length;
}
