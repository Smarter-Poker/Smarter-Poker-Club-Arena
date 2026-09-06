import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    __dirname,
    '../../supabase/migrations/20260906084547_leaderboard_phase_4_promo_only_settlement_truth.sql'
  ),
  'utf8'
);
const page = readFileSync(join(__dirname, '../../src/pages/LeaderboardPage.tsx'), 'utf8');

describe('leaderboard phase four settlement truth', () => {
  it('never reaches an operating wallet when the promo wallet is short', () => {
    expect(migration).toContain('IF v_seed_available + v_promo_available < v_total THEN');
    expect(migration).toContain('LEADERBOARD_PROMO_UNDERFUNDED|');
    expect(migration).not.toMatch(/SET\s+chip_balance\s*=/i);
    expect(migration).not.toMatch(/SET\s+chip_treasury\s*=/i);
    expect(migration).toContain(
      'CHECK (overlay_funded = 0 AND total_paid = seed_funded + promo_funded)'
    );
  });

  it('splits occupied prizes across ties and conserves cent residue', () => {
    expect(migration).toContain('count(*) OVER (PARTITION BY board.rank)');
    expect(migration).toContain('prizes.rank < tied.rank + tied.tie_count');
    expect(migration).toContain("'split_occupied_places'");
    expect(migration).toContain('mod((pooled.pool_amount * 100)::bigint, pooled.tie_count)');
    expect(migration).not.toMatch(
      /row_number\(\) OVER \(ORDER BY ranked\.rank, ranked\.user_id\)/i
    );
  });

  it('links every winner receipt to one immutable payout batch', () => {
    expect(migration).toContain('ALTER COLUMN batch_id SET NOT NULL');
    expect(migration).toContain('FOREIGN KEY (batch_id)');
    expect(migration).toContain('UNIQUE (batch_id, user_id)');
    expect(migration).toContain("'batch_id', payout.batch_id");
  });

  it('retains categorized failure attempts and resolves them forward', () => {
    expect(migration).toContain(
      'attempt_count = public.leaderboard_payout_failures.attempt_count + 1'
    );
    expect(migration).toContain("resolution = 'Settlement Completed Automatically'");
    expect(migration).not.toContain('DELETE FROM public.leaderboard_payout_failures');
    expect(migration).toContain("'automatic_retry', true");
  });

  it('keeps payout execution service-only and exposes only the authenticated read model', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)'
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_settlement_status(uuid, text, date)'
    );
    expect(migration).toContain('TO authenticated, service_role');
    expect(migration).toContain("RAISE EXCEPTION 'Leaderboard Access Denied'");
  });

  it('replaces separate plan and payout requests with one status read model', () => {
    expect(page).toContain('LeaderboardService.getLeaderboardSettlementStatus(');
    expect(page).not.toContain('LeaderboardService.getPayoutsForPeriod(');
    expect(page).toContain('allocateTiedPrizePlan(entries, rewardPlan.prizes)');
    expect(page).toContain('<LeaderboardSettlementCard');
  });
});
