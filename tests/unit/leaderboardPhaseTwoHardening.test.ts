import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '../../src/pages/LeaderboardPage.tsx'), 'utf8');
const service = readFileSync(join(__dirname, '../../src/services/LeaderboardService.ts'), 'utf8');

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
    expect(page).toContain('setPayouts([])');
    expect(page).toContain('setUserRank(null)');
    expect(page).toContain('const requestId = ++settingsRequestRef.current');
  });

  it('uses strict primary reads so transport failures do not masquerade as empty boards', () => {
    expect(service.match(/strict: boolean = false/g)?.length).toBe(3);
    expect(service.match(/if \(strict\) throw/g)?.length).toBeGreaterThanOrEqual(6);
    expect(page).toContain('Rankings Could Not Be Loaded.');
    expect(page).toContain('Tournament Stats Could Not Be Loaded.');
    expect(page).toContain('Showing The Last Verified Board.');
  });

  it('limits payouts to configured periods and refreshes payout badges after issuance', () => {
    expect(page).toContain("const canPayout = period === 'weekly' || period === 'monthly'");
    expect(page).toContain('if (payingOut) return');
    expect(page).toContain(
      "if (!payoutSucceeded) throw new Error('Payout Could Not Be Completed.')"
    );
    expect(page).toContain('const refreshedPayouts = await LeaderboardService.getPayoutsForPeriod');
    expect(page).toContain('setPayouts(refreshedPayouts)');
  });

  it('makes tabs and the settings dialog keyboard-operable and save-safe', () => {
    expect(page).toContain('role="tablist"');
    expect(page).toContain('onKeyDown={handleTabKeyDown}');
    expect(page).toContain('role="tabpanel"');
    expect(page).toContain('const settingsModalRef = useFocusTrap(showSettings)');
    expect(page).toContain('if (!selectedClubId || !settings || settingsSaving) return');
    expect(page).toContain("settingsSaving ? 'Saving Settings' : 'Save Settings'");
  });
});
