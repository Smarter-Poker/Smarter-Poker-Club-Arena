import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '../../src/pages/LeaderboardPage.tsx'), 'utf8');
const service = readFileSync(join(__dirname, '../../src/services/LeaderboardService.ts'), 'utf8');
const wizard = readFileSync(
  join(__dirname, '../../src/components/leaderboard/LeaderboardPrizeWizard.tsx'),
  'utf8'
);
const migration = readFileSync(
  join(__dirname, '../../supabase/migrations/20260830223000_leaderboard_reward_setup_safe.sql'),
  'utf8'
);

describe('leaderboard phase two operational hardening', () => {
  it('bounds and expires the session cache instead of keeping raw rankings forever', () => {
    expect(page).toContain("const LB_CACHE_KEY = 'lb_cache_v2_'");
    expect(page).toContain('const LB_CACHE_TTL_MS = 5 * 60 * 1000');
    expect(page).toContain('const LB_CACHE_MAX_RECORDS = 20');
    expect(page).toContain('sessionStorage.removeItem(storageKey)');
  });

  it('does not poll or respond to game events while the leaderboard is hidden', () => {
    expect(page).toContain("document.visibilityState !== 'visible'");
    expect(page).toContain("scheduleRefresh('rankings')");
    expect(page).toContain("scheduleRefresh('tournaments')");
    expect(page).toContain('}, 600)');
  });

  it('deduplicates silent ranking refreshes and keeps background tournament loads silent', () => {
    expect(page).toContain('if (silent && activeRankingRequestRef.current !== 0) return');
    expect(page).toContain('loadTournamentStatsRef.current(() => isMountedRef.current, true)');
    expect(page).toContain('if (!silent) setTournamentsLoading(true)');
  });

  it('invalidates account and club-specific state before loading a new context', () => {
    expect(page).toContain('setUserClubs([])');
    expect(page).toContain('setSelectedClubId(null)');
    expect(page).toContain('setSettlementStatus(null)');
    expect(page).toContain('setSettlementError(null)');
    expect(page).toContain('setUserRank(null)');
    expect(page).toContain('const requestId = ++settingsRequestRef.current');
  });

  it('uses strict primary reads so transport failures do not masquerade as empty boards', () => {
    expect(service.match(/strict: boolean = false/g)?.length).toBe(4);
    expect(service.match(/if \(strict\) throw/g)?.length).toBeGreaterThanOrEqual(6);
    expect(page).toContain('Rankings Could Not Be Loaded.');
    expect(page).toContain('Tournament Stats Could Not Be Loaded.');
    expect(page).toContain('Showing The Last Verified Board.');
  });

  it('retires the unsafe browser payout path while keeping verified receipts visible', () => {
    expect(page).not.toContain('payoutLeaderboardPeriod');
    expect(service).not.toContain("supabase.rpc('fn_payout_leaderboard'");
    expect(page).toContain('const payout = payoutsByUser.get(entry.userId)');
    expect(page).toContain(
      'Published Rules Activate At The Dates Shown. Settlement Uses The Recorded Promo Wallet After The Period Closes.'
    );
    expect(migration).toContain('Automated Leaderboard Payouts Are Paused');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
  });

  it('makes tabs and the prize wizard keyboard-operable and save-safe', () => {
    expect(page).toContain('role="tablist"');
    expect(page).toContain('onKeyDown={handleTabKeyDown}');
    expect(page).toContain('role="tabpanel"');
    expect(wizard).toContain('const dialogRef = useFocusTrap(isOpen)');
    expect(wizard).toContain("event.key === 'Escape' && !saving");
    expect(wizard).toContain('if (saving || (enabled && (!hasPrizes || exceedsAvailable))) return');
    expect(wizard).toContain("saving ? 'Publishing Prize Program' : 'Publish Prize Program'");
  });

  it('keeps an open prize wizard stable while the leaderboard refreshes its club context', () => {
    expect(page).toContain(
      'const [editingSettings, setEditingSettings] = useState<LeaderboardSettings | null>(null)'
    );
    expect(page).toContain('setEditingSettings(settings);');
    expect(page).toContain('setup={editingSettings}');
    expect(page).not.toContain('showSettings && settings?.can_manage');
  });

  it('does not dismiss the prize wizard during a late auth hydration and wires setup deep links', () => {
    const authRefresh = page.slice(
      page.indexOf("// Load user's clubs on mount or when user auth changes"),
      page.indexOf('// Keep activeTabRef in sync')
    );
    expect(authRefresh).toContain('user === null');
    expect(authRefresh).toContain('previousUserId !== user.id');
    expect(authRefresh).toContain('setEditingSettings(null)');
    expect(authRefresh).toContain('setShowSettings(false)');

    const setupDeepLink = page.slice(
      page.indexOf("if (params.get('setup') !== 'prizes'"),
      page.indexOf('// 2026-08-24: a useMasterBusChannel')
    );
    expect(setupDeepLink).toContain('setEditingSettings(settings)');
    expect(setupDeepLink).toContain('setShowSettings(true)');
    expect(setupDeepLink).toContain("params.delete('setup')");
    expect(setupDeepLink).toContain('navigate({ search: params.toString() }, { replace: true })');
  });

  it('snapshots every visible settings entry point and exposes retryable setup reads', () => {
    expect(page.match(/setEditingSettings\(settings\);/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toContain('Prize Setup Could Not Be Loaded.');
    expect(page).toContain('Retry Prize Setup');
    expect(service).toContain('async getManageableRewardContexts(strict: boolean = false)');
    expect(service).toContain('if (strict) throw err;');
  });
});
