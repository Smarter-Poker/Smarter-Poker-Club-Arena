/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  VIP IS NOT A LADDER, AND `profiles.tier` IS NOT VIP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04, verbatim: "THERE IS NO SUCH THING AS 'PLATINUM VIP' BTW.
 * JUST VIP, AND LIFETIME VIP." And: "THERE IS NOTHING UNLIMITED LIKE
 * THROWABLES OR TIME BANKS."
 *
 * WHAT THIS LAW IS ACTUALLY ABOUT
 *
 * `profiles.tier` holds the literal string 'Newcomer' on all 1,310 production
 * rows. AuthPage writes it once at signup and nothing ever updates it. It is
 * not a VIP column and never was. But five separate places read it as one, and
 * because 'Newcomer' matches none of their cases, each failed in a DIFFERENT
 * direction - which is why nobody noticed for months:
 *
 *   - CompleteProfileModal gated the VIP avatar collection on
 *     `vip_level !== 'bronze'`. 'Newcomer' !== 'bronze' is TRUE, so the gate
 *     stood OPEN for 1,310 of 1,310 accounts. Measured 2026-09-05.
 *   - LeaderboardService set `isVIP: tier === 'gold' | 'platinum' | 'diamond'`,
 *     which is FALSE for everyone, so 0 of 1,032 real VIP members could ever
 *     see the badge.
 *   - LeaderboardService and FriendListPanel both passed `tier` on to
 *     PlayerAvatar as `vipTier`, whose gate is `vipTier !== 'bronze'` - true
 *     again, so every row rendered a `tier-Newcomer` ring, a class with no
 *     rule in PlayerAvatar.css. An invisible element, for every player.
 *
 * One dead column, one gate wide open, one badge nobody could earn.
 *
 * VIP is three columns: `is_vip`, `vip_tier` ('lifetime' | 'monthly' | null)
 * and `vip_expires_at`, resolved by `src/utils/vipStatus.ts` and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveVipStatus } from '../src/utils/vipStatus';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** Comments explain the bug and quote the old code; assertions read CODE. */
const strip = (s: string) =>
  s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const USER_STORE = strip(read('src/stores/useUserStore.ts'));
const COMPLETE_PROFILE = strip(read('src/components/modals/CompleteProfileModal.tsx'));
const LEADERBOARD = strip(read('src/services/LeaderboardService.ts'));
const FRIEND_LIST = strip(read('src/components/social/FriendListPanel.tsx'));
const STREAK = strip(read('src/components/gamification/StreakMultiplier.tsx'));
const PROFILE = strip(read('src/pages/ProfilePage.tsx'));

describe('the VIP resolver is the only answer to "is this player a VIP"', () => {
  it('reads the three real columns and treats lifetime as never expiring', () => {
    expect(resolveVipStatus({ is_vip: false, vip_tier: 'lifetime' })).toBe('none');
    expect(resolveVipStatus({ is_vip: true, vip_tier: 'lifetime' })).toBe('lifetime');
    // Production stores 2099-12-31 on 692 lifetime rows. A sentinel is not an
    // expiry, and reading it as one would strip a paid member of everything.
    expect(
      resolveVipStatus({
        is_vip: true,
        vip_tier: 'lifetime',
        vip_expires_at: '2099-12-31T00:00:00Z',
      })
    ).toBe('lifetime');
  });

  it('never treats profiles.tier as a membership', () => {
    // The exact production shape. Every gate below used to compare against it.
    const newcomer = { is_vip: false, vip_tier: null, vip_expires_at: null };
    expect(resolveVipStatus(newcomer)).toBe('none');
  });
});

describe('no entitlement is gated on profiles.tier', () => {
  it('the user store carries a resolved status, and marks tier as legacy', () => {
    expect(USER_STORE).toContain('vip_status: resolveVipStatus(data)');
    expect(USER_STORE).toContain('is_vip, vip_tier, vip_expires_at');
  });

  it('the VIP avatar collection is gated on the real membership', () => {
    expect(COMPLETE_PROFILE).toContain(
      "isVip={user.vip_status === 'vip' || user.vip_status === 'lifetime'}"
    );
    // The comparison that stood open for every account on the platform.
    expect(COMPLETE_PROFILE).not.toContain("vip_level !== 'bronze'");
  });

  it('the leaderboard badge can be earned, and the ring is not painted for everyone', () => {
    expect(LEADERBOARD).toContain("resolveVipStatus(profile) !== 'none'");
    expect(LEADERBOARD).not.toContain("profile.tier === 'gold'");
    expect(LEADERBOARD).not.toContain('vipTier: profile.tier');
    expect(FRIEND_LIST).not.toContain('p?.tier as VipTier');
  });

  it('neither list still asks the database for the dead column', () => {
    expect(LEADERBOARD).not.toMatch(/avatar_url:arena_avatar_url, level, tier/);
    expect(FRIEND_LIST).not.toMatch(/avatar_url, level, tier/);
  });
});

describe('nothing advertises a reward the platform does not pay', () => {
  it('the streak badge cannot claim an earnings multiplier', () => {
    // `1 + streak * 0.1` in the JSX printed "1.8x Earnings" beside the
    // player's name for an 8-day streak. Nothing anywhere pays it.
    expect(PROFILE).not.toContain('multiplier={1 + dailyStreak');
    expect(STREAK).not.toContain('Earnings');
    // Removed rather than defaulted: a prop with no honest source is an
    // invitation for the next caller to invent one.
    expect(STREAK).not.toMatch(/multiplier\??:\s*number/);
  });
});
