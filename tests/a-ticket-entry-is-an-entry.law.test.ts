/**
 * A TICKET ENTRY IS AN ENTRY (2026-09-10).
 *
 * A tournament-entry ticket redeemed through
 * fn_ca_register_for_tournament_with_ticket_for moves its value
 * escrow -> prize_liability (category ticket_redeem), debits no wallet, and
 * writes a `tournament_ticket_entry` receipt. Two readers did not know that
 * shape existed and both filed the same correct entry as drift:
 *
 *   - fn_ca_tournament_escrow, the escrow SHADOW, built gross_in from wallet
 *     debits and satellite pool transfers only, so it read 320.00 against a
 *     maintained escrow of 340.00 and fn_ca_escrow_balance_drift raised the
 *     20.00 gap (incident 1dee2671, Deep Stack Society d04da598).
 *   - fn_ca_settlement_correctness_check section F demanded a
 *     `tournament_ticket_redeem` receipt - the CASH redemption door's receipt -
 *     for every redeemed ticket, so an entry-only ticket read as "0 receipts"
 *     (incident 60d2d03e).
 *
 * Both are detector defects. No chips moved wrongly, and the fix is that both
 * readers now recognise the entry door's shape.
 *
 * docs/changelog/2026-09-10-a-ticket-entry-is-an-entry.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const sorted = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const migrationNamed = (slug: string): string => {
  const hit = sorted().filter((f) => f.endsWith(`_${slug}.sql`));
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const TICKET = migrationNamed('a_ticket_entry_is_an_entry');

describe('a ticket entry is an entry', () => {
  it('the escrow shadow counts an entry ticket redemption as money in', () => {
    expect(TICKET).toContain("category=''ticket_redeem''");
    expect(TICKET).toContain("to_type=''prize_liability''");
    expect(TICKET).toContain("from_type=''escrow''");
    // and it is actually added to gross_in, not merely selected
    expect(TICKET).toContain('tk.ticket_in');
  });

  it('the correctness check accepts either redemption receipt for a redeemed ticket', () => {
    expect(TICKET).toContain("ARRAY[''tournament_ticket_redeem'',''tournament_ticket_entry'']");
    // the cancel branch is unchanged: a cancelled ticket still has exactly one
    // tournament_ticket_cancel receipt
    expect(TICKET).toContain("ELSE ARRAY[''tournament_ticket_cancel'']");
  });

  it('every substitution is asserted against its anchor count before it is made', () => {
    expect(TICKET).toContain("RAISE EXCEPTION 'escrow anchor 1 appears % times, expected 1'");
    expect(TICKET).toContain("RAISE EXCEPTION 'escrow anchor 2 appears % times, expected 1'");
    expect(TICKET).toContain("RAISE EXCEPTION 'escrow anchor 3 appears % times, expected 1'");
    expect(TICKET).toContain('expected 2 (count and sum)');
  });

  it('the migration proves the shadow agrees with the maintained escrow before committing', () => {
    expect(TICKET).toContain('post-condition: shadow');
    expect(TICKET).toContain('still disagrees with the escrow');
    // and that the flagged ticket has exactly one receipt of its value
    expect(TICKET).toContain('expected 1 of 20.00');
  });

  it('both incidents are resolved with the cause, not merely closed', () => {
    const resolved = TICKET.match(/SET status = 'resolved'/g);
    expect(resolved?.length, 'both incidents resolved by this migration').toBe(2);
    expect(TICKET).toContain("correction_ref = 'migration a_ticket_entry_is_an_entry'");
    expect(TICKET).toContain('expected to resolve 1 escrow drift incident');
    expect(TICKET).toContain('expected to resolve 1 ticket_value incident');
  });
});
