/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CUTOVER MAY NOT BE ARMED OVER A PERIOD THAT IS ALREADY OPEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the second instance of one bug. On 2026-09-17 a single operation
 * armed two cutovers 1.8 seconds apart. The tournament fee cutover stranded 649
 * live tournaments, which 20260918064540 now prevents. The cash accrual cutover
 * landed 83.4 hours into an open union week, and because
 * fn_accounting_union_earned_plan refuses any period beginning before it, the
 * hourly union sweep's two money controls failed every hour for fourteen hours.
 * The union stop-loss was not enforced for any of that time, and the only trace
 * was two `warning` rows an hour in financial_alerts.
 *
 * The thing worth pinning is not the guard's existence but its shape, because
 * the pressure on a guard like this is always to widen what it accepts. Every
 * window here is bounded by structure, per tests/helpers/sourceWindow.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween, sliceDollarQuoted } from './helpers/sourceWindow';

const MIGRATIONS = resolve(__dirname, '..', 'supabase/migrations');
const name = readdirSync(MIGRATIONS).find((f) => f.startsWith('20260918091617_'));
if (!name) throw new Error('migration 20260918091617 is missing');
const SQL = readFileSync(resolve(MIGRATIONS, name), 'utf8');
const ROLLBACK = readFileSync(
  resolve(
    __dirname,
    '..',
    'docs/changelog/2026-09-18-a-cash-cutover-cannot-split-an-open-union-week.rollback.sql'
  ),
  'utf8'
);

describe('a cash cutover cannot split an open union week', () => {
  it('is one transaction, because every DDL fires a schema-cache reload', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('refuses to install against a table or a rule it was not written for', () => {
    const pre = sliceDollarQuoted(SQL, '$pre$');
    expect(pre).toContain("IS DISTINCT FROM 'singleton,starts_at'");
    // The existing defences this completes rather than duplicates.
    expect(pre).toContain('accounting_cash_cutover_immutable,accounting_cash_cutover_no_truncate');
    // The week definition, and the refuser whose rule this encodes.
    expect(pre).toContain('fn_union_week_start(timestamptz)');
    expect(pre).toContain('fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)');
    expect(pre.match(/IS DISTINCT FROM '[0-9a-f]{32}'/g) ?? []).toHaveLength(2);
  });

  it('guards INSERT and nothing wider, because the row already refuses the rest', () => {
    const trigger = sliceBetween(SQL, 'CREATE TRIGGER ca_cash_cutover_is_week_aligned', ';');
    expect(trigger).toContain('BEFORE INSERT ON public.accounting_cash_accrual_cutover');
    expect(trigger).toContain('FOR EACH ROW');
    expect(trigger).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bSTATEMENT\b/);
  });

  it('the observer is STABLE, never IMMUTABLE, because a timezone can move', () => {
    const decl = sliceBetween(
      SQL,
      'FUNCTION public.fn_ca_cash_cutover_week_split_by',
      'AS $split$'
    );
    expect(decl).toMatch(/\bSTABLE SECURITY DEFINER\b/);
    expect(decl).not.toMatch(/\bIMMUTABLE\b/);
    expect(decl).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('is reachable by nobody a browser can be', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_cash_cutover_week_split_by\(timestamptz\) FROM PUBLIC, anon, authenticated/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_guard_cash_cutover_week_aligned\(\) FROM PUBLIC, anon, authenticated/
    );
  });

  it('the refusal says which week, what it costs and what to do instead', () => {
    const raise = sliceBetween(SQL, "'cash accrual cutover % would split", 'END IF;');
    expect(raise).toContain('v.week_start');
    expect(raise).toContain('v.orphaned_hours');
    expect(raise).toContain('v.week_end');
    // The hint names the consequence, not just the rule.
    expect(raise).toContain('stop-loss');
  });

  it('a finite instant is required before any week arithmetic is attempted', () => {
    const body = sliceDollarQuoted(SQL, '$guard$');
    const finite = sliceBetween(body, 'NEW.starts_at IS NULL', 'END IF;');
    expect(finite).toContain('NOT isfinite(NEW.starts_at)');
    expect(finite).toContain("ERRCODE = '22007'");
  });

  it('proves the guard before it commits, and proves who refused', () => {
    const post = sliceDollarQuoted(SQL, '$post$');
    // installed and enabled
    expect(post).toContain("t.tgname = 'ca_cash_cutover_is_week_aligned'");
    expect(post).toContain("t.tgenabled IN ('O', 'A')");
    // the observer agrees with the outage this was written from
    expect(post).toContain('IF NOT v.splits THEN');
    // a mid-week insert is refused, and the message is read back and matched,
    // so the proof cannot pass on a primary key violation instead
    expect(post).toContain('GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT');
    expect(post).toContain("v_msg NOT LIKE '%would split the union week%'");
    // and it is not merely refusing everything
    expect(post).toContain('fn_ca_cash_cutover_week_split_by(public.fn_union_week_start(now()))');
    // the row it guards did not move while being verified
    expect(post).toContain('the cutover instant moved during verification');
  });

  it('the rollback removes the guard and never the cutover row', () => {
    expect(ROLLBACK).toContain('DROP TRIGGER IF EXISTS ca_cash_cutover_is_week_aligned');
    expect(ROLLBACK).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_guard_cash_cutover_week_aligned'
    );
    expect(ROLLBACK).toContain('DROP FUNCTION IF EXISTS public.fn_ca_cash_cutover_week_split_by');
    // With no cutover row every period is uncertified, which is worse than the
    // bug. These match STATEMENTS, not the word: the file names the existing
    // trigger accounting_cash_cutover_no_truncate in its prose, and a bare
    // /TRUNCATE/ would fail on the explanation rather than on a destructive
    // statement, which teaches the next person to delete the assertion.
    expect(ROLLBACK).not.toMatch(/\bDELETE\s+FROM\s+public\./i);
    expect(ROLLBACK).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(ROLLBACK).not.toMatch(/^\s*TRUNCATE\b/im);
  });
});
