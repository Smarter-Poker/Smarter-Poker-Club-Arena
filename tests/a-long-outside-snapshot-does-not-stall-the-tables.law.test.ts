/**
 * LAW: A LONG OUTSIDE SNAPSHOT DOES NOT STALL THE TABLES (2026-10-06).
 *
 * 06:09-06:19 UTC on 2026-10-06 every tournament table jammed. The cause was
 * not late registration closing: a full data export logged in as `postgres`
 * ("club-arena-isolated-recovery-01a10ca0", pid 1953237) held one snapshot
 * from 05:46:46 to 06:19:13. With the xmin horizon pinned, hand settlement's
 * reads of tournament_players / table_seats / the owning clubs row walked
 * ever-longer version chains: 1,010 of 1,069 statement timeouts were inside
 * settlement with zero lock waits inside it, the tournament lanes queued
 * behind those slow shared holders, and commit latency fell from 8.8 s back
 * to 132 ms the minute the export was cancelled. The same two events closed
 * late registration on 10-04 and 10-05 with no jam.
 *
 * public.fn_ca_bound_outside_snapshots, run every minute, cancels (or, when
 * idle in transaction, terminates) a non-superuser postgres-member or
 * supabase_read_only_user session holding a snapshot past five minutes,
 * sparing pg_cron and the migration appliers, and logs each action.
 *
 * What this pins: the filter's every clause (a plausible edit that drops one
 * either kills pg_cron's weekly close or lets the export through again), the
 * default bound and its range, cancel-versus-terminate, the log, privileges,
 * the schedule and its periodic-work justification, the policy gate, and the
 * disposable-cluster proof.
 * scripts/ci/test-a-long-outside-snapshot-does-not-stall-the-tables.py
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'supabase/migrations');
const FILE = readdirSync(DIR).filter((f) =>
  f.endsWith('_a_long_outside_snapshot_does_not_stall_the_tables.sql')
);
const MIG = FILE.length === 1 ? readFileSync(resolve(DIR, FILE[0]), 'utf8') : '';

/** The SQL with -- comments and block comments removed, so prose cannot satisfy a code assertion. */
const CODE = MIG.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

function functionBody(): string {
  const start = CODE.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_bound_outside_snapshots(');
  expect(start).toBeGreaterThan(-1);
  const open = CODE.indexOf('$function$', start);
  return CODE.slice(open, CODE.indexOf('$function$;', open));
}

describe('a long outside snapshot does not stall the tables', () => {
  it('ships exactly one migration under a reserved version', () => {
    expect(FILE).toHaveLength(1);
    expect(FILE[0]).toMatch(/^\d{14}_a_long_outside_snapshot_does_not_stall_the_tables\.sql$/);
    expect(MIG).toContain('Version reserved by scripts/new-migration.mjs');
  });

  it('bounds only outside sessions that hold a snapshot past the bound', () => {
    const b = functionBody();
    for (const clause of [
      "a.backend_type = 'client backend'",
      'a.pid <> pg_backend_pid()',
      'a.xact_start < clock_timestamp() - p_max_age',
      '(a.backend_xmin IS NOT NULL OR a.backend_xid IS NOT NULL)',
      'NOT ro.rolsuper',
      "(pg_has_role(ro.oid, 'postgres', 'MEMBER') OR ro.rolname = 'supabase_read_only_user')",
    ]) {
      expect(b, clause).toContain(clause);
    }
  });

  it('spares pg_cron and every migration applier by name', () => {
    const b = functionBody();
    expect(b).toContain("NOT IN ('pg_cron', 'mgmt-api', 'apply-recorded-migration')");
    expect(b).toContain("NOT LIKE 'antigravity-sql-push:%'");
    // The exemption is by name only. A role-wide exemption for postgres
    // would let the export through again: it logged in as postgres.
    expect(b).not.toMatch(/usename\s*<>\s*'postgres'/);
    expect(b).not.toMatch(/rolname\s*<>\s*'postgres'/);
  });

  it('cancels a running holder and terminates only an idle-in-transaction one', () => {
    const b = functionBody();
    expect(b).toContain(
      "CASE WHEN r.state LIKE 'idle in transaction%' THEN 'terminate' ELSE 'cancel' END"
    );
    expect(b).toContain("CASE WHEN v_action = 'terminate' THEN pg_terminate_backend(r.pid)");
    expect(b).toContain('ELSE pg_cancel_backend(r.pid) END');
    expect(b.match(/pg_terminate_backend\(/g)).toHaveLength(1);
  });

  it('defaults to five minutes and refuses a bound outside one second to thirty minutes', () => {
    expect(CODE).toContain(
      "fn_ca_bound_outside_snapshots(p_max_age interval DEFAULT interval '5 minutes')"
    );
    const b = functionBody();
    expect(b).toContain(
      "p_max_age IS NULL OR p_max_age < interval '1 second' OR p_max_age > interval '30 minutes'"
    );
    expect(b).toContain('CA_SNAPSHOT_BOUND_OUT_OF_RANGE');
  });

  it('records every action and says so in the server log', () => {
    const b = functionBody();
    expect(b).toContain('INSERT INTO smarter_private.ca_long_snapshot_cancellations');
    expect(b).toContain('CA_OUTSIDE_SNAPSHOT_BOUNDED');
    // A scan log on a hot relation gets no foreign key (CLAUDE.md DDL rule 7).
    const table = CODE.slice(
      CODE.indexOf('CREATE TABLE IF NOT EXISTS smarter_private.ca_long_snapshot_cancellations'),
      CODE.indexOf(
        ');',
        CODE.indexOf('CREATE TABLE IF NOT EXISTS smarter_private.ca_long_snapshot_cancellations')
      )
    );
    expect(table).not.toMatch(/REFERENCES/i);
  });

  it('is closed to every API role', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_bound_outside_snapshots(interval) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(CODE).toContain(
      'REVOKE ALL ON TABLE smarter_private.ca_long_snapshot_cancellations FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(functionBody()).not.toMatch(/SECURITY DEFINER/);
    expect(CODE.slice(0, CODE.indexOf('$function$'))).not.toMatch(/SECURITY DEFINER/);
  });

  it('runs every minute, once, with its reason and the policy gate written down', () => {
    expect(CODE).toMatch(/cron\.schedule\(\s*'ca-bound-outside-snapshots-1m',\s*'\* \* \* \* \*',/);
    expect(CODE).toContain("pg_try_advisory_lock(hashtext('ca-bound-outside-snapshots-1m'))");
    expect(MIG).toMatch(/^[ \t]*--[ \t]*periodic-work:[ \t]*\S/m);
    expect(MIG).toContain('POLICY GATE');
    expect(MIG).toContain(
      "@live-proof: (SELECT count(*) = 1 FROM cron.job WHERE jobname = 'ca-bound-outside-snapshots-1m'"
    );
  });

  it('is one transaction with bounded lock admission', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toContain("SET LOCAL lock_timeout = '2s';");
    // No money moves and no hot table is touched.
    for (const hot of [
      'tournament_players',
      'table_seats',
      'public.tournaments',
      'public.clubs',
      'chip_ledger',
    ]) {
      expect(CODE, hot).not.toContain(hot);
    }
  });

  it('ships the disposable-cluster proof', () => {
    expect(
      existsSync(
        resolve(
          process.cwd(),
          'scripts/ci/test-a-long-outside-snapshot-does-not-stall-the-tables.py'
        )
      )
    ).toBe(true);
  });
});
