/**
 * THE BOOKS CLOSE (phase 4 of 9).
 *
 * Places where the books could not close, read from production on
 * 2026-10-03, each fixed at the line that caused it:
 *
 *   1. A week closed every period but one: the union's own club row, which the
 *      square-up opens and the settler never settled.
 *   2. A payment reminder seated club admins in an accounting conversation,
 *      whose audience is fixed, so ageing failed for the whole union.
 *   3. The union law paged about record_rake after it was retired.
 *
 * The rolled-back production probe (one MCP call ending in RAISE) put the
 * self-test at zero breaches, the stuck period at settled with no open period
 * left for the union, reproduced the old reminder's refusal on SHARK CLUB, and
 * delivered the new reminder into every conversation each statement went to.
 * The conservation delta ships separately, with its native PG17 qualification.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_the_books_close.sql'))
  .sort()
  .at(-1);
if (!NAME) throw new Error('the the-books-close migration is missing');
const SQL = readFileSync(join(MIGRATIONS, NAME), 'utf8');
const CODE = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');
const block = (tag: string): string => {
  const start = CODE.indexOf(`DO $${tag}$`);
  if (start < 0) throw new Error(`block ${tag} is missing`);
  return CODE.slice(start, CODE.indexOf(`$${tag}$;`, start + 1));
};

describe('the books close', () => {
  it('pins every function it edits to the body read on 2026-10-03', () => {
    const pins = block('pins');
    for (const [fn, md5] of [
      ['fn_union_law_selftest()', '78f67db74acb118fad17bfe8f29249a6'],
      [
        'fn_mark_scope_accounting_settled(text,uuid,timestamp with time zone,timestamp with time zone)',
        '8471e94814d37d3fb9359b711682e0b1',
      ],
      ['fn_union_age_invoices(uuid)', 'ae5549f087f405e52638d8d41e13cf6f'],
    ]) {
      expect(pins).toContain(`'public.${fn}', '${md5}'`);
    }
    expect(pins).toContain('BOOKS_MOVED_UNDERNEATH');
  });

  it('settles every period the week opened for the union, its own club row included', () => {
    const week = block('week');
    expect(week).toContain(
      "c_old CONSTANT text := ' IF u_id IS NOT NULL THEN clubs:=array_append(clubs,NULL::uuid); END IF;'"
    );
    expect(week).toMatch(
      /WHERE sp\.union_id=u_id AND sp\.start_at=p_from AND sp\.end_at=p_to\s+AND sp\.club_id IS NOT NULL AND NOT \(sp\.club_id=ANY\(clubs\)\);/
    );
  });

  it('closes the one stuck week through the settler itself, after checking the run completed', () => {
    const close = block('close');
    expect(close).toContain("'747205e9-ec0a-4474-979d-cd5710dac54a'");
    expect(close).toMatch(/status = 'complete'\) THEN/);
    expect(close).toContain(
      "PERFORM public.fn_mark_scope_accounting_settled('union', 'fade0000-0000-0000-0000-000000000001',"
    );
    // The period is settled by the platform's own path, never by hand.
    expect(close).not.toMatch(/UPDATE public\.settlement_periods/);
  });

  it('posts a reminder where its statement went, and seats nobody', () => {
    const fn = CODE.slice(
      CODE.indexOf('CREATE FUNCTION public.fn_union_remind_statement'),
      CODE.indexOf('$fn$;')
    );
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/IF NOT public\.fn_caller_is_engine\(\) THEN/);
    expect(fn).toContain("inv.invoice_type IS DISTINCT FROM 'union_weekly_squareup'");
    expect(fn).toContain('PERFORM public.fn_deliver_accounting_invoice(inv.id);');
    expect(fn).toMatch(/JOIN public\.social_messages m ON m\.id = d\.message_id/);
    expect(fn).not.toMatch(/social_conversation_participants/);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_union_remind_statement(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_union_remind_statement(uuid, text, jsonb) TO service_role;'
    );
    const age = block('age');
    expect(age).toContain("position('fn_union_send_club_message' in v_new) > 0");
    expect(age).toContain('v_msg := public.fn_union_remind_statement(');
  });

  it('lets a retired record_rake keep the union law without letting a writer through', () => {
    const law = block('law');
    expect(law).toContain("AND p.prosrc NOT LIKE ''%atomic_distribute_rake%''");
    expect(law).toContain("AND NOT (p.prosrc LIKE ''%record_rake_retired%''");
    expect(law).toContain("p.prosrc !~* ''\\m(insert|update|delete|perform|execute|call)\\M''");
    for (const landmark of [
      'atomic_distribute_rake_law_missing',
      'fn_resolve_bbj_pool_law_missing',
      'tournament_buyin_rake_not_club_scoped',
      'required_cron_missing',
    ]) {
      expect(law).toContain(`position('${landmark}' in v_new) = 0`);
    }
  });

  it('is one transaction with a lock timeout, moves no chip and adds no job (10.12)', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toMatch(/BEGIN;\nSET LOCAL lock_timeout = '5s';/);
    expect(CODE).not.toMatch(/cron\.schedule/i);
    expect(CODE).not.toMatch(/chip_ledger\s*\(/i);
    expect(CODE).not.toMatch(/fn_credit_and_log|fn_add_chips|wallet_transactions\s*\(/);
    expect(CODE).not.toMatch(/\bDROP\b/);
    expect(SQL).toMatch(
      /@live-proof: \(SELECT to_regprocedure\('public\.fn_union_remind_statement/
    );
  });
});
