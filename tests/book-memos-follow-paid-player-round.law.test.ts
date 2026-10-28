import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const text = (p: string) => readFileSync(p, 'utf8');
const sql = text('supabase/migrations/20261027162805_book_memos_follow_paid_player_round.sql');
const rows = JSON.parse(text('scripts/ci/fixtures/book-memo-after-r3/original-owners.json'));
describe('book memos follow the completed original player round', () => {
  it('changes only optional key eligibility and preserves the original generation suffix', () => {
    const original = rows.find((r: { signature: string }) =>
      r.signature.startsWith('fn_accounting_close_report_memo_key(')
    ).definition as string;
    const suffix = original.slice(original.indexOf(' IF p_union_id=')).trimEnd() + ';';
    expect(sql.slice(sql.indexOf(' IF p_union_id='), sql.indexOf('REVOKE ALL')).trimEnd()).toBe(
      suffix
    );
    expect(sql).toContain(
      "r.scope_kind='union'AND r.scope_id=p_union_id AND r.union_id=p_union_id"
    );
    for (const s of [
      'r.round_no=3',
      'r.completed_at IS NOT NULL',
      "r.result->>'success'='true'",
      "r.result->>'shortfalls'='0'",
      "r.result->>'source_contract_version'='3'",
      'generation:=NULL;memo_key:=NULL;RETURN;',
    ])
      expect(sql).toContain(s);
    for (const s of [
      'CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting_scope',
      'CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week',
      'CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade',
      'CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report',
    ])
      expect(sql).not.toContain(s);
  });
  it('retains both original NULL-key consumers and late-book ordering', () => {
    for (const name of ['fn_accounting_close_report_seed', 'fn_accounting_close_report_keep'])
      expect(
        rows.find((r: { signature: string }) => r.signature.startsWith(name + '(')).definition
      ).toContain('IF k.memo_key IS NULL THEN RETURN false; END IF;');
    expect(
      text('supabase/migrations/20261027004204_rakeback_is_paid_before_the_club_books_close.sql')
    ).toContain('club_books_close_after_rakeback');
    expect(sql).toContain('book_memo_after_r3_preimage_changed');
    expect(sql).toContain('book_memo_after_r3_postimage_changed');
  });
  it('runs real original helper and failure-boundary regression in the owning accounting shard', () => {
    expect(text('scripts/dev/test-agent-accounting-statements.sh')).toContain(
      'test-book-memo-after-r3-postgres.py'
    );
    const n = text('scripts/ci/test-book-memo-after-r3-postgres.py');
    for (const s of [
      'old-actual-key-seed-keep-run-generation-before-player-round',
      'canonical-R3-restores-actual-original-generation-refusal',
      'stale-generation-GUC-and-old-receipt-cannot-seed-or-retag',
      'original-later-book-certificate-invalidation-preserved',
      'DST-169-hour-week-exact-receipt-key-preserved',
    ])
      expect(n).toContain(s);
  });
});
