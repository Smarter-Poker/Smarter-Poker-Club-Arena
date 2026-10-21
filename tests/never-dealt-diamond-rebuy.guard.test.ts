import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_VARIANTS } from '../server/src/engine/VariantRules';
const sql = readFileSync(
  'supabase/migrations/20261020143955_never_dealt_diamond_rebuy_proves_original_custody.sql',
  'utf8'
);
describe('a never-dealt Diamond rebuy proves its own original custody', () => {
  it('retains exact committed arrivals at a destination that never dealt', () => {
    const arrival = readFileSync(
      'supabase/migrations/20261021172832_never_dealt_arrivals_keep_their_committed_move.sql',
      'utf8'
    );
    for (const fragment of [
      'public.tournament_seat_move_receipts',
      'm.tournament_id=p_tournament AND m.user_id=seat.user_id',
      'm.destination_table_id=p_table AND m.destination_seat_id=seat.id',
      'm.destination_seat_number=seat.seat_number AND m.moved_at=seat.joined_at',
      'seat.stack=arrival.stack',
      'seat.joined_at<o.created_at',
      'later.observed_at>arrival.moved_at',
      'x.occurred_at>=arrival.moved_at',
      "jsonb_build_object('arrival',to_jsonb(arrival))",
      'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
      "fund.asset='diamonds'",
      "fund.asset='chips'",
      'FROM PUBLIC,anon,authenticated,service_role',
    ])
      expect(arrival).toContain(fragment);
    expect(
      arrival
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
    ).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|cron\.)/i);
    const runner = readFileSync('scripts/ci/test-never-dealt-rebuy.py', 'utf8');
    expect(runner).toContain('arrival-before.sql');
    expect(runner).toContain('arrival-boundaries.sql');
    expect(runner).toContain('arrival_migration');
  });
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
  it('enforces all maintained game types and both paid generations in each currency fixture', () => {
    const runner = readFileSync('scripts/ci/test-never-dealt-rebuy.py', 'utf8');
    expect(runner.split("root/DATA/'game-currency-matrix.sql'")).toHaveLength(4);
    const matrix = readFileSync(
      'scripts/ci/fixtures/never-dealt-rebuy/game-currency-matrix.sql',
      'utf8'
    );
    for (const game of ['NLH', 'PLO4', 'PLO5', 'PLO6', 'PLO8', 'SHORT_DECK', 'OFC_PINEAPPLE'])
      expect(matrix).toContain(`'${game}'`);
    expect(matrix).toContain("ARRAY['rebuy','reentry']");
    expect(matrix).toContain("asset NOT IN ('chips','diamonds')");
    expect(matrix).toContain('runs<>20');
    for (const variant of KNOWN_VARIANTS) expect(matrix).toContain(`'${variant.toUpperCase()}'`);
    expect(matrix).toContain('smarter_private.f06_movement_never_dealt_prior(');
    expect(matrix).toContain('ROLLBACK;');
  });
  it('runs PostgreSQL for runner-only and fixture-only edits', async () => {
    const { classifyChangedPaths } = await import('../scripts/ci/classify-ci-changes.mjs');
    for (const path of [
      'scripts/ci/test-never-dealt-rebuy.py',
      'scripts/ci/fixtures/never-dealt-rebuy/game-currency-matrix.sql',
      'scripts/ci/fixtures/never-dealt-rebuy/next-boundary.sql',
      'tests/never-dealt-diamond-rebuy.guard.test.ts',
    ])
      expect(classifyChangedPaths([path]).server).toBe(true);
    expect(classifyChangedPaths(['docs/changelog/rebuy-proof.md']).server).toBe(false);
  });
});
