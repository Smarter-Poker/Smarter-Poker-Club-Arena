/**
 * THE LEDGER REPLAY KNOWS WHICH LEGS ITS SNAPSHOT SAW (2026-10-04).
 *
 * pg_visible_in_snapshot judges a SUBTRANSACTION xid of a still-running
 * transaction as visible (a pg_snapshot lists only top-level xids), so a leg
 * written inside a plpgsql EXCEPTION block while the previous reading was
 * taken fell out of both replay windows: +190.00 on one player, +10.00 on
 * Midway's rake treasury and the +/-6.21 promo pair, all from the reading of
 * 2026-10-01 06:47. Migration 20261004135607 records the legs each reading saw
 * and lets the window readers trust visibility only below the snapshot's xmin
 * or for a leg that reading recorded.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const M = fs.readFileSync(
  path.join(MIGRATIONS, '20261004135607_the_ledger_replay_knows_which_legs_its_snapshot_saw.sql'),
  'utf8'
);

describe('the ledger replay knows which legs its snapshot saw', () => {
  it('creates the readings table without client access', () => {
    expect(M).toContain('CREATE TABLE public.ca_ledger_replay_readings');
    expect(M).toContain('committed_legs uuid[] NOT NULL');
    expect(M).toContain('REVOKE ALL ON public.ca_ledger_replay_readings FROM PUBLIC, anon, authenticated');
  });

  it('both window readers trust visibility only below xmin or for a recorded leg', () => {
    expect(M).toContain('AND (public.fn_ca_xid8(l.xmin) < pg_snapshot_xmin(p_prev_snapshot)');
    expect(M).toContain('OR NOT EXISTS (SELECT 1 FROM public.ca_ledger_replay_readings rr');
    expect(M).toContain('OR l.id = ANY (SELECT unnest(rr.committed_legs) FROM public.ca_ledger_replay_readings rr');
    expect(M).toContain("'public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure");
    expect(M).toContain("'public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure");
    expect(M.match(/anchor count'; END IF;/g)?.length).toBe(3);
  });

  it('the replay records what its own snapshot saw, only under repeatable read', () => {
    expect(M).toContain("IF current_setting('transaction_isolation') = 'repeatable read' THEN");
    expect(M).toContain('SELECT pg_current_snapshot()::text, clock_timestamp(), COALESCE(array_agg(l.id ORDER BY l.id)');
    expect(M).toContain('AND public.fn_ca_xid8(l.xmin) >= pg_snapshot_xmin(pg_current_snapshot())');
  });

  it('pins all three preimages and checks every postimage', () => {
    for (const md5 of [
      'ec36a30011e62e266e3385ef407fe064',
      '2994dc949e5ed22c3f8f0ef832652cb8',
      '8bd897bd17bde110e610ef3d3564f25e',
    ])
      expect(M).toContain(`'${md5}'`);
    expect(M.match(/postimage differs from the substituted text/g)?.length).toBe(3);
  });
});
