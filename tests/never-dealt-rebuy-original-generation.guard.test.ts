import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const sql = readFileSync(
  'supabase/migrations/20261007031952_a_never_dealt_rebuy_keeps_its_original_paid_chair.sql',
  'utf8'
);
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
describe('never-dealt original rebuy generation', () => {
  it('preserves the strict entry branch and only admits a completed original paid rebuy', () => {
    for (const s of [
      'entry_proven:=NOT (',
      'entry_proven IS NOT TRUE AND rebuy_proven IS NOT TRUE',
      "p.response->>'atomic_tournament_chip_purchase'='v1'",
      "p.response->>'seat_id'=seat.id::text",
      'seat.joined_at>=c.resolved_at',
      'a.post_commit_completed_at<=fund.observed_at',
      'to_jsonb(l)=fund.ledger_snapshot',
      'to_jsonb(w)=fund.wallet_snapshot',
      'later.observed_at>fund.observed_at',
      'x.occurred_at>=p.claimed_at',
    ])
      expect(sql).toContain(s);
  });
  it('retains never-dealt exclusions, complete roster and private authority', () => {
    for (const s of [
      'public.hand_atomic_commits WHERE table_id=p_table',
      'public.hand_history WHERE table_id=p_table',
      'public.hand_private_state WHERE table_id=p_table',
      'public.table_hole_cards WHERE table_id=p_table',
      'public.hand_state_snapshots WHERE table_id=p_table',
      'smarter_private.f06_hand_permits WHERE table_id=p_table',
      'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
      'REVOKE ALL ON FUNCTION smarter_private.f06_movement_never_dealt_prior',
      "NOT has_function_privilege('service_role',p.oid,'EXECUTE')",
    ])
      expect(sql).toContain(s);
  });
  it('has exact before/after source pins and never replays a money or seat operation', () => {
    expect(sql).toContain('433debf7038257e4c8f0e3dfb9bb4a7d');
    expect(sql).toContain('5f81993352981f9991b43c9a4d6dbaeb');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(
      sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
    ).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|cron\.)/i);
  });
  it('executes the actual scoped native helper and retains failures in required accounting CI', () => {
    expect(ci).toContain('python3 scripts/ci/test-never-dealt-rebuy.py --pg-bin');
    expect(ci).toContain('steps.never_dealt_rebuy.outcome');
    const runner = readFileSync('scripts/ci/test-never-dealt-rebuy.py', 'utf8');
    expect(runner).toContain('file=root/MIGRATION');
    expect(runner).toContain('NEVER_DEALT_REBUY_NATIVE_PASS');
    expect(runner).toContain('e.close()');
  });
});
