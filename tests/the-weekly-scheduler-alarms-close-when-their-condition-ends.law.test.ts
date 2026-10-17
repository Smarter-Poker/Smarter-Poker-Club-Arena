/**
 * THE WEEKLY SCHEDULER ALARMS CLOSE WHEN THEIR CONDITION ENDS (2026-10-17)
 *
 * fn_process_weekly_accounting_scope raised "a visit did not finish" and
 * "a union week is incomplete" alarms and nothing ever closed them, so 41
 * stood open long after every one of them was over. Each now closes at the
 * place its condition ends, and only there: a finished visit closes its own
 * scope's unfinished-visit alarms; a week recorded complete closes that
 * week's incomplete-week alarms.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017132354_the_weekly_scheduler_alarms_close_when_their_condition_ends.sql',
  'utf8'
);
const new3 = sql.split('$n3$')[1];
const new4 = sql.split('$n4$')[1];

describe('the weekly scheduler alarms close when their condition ends', () => {
  it('a finished visit closes only its own scope unfinished-visit alarms', () => {
    expect(new3).toContain("IF v_scope_outcome='visited' THEN");
    expect(new3).toContain("a.message='A weekly accounting scope did not finish its scheduler visit'");
    expect(new3).toContain("a.context->>'scope_kind'=v_scope.kind AND a.context->>'scope_id'=v_scope.id::text");
  });

  it('a week recorded complete closes only that week incomplete-week alarms', () => {
    expect(new4).toContain("IF v_result->>'success'='true' THEN");
    expect(new4).toContain("a.message='Weekly union accounting is incomplete'");
    expect(new4).toContain("a.context->>'union_id'=v_union.id::text");
    expect(new4).toContain(
      "(a.context->>'period_start')::timestamptz=v_from AND (a.context->>'period_end')::timestamptz=v_end"
    );
  });

  it('touches no money table and pins its preimage and postimage', () => {
    expect(sql).not.toMatch(
      /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(?:chip_ledger|club_members|union_accounting_runs|settlement_invoices|accounting_close_certificates)\b/i
    );
    expect(sql).toContain("'56eb1c0de1083bddd8a1e218a85df511'");
    expect(sql).toContain("'86c6a68eec0928c90aea883b48101c9f'");
    expect(sql).toContain('fn_ca_break_window_refuses_migrations(now())');
  });
});
