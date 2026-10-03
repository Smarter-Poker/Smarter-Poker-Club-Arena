/**
 * A COHORT SATELLITE TICKET IS REDEEMABLE (2026-10-03).
 *
 * The v3 multi-qualifier satellite receipt books a capped winner's award slot
 * as chip_ledger.metadata->>'award_slot' and leaves tournament_payouts.position
 * NULL. The ticket door and its selector proved the slot only through the v2
 * shape (metadata 'position', payout position), so no v3 ticket was ever
 * redeemed: 0 of 393 on 2026-10-03, while v2 tickets were redeemed 144 times.
 *
 * docs/changelog/2026-10-03-a-cohort-satellite-ticket-is-redeemable.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const hit = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_a_cohort_satellite_ticket_is_redeemable.sql'));
const SQL = hit.length === 1 ? fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8') : '';

describe('a cohort satellite ticket is redeemable', () => {
  it('has exactly one migration', () => {
    expect(hit).toHaveLength(1);
  });

  it('rewrites both proof doors, not only the selector', () => {
    expect(SQL).toContain('public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)');
    expect(SQL).toContain('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)');
  });

  it('accepts the v3 award_slot while keeping the v2 position proof', () => {
    expect(SQL).toContain(
      `COALESCE(issue_l.metadata->>'position',issue_l.metadata->>'award_slot')=source_a.place::text`
    );
    expect(SQL).toContain(`(source_p."position"=source_a.place OR source_h.receipt_version>=3)`);
  });

  it('aborts unless each substitution matches exactly once', () => {
    expect(SQL).toMatch(/<> 1/);
    expect(SQL).toContain('does not carry exactly one v2-only slot proof');
  });

  it('moves no money itself', () => {
    expect(SQL).not.toMatch(/INSERT\s+INTO\s+public\.chip_ledger/i);
    expect(SQL).not.toMatch(/UPDATE\s+public\.(club_members|tournament_tickets)/i);
  });
});
