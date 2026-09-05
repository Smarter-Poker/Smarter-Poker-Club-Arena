/**
 * PROFILE CREDENTIAL — regression pins for the 2026-09-04 audit (PR #3077).
 *
 * Every pin below is a defect that was live on smarter.poker/hub/club-arena/
 * profile on 2026-09-04 and NOT covered by the parallel identity pass in
 * PR #3041 (tests/player-identity-casino-realism.test.ts owns VIP-not-a-ladder,
 * truncation on the credential, the alias editor and the hero renders). Read
 * the failing assertion before touching it: each one names the bug it stops
 * from shipping again.
 *
 * Dan 2026-09-04: "ABSOLUTELY ZERO ROUNDING ANYWHERE EVER" - every helper
 * asserted here truncates.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  formatPct,
  formatSignedPct,
  formatSignedChips,
  formatCount,
  formatHours,
  formatMemberSince,
  ordinal,
  relativeTimeTitle,
} from '../../src/utils/format';
import { streakMultiplier, daysToNextStreakStep } from '../../src/utils/streakMultiplier';
import { profileStatsFromV2, EMPTY_STATS } from '../../src/utils/profileStats';
import { aggregateArenaRecord } from '../../src/utils/arenaRecord';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PROFILE = read('src/pages/ProfilePage.tsx');
const PUBLIC_PROFILE = read('src/pages/PublicProfilePage.tsx');
const PROFIT_CHART = read('src/components/profile/ProfitChart.tsx');
const PUBLIC_CSS = read('src/pages/PublicProfilePage.module.css');

describe('no stat reaches the DOM unrounded', () => {
  it('ROI is not 1.6500000000000001% any more, and nothing is rounded up', () => {
    expect(formatSignedPct(0.0165 * 100)).toBe('+1.6%');
    expect(formatSignedPct(-3.25)).toBe('-3.2%');
    expect(formatSignedPct(1.99)).toBe('+1.9%');
    expect(formatSignedPct(0)).toBe('0.0%');
    expect(formatSignedPct(Number.NaN)).toBe('0.0%');
    expect(formatPct(0.3293 * 100)).toBe('32.9%');
    expect(formatPct(0.3293 * 100, 0)).toBe('32%');
  });

  it('chips carry a sign and thousands separators', () => {
    expect(formatSignedChips(1711.5)).toBe('+1,711.50');
    expect(formatSignedChips(-2183.7)).toBe('-2,183.70');
    expect(formatSignedChips(2183.7)).toBe('+2,183.70');
    expect(formatSignedChips(0.999)).toBe('+0.99');
    expect(formatCount(1411.9)).toBe('1,411');
    expect(formatSignedChips(0)).toBe('0.00');
    expect(formatCount(1412)).toBe('1,412');
    expect(formatCount('7')).toBe('0');
  });

  it('hours, ordinals and member-since have one format each', () => {
    expect(formatHours(9.99)).toBe('9.9h');
    expect(formatHours(0.5)).toBe('30m');
    expect(formatHours(0)).toBe('0h');
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(113)).toBe('113th');
    expect(ordinal(0)).toBe('-');
    expect(formatMemberSince('2025-10-03T00:00:00Z')).toBe('Oct 2025');
    expect(formatMemberSince(null)).toBe('Unknown');
  });

  it('relative time is Title Case and null when unknown', () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    expect(relativeTimeTitle('2026-09-04T11:59:40Z', now)).toBe('Just Now');
    expect(relativeTimeTitle('2026-09-04T11:48:00Z', now)).toBe('12m Ago');
    expect(relativeTimeTitle('2026-09-04T09:00:00Z', now)).toBe('3h Ago');
    expect(relativeTimeTitle('2026-09-02T09:00:00Z', now)).toBe('2d Ago');
    expect(relativeTimeTitle(null, now)).toBeNull();
    expect(relativeTimeTitle('not a date', now)).toBeNull();
  });
});

describe('the streak multiplier is the one the ledger pays', () => {
  it('mirrors public.fn_get_streak_multiplier exactly', () => {
    // CASE WHEN >=30 THEN 2.0 WHEN >=14 THEN 1.8 WHEN >=7 THEN 1.5 WHEN >=3 THEN 1.2 ELSE 1.0
    expect(streakMultiplier(0)).toBe(1.0);
    expect(streakMultiplier(2)).toBe(1.0);
    expect(streakMultiplier(3)).toBe(1.2);
    expect(streakMultiplier(6)).toBe(1.2);
    expect(streakMultiplier(7)).toBe(1.5);
    expect(streakMultiplier(13)).toBe(1.5);
    expect(streakMultiplier(14)).toBe(1.8);
    expect(streakMultiplier(29)).toBe(1.8);
    expect(streakMultiplier(30)).toBe(2.0);
    expect(streakMultiplier(365)).toBe(2.0);
    expect(streakMultiplier(Number.NaN)).toBe(1.0);
  });

  it('never advertises 1 + 0.1 x days again', () => {
    expect(daysToNextStreakStep(7)).toBe(7);
    expect(daysToNextStreakStep(29)).toBe(1);
    expect(daysToNextStreakStep(30)).toBeNull();
    expect(PROFILE).not.toContain('dailyStreak * 0.1');
    expect(PROFILE).toContain('multiplier={streakMultiplier(dailyStreak)}');
  });
});

describe('the v2 stats reader', () => {
  const payload = {
    contract_version: 2,
    overall: {
      total_hands: 750,
      hands_won: 236,
      vpip: 0.3293,
      pfr: 0.2613,
      three_bet_percent: 0.2691,
      aggression_factor: 2.82,
      bb_per_100: -305.62,
      biggest_pot_won: 1711.5,
      biggest_hand_loss: -1200,
      total_profit: -2183.7,
      wtsd: 0.156,
      showdowns_total: 117,
      showdowns_won: 53,
      hours_played: 9.9,
      cash_hands: 402,
      tourney_hands: 348,
      hands_capped: true,
    },
    tournaments: {
      roi: 0.0165,
      wins: 7,
      cashes: 8,
      entries: 22,
      net_profit: 19.71,
      best_finish: 1,
      itm_percent: 0.3636,
      total_bounties: 11,
    },
    lifetime: {
      hands: 1412,
      first_hand_at: '2026-08-15T02:37:03Z',
      last_hand_at: '2026-09-04T23:21:54Z',
    },
    coverage: { last_hand_at: '2026-09-04T23:21:54Z', first_hand_at: '2026-08-15T02:37:03Z' },
    daily: [
      { date: '2026-08-24', hands: 14, profit: -162 },
      { date: '2026-08-25', hands: 57, profit: -487.13 },
    ],
    sessions: [
      {
        id: 36,
        date: '2026-09-04T22:46:27Z',
        buy_in: 122.89,
        cash_out: 22.16,
        profit_loss: -100.73,
        hands_played: 29,
        duration_minutes: 35,
      },
    ],
    variants: [{ variant: 'nlh', hands: 357, profit: -654.5, bb100: -385.84 }],
  };

  it('reads lifetime hands separately from the capped analysis window', () => {
    const s = profileStatsFromV2(payload)!;
    expect(s.totalHands).toBe(750);
    expect(s.lifetimeHands).toBe(1412);
    expect(s.analysisCapped).toBe(true);
  });

  it('carries the real daily P/L, sessions and variants the chart draws', () => {
    const s = profileStatsFromV2(payload)!;
    expect(s.daily).toHaveLength(2);
    expect(s.daily[1]).toEqual({ date: '2026-08-25', hands: 57, profit: -487.13 });
    expect(s.sessions[0].profit).toBe(-100.73);
    expect(s.sessions[0].minutes).toBe(35);
    expect(s.variants[0].variant).toBe('nlh');
    expect(s.lastHandAt).toBe('2026-09-04T23:21:54Z');
  });

  it('derives showdown and tournament figures from the payload, not zeroes', () => {
    const s = profileStatsFromV2(payload)!;
    expect(s.showdownWinRate).toBeCloseTo((53 / 117) * 100, 6);
    expect(s.wtsd).toBeCloseTo(15.6, 6);
    expect(s.itmPercent).toBeCloseTo(36.36, 6);
    expect(s.bestFinish).toBe(1);
    expect(s.tournamentCashes).toBe(8);
    expect(s.tournamentNet).toBe(19.71);
  });

  it('rejects anything that is not contract v2', () => {
    expect(profileStatsFromV2(null)).toBeNull();
    expect(profileStatsFromV2({ contract_version: 1, overall: {} })).toBeNull();
    expect(profileStatsFromV2({ contract_version: 2 })).toBeNull();
    expect(EMPTY_STATS.daily).toEqual([]);
  });
});

describe('the public arena record folds player_stats by hands', () => {
  it('weights VPIP and PFR by hands played per club', () => {
    const r = aggregateArenaRecord([
      { hands_played: 22, vpip: 85.71, pfr: 28.57, tournaments_played: 0, tournaments_won: 0 },
      { hands_played: 279, vpip: 44, pfr: 24, tournaments_played: 21, tournaments_won: 7 },
    ]);
    expect(r.hands).toBe(301);
    expect(r.clubs).toBe(2);
    expect(r.vpip).toBeCloseTo((22 * 85.71 + 279 * 44) / 301, 6);
    expect(r.tournamentsPlayed).toBe(21);
    expect(r.tournamentsWon).toBe(7);
  });

  it('is safe on empty and malformed rows', () => {
    expect(aggregateArenaRecord([]).hands).toBe(0);
    expect(aggregateArenaRecord([{ hands_played: 'x', vpip: null }]).vpip).toBe(0);
  });
});

describe('the credential reads the stats payload, not fabrications', () => {
  it('shows lifetime hands in the rail and the analysis window in the snapshot', () => {
    expect(PROFILE).toContain('stats.lifetimeHands.toLocaleString()');
    expect(PROFILE).toContain("stats.analysisCapped ? 'Hands Analyzed' : 'Hands Played'");
  });

  it('reports the last hand time instead of a decorative "Profile Synced"', () => {
    expect(PROFILE).toContain('relativeTimeTitle(stats.lastHandAt)');
    expect(PROFILE).not.toContain('Profile Synced');
  });

  it('ships no invented financial milestone badges', () => {
    expect(PROFILE).not.toContain('FinancialAchievementBadge');
    expect(PROFILE).not.toContain('perfect_settlement');
  });
});

describe('the P/L chart draws hand results, not wallet flow', () => {
  it('takes the daily series from the stats payload', () => {
    expect(PROFIT_CHART).toContain('series: DailyProfitPoint[]');
    expect(PROFIT_CHART).not.toContain("tx.type === 'credit'");
    expect(PROFILE).toContain('<LazyProfitChart series={stats.daily} />');
  });

  it('achievement progress uses the client definitions /achievements uses', () => {
    expect(PROFILE).toContain('achievementService.getUserAchievements(authUser.id)');
    expect(PROFILE).not.toContain('achievement:training_achievement_definitions(');
    expect(PROFILE).not.toContain('max_progress:threshold');
  });

  it('carries sessions and variants from the same payload', () => {
    expect(PROFILE).toContain('stats.sessions.slice(0, 5)');
    expect(PROFILE).toContain('stats.variants.length > 0');
  });
});

describe('the public dossier', () => {
  it('shows the public arena record and no meaningless level badge', () => {
    expect(PUBLIC_PROFILE).toContain("from('player_stats')");
    expect(PUBLIC_PROFILE).toContain('aggregateArenaRecord(data)');
    expect(PUBLIC_PROFILE).toContain('className={styles.publicProfileRecord}');
    expect(PUBLIC_PROFILE).not.toContain('Level {profile.level}');
    expect(PUBLIC_CSS).toContain('.publicProfileRecord');
  });

  it('keeps Report reachable while a player is blocked', () => {
    const reportAt = PUBLIC_PROFILE.indexOf('${styles.reportBtn}');
    const ternaryEnd = PUBLIC_PROFILE.indexOf('</>', PUBLIC_PROFILE.indexOf('{isBlocked ? ('));
    expect(reportAt).toBeGreaterThan(-1);
    expect(ternaryEnd).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(ternaryEnd);
  });

  it('carries no bare global class names that another stylesheet can win', () => {
    // Ten of this page's class names were also defined bare in 30+ other
    // stylesheets. With those chunks loaded, `.share-btn { position:absolute }`
    // took Share out of the action grid entirely. Hashed names end the class.
    expect(PUBLIC_PROFILE).not.toMatch(/className="/);
    expect(PUBLIC_PROFILE).toContain("from './PublicProfilePage.module.css'");
  });
});
