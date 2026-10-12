/**
 * LAW: THE UNION SWEEP ONLY REBUILDS A BOUNDED SNAPSHOT (2026-10-03).
 *
 * fn_union_integrity_sweep_all rebuilt union_rake_basis_snapshot for the open
 * week after its money controls, in one read linear in the week. From
 * 2026-09-29 that read no longer finished inside job 123's 300 s, so every
 * hourly run was cancelled in it and kept the 2026-09-28 snapshot.
 * 20261003225101 took the rebuild out of the sweep. Thirty minutes later the
 * accounting coordinator's 20261003224956 made the rebuild incremental
 * (fn_union_rake_basis_windowed: two-hour windows, closed ones reused, nothing
 * started past 120 s / 180 s), and 20261003235228 puts the call back, refusing
 * to apply unless the refresh in force is the windowed one.
 *
 * What this pins: the sweep in force runs every money control; if it calls the
 * refresh, it calls it after every control, and the windowed refresh exists in
 * the migration chain; the restoration refuses a one-read refresh; neither
 * change adds a schedule.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring, migrationFiles, readMigration } from './helpers/migrations';

const REMOVED = '20261003225101_the_union_sweep_stops_rebuilding_an_unread_snapshot.sql';
const RESTORED = '20261003235228_the_union_sweep_refreshes_the_windowed_snapshot_again.sql';
const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8');

describe('the union sweep only rebuilds a bounded snapshot', () => {
  it('the sweep in force runs every money control, and the refresh only after them', () => {
    const { name, sql } = latestDeclaring('fn_union_integrity_sweep_all');
    expect(name).toBe(RESTORED);
    const body = functionBody(sql, 'fn_union_integrity_sweep_all');
    const controls = [
      'public.fn_union_integrity_sweep(u.id, p_hours)',
      'public.fn_union_age_invoices(u.id)',
      'public.fn_union_enforce_stop_loss(u.id)',
      'public.expire_settlement_locks()',
      'public.fn_settlement_lock_hygiene()',
      'public.fn_close_due_settlement_periods()',
    ].map((c) => body.indexOf(c));
    for (const at of controls) expect(at).toBeGreaterThan(-1);
    const refresh = body.indexOf('public.fn_union_rake_basis_refresh(u.id');
    if (refresh > -1) for (const at of controls) expect(refresh).toBeGreaterThan(at);
  });

  it('a refresh in the sweep is the windowed one', () => {
    const windowed = migrationFiles().filter((f) => {
      const sql = readMigration(f);
      return sql.includes('CREATE FUNCTION public.fn_union_rake_basis_windowed(') && f < RESTORED;
    });
    expect(windowed.length).toBeGreaterThan(0);
    const mig = read(RESTORED);
    expect(mig).toContain(
      "IF position('fn_union_rake_basis_windowed' IN pg_get_functiondef('public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure)) = 0 THEN"
    );
    expect(mig).toContain("IS DISTINCT FROM '6000297c65bca53935705fbd6b8fd5d8'");
    expect(mig).toContain("IS DISTINCT FROM '729a5617801d0038b1fa3c10f488c0bb'");
  });

  it('neither change adds a schedule, and each is one pinned transaction', () => {
    for (const f of [REMOVED, RESTORED]) {
      const mig = read(f);
      expect(mig.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(mig.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(mig).not.toMatch(/cron\.schedule/);
      expect(mig).toContain(
        'REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM PUBLIC, anon, authenticated;'
      );
    }
  });
});
