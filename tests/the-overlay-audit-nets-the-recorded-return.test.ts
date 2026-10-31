import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The overlay audit reported GROSS guarantee funding. The live path already
 * returns an overlay the field outgrew (chip_ledger reversal "Guarantee
 * overlay excess returned to its source"), so the Nightly 10K of 2026-10-30
 * was raised as a critical 4,172.50 cost that had been returned in full 88
 * minutes after it was funded. Measured on production: 10-28 gross 8,901.60
 * net 0.00; 10-29 gross 29,270.50 net 1,262.00; 10-30 gross 4,172.50 net 0.00.
 */
const ROOT = path.resolve(__dirname, '..');
const FILE = 'supabase/migrations/20261031200545_overlay_audit_nets_the_recorded_return.sql';
const MIGRATION = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

describe('the overlay audit nets the recorded return', () => {
  it('subtracts the live path return from the recorded funding', () => {
    expect(MIGRATION).toContain("l.category='reversal'");
    expect(MIGRATION).toContain("l.from_type='prize_liability'");
    expect(MIGRATION).toContain("l.description LIKE 'Guarantee overlay excess returned%'");
    expect(MIGRATION).toContain('greatest(greatest(journal,legacy,0)-returned,0) net_funding');
  });

  it('is critical only for a net cost, and info for a fully returned overlay', () => {
    expect(MIGRATION).toContain("CASE WHEN r.net_funding>=200 THEN 'critical'");
    expect(MIGRATION).toContain("WHEN r.funding>0 THEN 'tournament_overlay_returned'");
  });

  it('estimates the gap from the prize pool too, so rebuys and add-ons count', () => {
    expect(MIGRATION).toContain('greatest(gtd-greatest(entries*bi,pool),0) entry_only_gap');
  });

  it('replaces only the body it was written against, in one transaction', () => {
    expect(MIGRATION).toContain("IS DISTINCT FROM '791e3e3a1c4297d7a8655634afe41325'");
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_audit_overlays(date) TO service_role;'
    );
  });
});
