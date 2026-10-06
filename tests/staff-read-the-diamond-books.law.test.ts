/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - STAFF READ THE DIAMOND BOOKS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 4, item 8 of the build list:
 * the staff surface. Platform staff read the Diamond adjustments queue with
 * its receipts, the health report and the books through one read,
 * fn_ca_diamond_staff_books, that asks fn_is_platform_admin() before anything
 * else, refuses every other caller by name, is never anonymous and writes
 * nothing.
 *
 * The health report outlasts a signed-in request (8 second statement timeout;
 * it read in 4 to 19 seconds), so staff never run it: the hourly watch keeps
 * the whole reading it already takes, in ca_diamond_health_reading, and the
 * read returns that reading with its time. The watch changes only by asserted
 * substitution, and a reading it cannot keep is a warning, never a failed
 * watch. The report itself is not touched.
 *
 * The page is behind PlatformStaffGuard and the Financial Admin Hub shows its
 * link to platform staff only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween, sliceSqlStatement } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_staff_read_the_diamond_books.sql'))
  .at(-1);
if (!NAME) throw new Error('the staff read migration is missing');
const MIG = migrationText(NAME);
const ROOT = resolve(__dirname, '..');
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const code = (s: string) => s.replace(/--[^\n]*/g, ' ');
const WATCH = sliceBetween(
  MIG,
  '-- 1. THE HOURLY WATCH KEEPS ITS READING',
  '-- 2. ONE STAFF READ OF THE DIAMOND BOOKS'
);
const READ = sliceBetween(
  MIG,
  '-- 2. ONE STAFF READ OF THE DIAMOND BOOKS',
  '-- 3. THE ESTATE IS AS IT WAS'
);
const FINAL = code(sliceBetween(MIG, '-- 3. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));
const DOOR = sliceSqlStatement(READ, 'CREATE FUNCTION public.fn_ca_diamond_staff_books(');
const BODY = DOOR.slice(DOOR.indexOf('AS $function$'));

describe('LAW: staff read the Diamond books', () => {
  it('creates one read and one table, and changes no function but the watch', () => {
    const created = [...MIG.matchAll(/^CREATE (OR REPLACE )?FUNCTION public\.(\w+)\(/gm)];
    expect(created.map((m) => m[2])).toEqual(['fn_ca_diamond_staff_books']);
    expect(code(MIG)).toContain('CREATE TABLE public.ca_diamond_health_reading (');
    expect(code(MIG)).not.toMatch(/\bDROP\b|ALTER FUNCTION|CREATE POLICY/i);
    expect(code(MIG)).not.toMatch(/(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
    expect(code(MIG)).not.toMatch(/INSERT INTO public\.ca_diamond_correction_source/);
    // the health report itself is only read, never redefined
    expect(code(MIG)).not.toMatch(
      /regprocedure[^;]*\n?[^;]*EXECUTE[\s\S]*fn_ca_diamond_health\(\)'::/
    );
    expect(code(MIG).match(/EXECUTE v_new;/g)).toHaveLength(1);
  });

  it('asks for platform staff before anything else, is never anonymous and writes nothing', () => {
    expect(DOOR).toMatch(/STABLE SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    expect(BODY).toMatch(
      /BEGIN\s+IF NOT public\.fn_is_platform_admin\(\) THEN\s+RETURN jsonb_build_object\('ok', false, 'refused_reason', 'platform_staff_only'\);/
    );
    expect(BODY).toContain("'refused_reason', 'unknown_view'");
    for (const view of ['adjustments', 'health', 'books'])
      expect(BODY).toContain(`IF v_view = '${view}' THEN`);
    expect(code(BODY)).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM)\b/);
    expect(READ).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_diamond_staff_books(text) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(READ).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_staff_books(text) TO authenticated, service_role;'
    );
    expect(FINAL).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(FINAL).toContain("p.provolatile = 's'");
  });

  it('shows every Diamond adjustment with its receipt, and what pays for a correction', () => {
    expect(BODY).toContain("WHERE a.asset = 'diamonds'");
    expect(BODY).toContain(
      'FROM public.ca_diamond_adjustment_receipts r WHERE r.adjustment_id = a.id'
    );
    expect(BODY).toContain('FROM public.ca_diamond_correction_source s WHERE s.id = 1');
    expect(BODY).toContain('LIMIT 200');
  });

  it('reads the books live and the health report as the hourly watch last read it', () => {
    expect(BODY).toContain('FROM public.fn_ca_diamond_trial_balance()');
    expect(BODY).toContain('FROM public.fn_ca_diamond_register_vs_supply() r');
    expect(BODY).toContain('FROM public.ca_diamond_health_reading h WHERE h.id = 1');
    expect(code(BODY)).not.toContain('fn_ca_diamond_health()');
  });

  it('keeps the whole reading from the watch, which never fails for it', () => {
    expect(WATCH).toMatch(/id smallint PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/);
    expect(WATCH).toContain(
      'ALTER TABLE public.ca_diamond_health_reading ENABLE ROW LEVEL SECURITY;'
    );
    expect(WATCH).toContain(
      'REVOKE ALL ON TABLE public.ca_diamond_health_reading FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(WATCH).toContain(
      'GRANT SELECT ON TABLE public.ca_diamond_health_reading TO service_role;'
    );
    // asserted substitution: pinned, each old clause exactly once, the reverse reproduces the pin
    expect(WATCH).toContain("c_pin constant text := '8189230a24fa058a634bee6f4130b12c'");
    expect(WATCH).toContain('IF md5(v_def) <> c_pin THEN');
    expect(WATCH.match(/IF v_n <> 1 THEN RAISE EXCEPTION/g)).toHaveLength(2);
    expect(WATCH).toContain(
      'IF md5(replace(replace(v_new, c_new_read, c_old_read), c_new_decl, c_old_decl)) <> c_pin THEN'
    );
    // the kept reading is inside its own block: a failure is a warning, the watch goes on
    expect(WATCH).toMatch(
      /BEGIN\\n'\s*\|\| E'\s+INSERT INTO public\.ca_diamond_health_reading \(id, read_at, areas\) VALUES \(1, now\(\), v_areas\)/
    );
    expect(WATCH).toContain(
      "E'    RAISE WARNING ''fn_ca_diamond_health_watch could not keep its reading: %'', SQLERRM;\\n'"
    );
    expect(FINAL).toContain('the health watch is not as this migration states');
    expect(FINAL).toContain('the health reading is open to a client');
  });

  it('leaves the estate as it was', () => {
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
    expect(FINAL).toContain('a reader this migration only calls has moved');
  });

  it('puts the page behind PlatformStaffGuard and shows its link to staff only', () => {
    const app = src('src/App.tsx');
    expect(app).toMatch(
      /path="diamond-staff-desk"\s+element=\{\s*<AuthGuard>\s*<PlatformStaffGuard>\s*<PageErrorBoundary pageName="Diamond Staff Desk">\s*<DiamondStaffDeskPage \/>/
    );
    const hub = src('src/pages/FinancialAdminHub.tsx');
    expect(hub).toMatch(/path: '\/diamond-staff-desk',[\s\S]*?staffOnly: true,/);
    expect(hub).toMatch(/\(item\.staffOnly && !scope\.isPlatformStaff\)\s*\|\|/);
  });
});
