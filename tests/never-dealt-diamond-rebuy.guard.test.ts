import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261020143955_never_dealt_diamond_rebuy_proves_original_custody.sql',
  'utf8'
);
describe('a never-dealt Diamond rebuy proves its own original custody', () => {
  it('keeps chip funding and binds Diamond funding to the original completed purchase', () => {
    for (const fragment of [
      "fund.asset='chips'",
      'to_jsonb(l)=fund.ledger_snapshot',
      'to_jsonb(w)=fund.wallet_snapshot',
      "fund.asset='diamonds'",
      'public.poker_diamond_tournament_ledger d',
      'public.poker_diamond_movements m',
      "d.id::text=fund.custody_result->>'ledger_id'",
      'm.request=jsonb_build_object',
      "m.receipt->'success'='true'::jsonb",
      'm.wallet_journal_id=d.wallet_journal_id',
      'dc.target_id=p_tournament',
      "dc.state='active'",
      "p.response->>'seat_id'=seat.id::text",
      'seat.joined_at>=c.resolved_at',
      'a.post_commit_completed_at<=fund.observed_at',
      'later.observed_at>fund.observed_at',
      'x.occurred_at>=p.claimed_at',
      'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
    ])
      expect(sql).toContain(fragment);
  });
  it('reads proof without replaying payments, changing stacks or adding a repair loop', () => {
    expect(sql).toContain('5f81993352981f9991b43c9a4d6dbaeb');
    expect(sql).toContain('171b6f3ff886025263b9e2c7e72e6923');
    expect(
      sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
    ).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|cron\.)/i);
    expect(sql).toContain('FROM PUBLIC,anon,authenticated,service_role');
  });
  it('runs the actual native successor in the existing required CI path', () => {
    const runner = readFileSync('scripts/ci/test-never-dealt-rebuy.py', 'utf8');
    expect(runner).toContain('file=root/diamond_migration');
    expect(runner).toContain('before-diamond-rebuy-refusal');
    expect(runner).toContain('NEVER_DEALT_DIAMOND_NATIVE_PASS');
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain(
      'python3 scripts/ci/test-never-dealt-rebuy.py --pg-bin'
    );
  });
});
