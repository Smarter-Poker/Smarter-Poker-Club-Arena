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
    /* The stale-settings guard compares the owner record against the club the
       URL RESOLVED to (`requestedClub.id`), not the raw param - a slug in the
       URL is not a uuid in `settings.club_id`, so the raw comparison would
       have been false for every slug link and the guard would have looked
       armed while never opening the wizard (the-menu-stays-in-the-club). */
    expect(page).toContain('settings?.club_id === requestedClub.id');
    expect(page).toContain('openedSetupLinkRef.current !== requestKey');
    expect(page).toContain('<LeaderboardPrizeWizard');
  });

  it('supports suggested, disabled, and custom setup paths', () => {
    expect(wizard).toContain('Do You Want To Reward Leaderboard Prizes?');
    expect(wizard).toContain('step === 0 && !enabled ? 3 : step + 1');
    expect(wizard).toContain("setPlanKey('custom')");
    expect(wizard).toContain('This Plan Cannot Be Published.');
    expect(wizard).toContain('proposedCommitment > publicationCapacity');
  });

  it('puts the first-use decision in front of an owner who has never published', () => {
    /* Phase 4 owner operations: the eligible first use is an owner-only
       section on the club board, gated on the derived manager flag and the
       absence of a completed setup. Members never see it. */
    expect(page).toContain('No Prize Program Yet');
    expect(page).toMatch(/canManagePrizes &&\s*settings &&\s*!settings\.setup_complete/);
    expect(page).toContain('Nothing Is Paid Until A Plan Is Published And Its Period Closes.');
  });

  it('tells players the rules the round is actually settled under', () => {
    expect(page).toContain(
      'Weeks Start Sunday At 00:00 UTC. Months Start On The First At 00:00 UTC.'
    );
    expect(page).toContain('Rule Changes Start At The Next Weekly Or Monthly UTC Boundary.');
    expect(page).toContain('Tied Places Share Their Occupied Prizes.');
    expect(page).toContain(
      'Prize Marks A Planned Amount While A Round Is Live. Paid Marks A Verified Receipt.'
    );
    /* The old copy promised hidden badges the page never hid. */
    expect(page).not.toContain('Planned Prizes Are Hidden Until');
    expect(page).not.toContain('Owner Prize Circuit');
  });

  it('recovers from a refused publish by refetching the owner record', () => {
    expect(wizard).toContain('onSaveError?.(failure)');
    expect(wizard).toContain('describeSaveError(failure, setup.funding_label)');
    expect(wizard).toContain("safeErrorMessage(error, 'Prize Setup Could Not Be Saved')");
    expect(page).toContain('settingsStaleRef.current = true');
    expect(page).toContain('setSettingsReloadKey((value) => value + 1)');
  });

  it('clears the stale mark whenever the owner record is replaced', () => {
    /* A refused publish followed by a successful one in the same dialog, or a
       club or account switch, must not leave a mark that refetches later. */
    expect(page).toMatch(
      /const requestId = \+\+settingsRequestRef\.current;[\s\S]{0,400}settingsStaleRef\.current = false;/
    );
    expect(page).toMatch(
      /onSaved=\{\(savedSetup\) => \{[\s\S]{0,300}settingsStaleRef\.current = false;/
    );
  });

  it('keeps the settlement card off a club that has never had a program', () => {
    expect(page).toMatch(
      /\(!settings \|\| settings\.setup_complete\) && \(\s*<LeaderboardSettlementCard/
    );
  });

  it('does not promise payment from an underfunded wallet', () => {
    expect(page).toContain("settings.funding_status === 'underfunded'");
    expect(page).toContain('After The Period Closes, Once It Covers The Published Prizes.');
  });

  it('keeps the rules a list and the program details inside their terms', () => {
    expect(page).toContain('<ul className="lb-prize-rules" role="list" aria-label="Prize Rules">');
    expect(page).not.toMatch(
      /<\/dd>\s*\{settings\.(published_at|weekly_effective_from|monthly_effective_from) &&/
    );
  });

  it('finds the owner tools through the shared search helper', () => {
    expect(menu).toContain("from './rewardToolSearch'");
    expect(menu).not.toContain('REWARD_TOOL_SEARCH_VOCABULARY');
  });
});
