/**
 * THE CONSERVATION READ DOES NOT GROW WITH HISTORY (issue #7309, 2026-10-17).
 *
 * Dan, 2026-10-17: "HARD CODE FIX THIS AT ITS ROOT CAUSE, THEN HARDEN IT AFTER
 * YOU FIX IT TO PREVENT IT FROM BREAKING OR REGRESSING AGAIN."
 *
 * Reconcile Now returned HTTP 500 (statement timeout, 8 s for authenticated)
 * because fn_cashier_conservation_report re-added every chip_ledger
 * player-wallet leg since the club baseline on every call: 1,069,678 legs for
 * Club JAQK, 4.5 s cold, and growing by ~180k a day. Eight earlier migrations
 * each made that same full read cheaper and none stopped it growing.
 *
 * 20261017184739 seals finished UTC days into per-member totals, valid only
 * while they carry the day's manifest hash, and the report reads raw only the
 * cutoff's own day and the unsealed tail. This pins the shape that keeps it
 * bounded and exact, so the next "optimisation" cannot quietly put the
 * unbounded read back.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const dir = resolve(ROOT, 'supabase/migrations');
const migrations = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(resolve(dir, f), 'utf8');

// The newest definition of the report is the one production runs.
const latest = migrations
  .filter((f) =>
    read(f).includes('CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report')
  )
  .at(-1)!;
const migration = read(latest);
const declaration = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report')
);
const delimiter = declaration.match(/\bAS\s+(\$[a-zA-Z_][a-zA-Z_0-9]*\$|\$\$)/)?.[1];
if (!delimiter) throw new Error('Missing conservation function body delimiter');
const bodyStart = declaration.indexOf(delimiter) + delimiter.length;
const bodyEnd = declaration.indexOf(`${delimiter};`, bodyStart);
if (bodyEnd < bodyStart) throw new Error('Unterminated conservation function body');
const report = declaration.slice(0, bodyEnd + delimiter.length + 1);
const sealer = (() => {
  const all = migrations
    .map(read)
    .filter((s) => s.includes('FUNCTION public.fn_ca_chip_wallet_day_seal('));
  const s = all.at(-1)!;
  return s.slice(s.indexOf('FUNCTION public.fn_ca_chip_wallet_day_seal('), s.indexOf('$seal$;'));
})();
const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('the cashier conservation read does not grow with history', () => {
  it('is the sealed-day read or a later one that keeps it', () => {
    expect(latest >= '20261017184739').toBe(true);
    expect(report).toContain('public.ca_chip_wallet_day_totals');
    expect(report).toContain('public.ca_chip_wallet_day_seals');
  });

  it('reads the journal only through ranges bounded on BOTH sides', () => {
    // Every chip_ledger read in the legs of the report carries an upper bound,
    // so a sealed day can never be re-read raw.
    const legs = report.slice(
      report.indexOf('legs AS MATERIALIZED'),
      report.indexOf('moves AS MATERIALIZED')
    );
    expect(legs.match(/FROM public\.chip_ledger l/g)).toHaveLength(1);
    expect(legs).toContain('l.created_at>=r.lo AND l.created_at<r.hi');
    expect(legs).not.toMatch(/l\.created_at\s*>=\s*c\.taken_at/);
    expect(report).toContain("'infinity'::timestamptz");
  });

  it('uses a sealed day only while it carries the day manifest hash', () => {
    expect(report).toContain('s.manifest_sha256 IS NOT DISTINCT FROM m.sha256');
    expect(report).toContain('LEFT JOIN public.ca_ledger_day_manifests m ON m.day=s.day');
    // The sealed run starts the day AFTER the cutoff's own day, which is raw.
    expect(report).toContain("(c.taken_at AT TIME ZONE 'UTC')::date + 1 AS first_day");
    expect(report).toContain('t.day>=s.first_day AND t.day<s.open_from');
  });

  it('collapses sealed totals to one row per member before the join', () => {
    expect(report).toMatch(
      /SELECT s\.taken_at, t\.user_id, sum\(t\.net\)[\s\S]*GROUP BY s\.taken_at, t\.user_id/
    );
  });

  it('keeps the report read-only and caller-scoped', () => {
    expect(report).toMatch(/RETURNS\s+jsonb\s+LANGUAGE\s+plpgsql\s+STABLE\s+SECURITY\s+DEFINER/);
    expect(report).toContain("RAISE EXCEPTION 'Active Club Finance Access Required'");
    expect(report).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM)?\s*public\./i);
  });

  it('seals only finished, attested days that no open transaction can still reach', () => {
    expect(sealer).toContain("pg_try_advisory_xact_lock(hashtext('fn_ca_chip_wallet_day_seal'))");
    expect(sealer).toContain("a.backend_type = 'client backend'");
    expect(sealer).toContain('a.xact_start < v_end');
    expect(sealer).toContain('pg_prepared_xacts');
    expect(sealer).toContain('v_rows <> v_manifest_rows');
    expect(sealer).toContain('(v_today - 1)::timestamp');
    // A changed manifest withdraws the seal; a re-count catches a late row.
    expect(sealer).toContain('WHERE s.manifest_sha256 IS DISTINCT FROM m.sha256');
    expect(sealer).toContain("s.checked_at < now() - interval '20 hours'");
  });

  it('writes only its own derived tables, never money', () => {
    const writes = [
      ...sealer.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.(\w+)/g),
    ].map((m) => m[1]);
    expect(new Set(writes)).toEqual(
      new Set(['ca_chip_wallet_day_seals', 'ca_chip_wallet_day_totals'])
    );
    expect(sealer).not.toMatch(/is_horse/);
  });

  it('is scheduled with its reason written down, and qualified on every server change', () => {
    const m = read('20261017184739_cashier_conservation_reads_sealed_wallet_days.sql');
    expect(m).toMatch(/^-- periodic-work: \S/m);
    expect(m).toContain(
      "SELECT cron.schedule('ca-chip-wallet-day-seal', '30 * * * *', 'SELECT public.fn_ca_chip_wallet_day_seal()');"
    );
    expect(ci).toContain('python3 scripts/ci/test-cashier-conservation-sealed-days-postgres.py');
  });
});
