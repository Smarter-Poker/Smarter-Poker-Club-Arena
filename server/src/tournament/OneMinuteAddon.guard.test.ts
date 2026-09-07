import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const closeMigration = readFileSync(
  join(
    process.cwd(),
    '../supabase/migrations/20260907180000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
  ),
  'utf8'
);

describe('the MTT add-on is one persisted minute', () => {
  it('announces the offer, price, chips, zero fee, and deadline', () => {
    expect(manager).toContain("message: 'The Add-On Period Has Begun'");
    expect(manager).toContain('addOnFee: 0');
    expect(manager).toContain('durationSeconds: 60');
    expect(manager).toContain('endsAt: addonPeriodEndsAt');
  });

  it('persists and rearms the same deadline across a restart', () => {
    expect(manager).toContain('addon_period_started_at');
    expect(manager).toContain('addon_period_ends_at');
    expect(manager).toContain('this.scheduleAddOnPeriodEnd(tournament.addon_period_ends_at)');
  });

  it('finalizes the prize pool from the timer', () => {
    expect(manager).toContain('this.scheduleAddOnPeriodEnd(addonPeriodEndsAt)');
    expect(manager).toContain('this.finalizeAfterAddOn().catch');
  });

  it('serializes purchases against one atomic guarantee-funded close', () => {
    expect(manager).toContain("supabase.rpc('fn_close_tournament_addon_period'");
    expect(manager).not.toMatch(
      /finalizeAfterAddOn[\s\S]*?update\(\{ prize_pool_finalized: true \}\)[\s\S]*?applyPrizeGuarantee/
    );
    const fn = closeMigration.slice(
      closeMigration.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_tournament_addon_period'),
      closeMigration.indexOf('REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination')
    );
    expect(fn).toContain('FOR UPDATE');
    expect(fn).toContain('clock_timestamp()<v_t.addon_period_ends_at');
    expect(fn).toContain('public.fn_apply_prize_guarantee');
    expect(fn.indexOf('public.fn_apply_prize_guarantee')).toBeLessThan(
      fn.indexOf('COALESCE(v_final.prize_pool_finalized,false)')
    );
    expect(fn).not.toContain('SET prize_pool_finalized=true');
  });
});
