import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');

const migration = read('supabase/migrations/20260830223000_leaderboard_reward_setup_safe.sql');
const menu = read('src/components/navigation/HamburgerMenu.tsx');
const page = read('src/pages/LeaderboardPage.tsx');
const service = read('src/services/LeaderboardService.ts');
const wizard = read('src/components/leaderboard/LeaderboardPrizeWizard.tsx');

describe('leaderboard prize setup safety contract', () => {
  it('derives the funding owner and exposes balances only to that manager', () => {
    expect(migration).toContain('public.fn_union_can_manage_wallets(v_union_id, v_actor)');
    expect(migration).toContain('COALESCE(uw.promo_wallet, 0)');
    expect(migration).toContain('COALESCE(v_club.promo_balance, 0)');
    expect(migration).toContain("'union_promo_wallet'");
    expect(migration).toContain("'club_promo_balance'");
    expect(migration).toContain(
      "'available_balance', CASE WHEN v_can_manage THEN v_balance ELSE NULL END"
    );
  });

  it('routes all browser writes through the validated owner RPC', () => {
    expect(migration).toContain(
      'DROP POLICY IF EXISTS club_lb_settings_write ON public.club_leaderboard_settings'
    );
    expect(service).toContain("supabase.rpc('fn_save_leaderboard_reward_setup'");
    expect(service).not.toContain(".from('club_leaderboard_settings').upsert");
    expect(wizard).toContain('LeaderboardService.saveLeaderboardRewardSetup');
  });

  it('does not introduce a client or database money-transfer path', () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.(union_wallets|clubs|club_members)/i);
    expect(service).not.toContain("supabase.rpc('fn_payout_leaderboard'");
    expect(page).not.toContain('Pay Out Current Leaderboard');
    expect(migration).toContain('Automated Leaderboard Payouts Are Paused');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
  });

  it('places an owner-only deep link in the hamburger and opens the wizard once', () => {
    expect(menu).toContain('LeaderboardService.getManageableRewardContexts(true)');
    expect(menu).toContain('Owner Prize Tools');
    expect(menu).toContain('/leaderboard?setup=prizes&club=${rewardContextClubId}');
    expect(page).toContain("params.get('setup') !== 'prizes'");
    expect(page).toContain('openedSetupLinkRef.current !== requestKey');
    expect(page).toContain('<LeaderboardPrizeWizard');
  });

  it('supports suggested, disabled, and custom setup paths', () => {
    expect(wizard).toContain('Do You Want To Reward Leaderboard Prizes?');
    expect(wizard).toContain('step === 0 && !enabled ? 3 : step + 1');
    expect(wizard).toContain("setPlanKey('custom')");
    expect(wizard).toContain('A Planned Period Is Larger Than The Current Promo Balance');
  });
});
