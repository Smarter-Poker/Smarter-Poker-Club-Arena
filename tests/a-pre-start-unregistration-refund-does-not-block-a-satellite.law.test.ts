/**
 * A PRE-START UNREGISTRATION REFUND DOES NOT BLOCK A SATELLITE'S FINISH (2026-10-03).
 *
 * Satellite 65e8497e could not finish: one settled, fully paid
 * fn_unregister_from_tournament refund in tournament_obligations read as
 * "partial or legacy settlement evidence" and as an extra obligation in the
 * receipt, so the atomic finish was refused and two critical incidents reset
 * the burn-in gate. These assertions pin that only that exact row is admitted.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'supabase/migrations');
const FILE = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('_a_pre_start_unregistration_refund_does_not_block_a_satellite.sql'));
const SQL = fs.readFileSync(path.join(DIR, FILE[0]), 'utf8');
const ADMITTED = "NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'";

describe('a pre-start unregistration refund does not block a satellite', () => {
  it('is exactly one migration, one transaction', () => {
    expect(FILE).toHaveLength(1);
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('admits only a settled, fully paid unregistration refund', () => {
    expect(SQL.split(ADMITTED).length - 1).toBe(2);
    expect(SQL).toContain('o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed');
    expect(SQL).not.toMatch(/o\.kind\s+IN\s*\(/);
    expect(SQL).not.toContain("o.source = 'atomic_cancel_tournament'");
  });

  it('patches both settlement entries and the receipt, each against its preimage', () => {
    for (const fn of [
      'fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
      'fn_ca_settle_satellite_cohort(uuid,uuid[])',
      'fn_ca_satellite_settlement_receipt(uuid,uuid)',
    ]) {
      expect(SQL).toContain(fn);
    }
    for (const md5 of [
      'fe3a0b35548de1bf514e6d81244c7361',
      'ea1a6fcf0205b1b68ffc6192fe979bde',
      'd3618057bb26d64c651344baaac198e8',
    ]) {
      expect(SQL).toContain(md5);
    }
    expect(SQL).toContain('carries the obligation guard % times, expected 1');
    expect(SQL).toContain('the receipt carries the obligation count % times, expected 1');
  });

  it('carries a live proof and changes no pool arithmetic', () => {
    expect(SQL).toMatch(/^-- @live-proof: /m);
    expect(SQL).not.toMatch(/v_pool\s*:=/);
    expect(SQL).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
  });
});
