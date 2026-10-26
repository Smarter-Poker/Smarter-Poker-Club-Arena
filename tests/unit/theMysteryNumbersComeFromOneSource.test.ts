/**
 * MYSTERY BOUNTY NUMBERS AGREE (2026-10-26 audit of Dan's screenshot).
 *
 * Rewards showed "Total Pool 5,375 / Still Available 4,125" while the Bounties
 * card showed "Bounty Pool 4,525 / Still In Play 3,195" for the same event.
 * The lobby loader never selected `bounty_pool`, so Rewards fell back to
 * summing every player's head - knocked-out players included, rebuys missing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('the mystery numbers come from one source', () => {
  it('every tournament loader selects the funded bounty pool', () => {
    const svc = read('src/services/TournamentService.ts');
    const selects = svc.match(/is_bounty, bounty_amount, [a-z_, ]*is_pko,/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const s of selects) {
      expect(s).toContain('bounty_pool, bounty_pool_paid');
    }
  });

  it('the head fallback counts only players still in', () => {
    const rw = read('src/components/tournament/details/RewardsTab.tsx');
    expect(rw).toContain(".select('current_bounty, status')");
    expect(rw).toMatch(/liveHeads: live\s*\.filter\(\(r\) => isStillIn\(/);
  });

  it('the ladder button opens the Bounties tab', () => {
    const dov = read('src/components/tournament/details/DetailOverviewTab.tsx');
    expect(dov).toMatch(/onOpenTab\('bounties'\)\}\s*>\s*Open The Full Mystery Ladder/);
  });

  it('a bounties link to a non-mystery event selects Rewards everywhere', () => {
    const page = read('src/pages/tournament/TournamentDetails.tsx');
    expect(page).toContain(
      "activeTab === 'bounties' && !isMysteryBountyEvent ? 'rewards' : activeTab"
    );
    expect(page).toContain('aria-selected={shownTab === tab.id}');
    expect(page).toContain('aria-labelledby={`tl-tab-${shownTab}`}');
    expect(page).toContain('normaliseTabId(new URLSearchParams(search).get(');
  });

  it('a failed refresh keeps the ladder instead of blanking it', () => {
    const hook = read('src/hooks/useMysteryBounty.ts');
    expect(hook).toContain('getInventory(tournamentId, { strict: true })');
    expect(hook).toContain('getAllAwards(tournamentId, { strict: true })');
    expect(hook).toContain('getLeaderboard(tournamentId, { strict: true })');
  });

  it('an unread payout says so instead of printing 0', () => {
    const panel = read('src/components/tournament/MysteryBountyPanel.tsx');
    expect(panel).toContain('unread: true');
    expect(panel).toContain("'Could Not Be Read'");
  });
});
