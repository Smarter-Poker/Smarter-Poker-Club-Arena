/**
 * A SATELLITE SEAT FEE READS ITS CHARGE ON THE SATELLITE (2026-10-19).
 *
 * Pinned on migration 20261019220457_a_satellite_seat_fee_reads_its_charge_on_the_satellite.sql.
 * A satellite seat is paid from the satellite's prize liability, so its charge
 * ledger row names the satellite, not the target event. The owner-direct fee
 * recapture required the event's own id and left one decided tournament unpaid.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261019220457_a_satellite_seat_fee_reads_its_charge_on_the_satellite.sql'
  ),
  'utf8'
);

describe('a satellite seat fee reads its charge on the satellite', () => {
  it('is one transaction with a live proof and a pinned preimage', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("'5ba3e7c498a79fd41e403a6d83fb6bc7'");
  });

  it('reads the satellite only for a satellite seat and the event for every other charge', () => {
    expect(sql).toContain(
      "(CASE WHEN e.entitlement_kind='satellite_seat' THEN e.source_satellite_id ELSE r.tournament_id END)"
    );
  });

  it('writes no wallet and reads no horse flag', () => {
    const body = sql.slice(sql.indexOf('BEGIN;'));
    expect(body).not.toMatch(/is_horse|chip_balance|wallet_transactions/);
  });
});
