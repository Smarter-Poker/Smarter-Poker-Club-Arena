import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260830235900_daily_challenge_economy_contracts.sql'),
  'utf8'
);

describe('daily challenge economy contracts', () => {
  it('makes the freeze price server-owned and replay-safe', () => {
    expect(migration).toContain('FREEZE_COST constant integer := 5000');
    expect(migration).toContain('p_cost IS DISTINCT FROM FREEZE_COST');
    expect(migration).toContain('p_amount           := FREEZE_COST');
    expect(migration).not.toContain('p_amount           := p_cost');
    expect(migration).toContain("'streak_freeze:' || v_uid::text || ':' || p_request_id::text");
    expect(migration).toContain("(v_deduct->>'idempotent')::boolean");
  });

  it('records a catalog-authoritative, atomic claim contract', () => {
    expect(migration).toContain('FROM public.daily_challenge_catalog');
    expect(migration).toContain('p_reward_amount IS DISTINCT FROM v_cat.chip_reward');
    expect(migration).toContain("'challenge_claim:' || p_challenge_row_id::text");
    expect(migration).toContain("'daily_challenge_claim'");
    expect(migration).not.toContain('EXCEPTION WHEN OTHERS');
  });

  it('allows only authenticated and service-role execution', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid) FROM PUBLIC, anon'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) FROM PUBLIC, anon'
    );
    expect(migration).toContain('TO authenticated, service_role');
  });
});
