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
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 2026-09-05: AND THE LADDER ITSELF IS GONE
 *
 * `src/constants/vipTiers.ts` held six rungs - bronze, silver, gold, platinum,
 * diamond and an invented "royal" - each with a rakeback percentage (5 to 30),
 * a point multiplier (1x to 10x) and monthly tournament tickets. Three
 * components rendered it: VIPStatsHeader, TierProgressionCard and
 * VIPBenefitsGrid, which between them promised private high-stakes tables, 24/7
 * dedicated support and invitations to exclusive tournaments.
 *
 * NONE OF IT WAS IMPLEMENTED. The top rung was reachable, too: the largest
 * `vip_points.current_points` on production is 426,490 against a 150,000
 * threshold, so real members were being told they were Royal.
 *
 * Deleted with the constant, and with three unbacked allowances beside it:
 *
 *   leaderboardBoost 0.06   LeaderboardService applies no boost of any kind.
 *   themes 3                nothing reads it; Table Studio sells themes singly.
 *   clubCreation 3          fn_get_club_creation_eligibility caps EVERYONE at
 *                           4 club memberships. Not a VIP benefit, not 3.
 *
 * What a VIP gets is now exactly what the server meters: 100 rabbit hunts
 * (fn_consume_rabbit_hunt), 120 time-bank seconds (fn_time_bank_allowance),
 * 1,200 emojis and 1,000 tags (fn_increment_vip_usage), and three per-use
 * charges waived. VIP points remain real - 1,005 holders, 5.1M ledger rows -
 * they are simply not a tier.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
const VIP_SERVICE = strip(read('src/services/VIPService.ts'));
const VIP_PAGE = strip(read('src/pages/VIPPage.tsx'));
const VIP_MODAL = strip(read('src/components/vip/VIPCardsModal.tsx'));

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

describe('there is no tier ladder, and no rung of one survives', () => {
  it('the ladder constant is deleted, not merely unused', () => {
    expect(existsSync(resolve(ROOT, 'src/constants/vipTiers.ts'))).toBe(false);
    for (const gone of [
      'src/components/vip/TierProgressionCard.tsx',
      'src/components/vip/VIPBenefitsGrid.tsx',
      'src/components/vip/VIPStatsHeader.tsx',
      'src/components/vip/VIPStatusCard.tsx',
    ]) {
      expect(existsSync(resolve(ROOT, gone)), `${gone} is back`).toBe(false);
    }
  });

  it('no VIP surface names a rung', () => {
    // 'diamond' on its own is the CURRENCY and stays; these are the rung names.
    for (const [name, src] of [
      ['VIPService', VIP_SERVICE],
      ['VIPPage', VIP_PAGE],
      ['VIPCardsModal', VIP_MODAL],
    ] as const) {
      for (const rung of ['platinum', 'Platinum', 'royal', 'Royal', 'VIP Gold', 'VIP GOLD']) {
        expect(src, `${name} still says "${rung}"`).not.toContain(rung);
      }
    }
  });

  it('the allowances are only the ones the server meters', () => {
    expect(VIP_SERVICE).toContain('VIP_MONTHLY_ALLOWANCES');
    expect(VIP_SERVICE).not.toContain('VIP_GOLD_LIMITS');
    for (const unbacked of ['leaderboardBoost', 'clubCreation']) {
      expect(VIP_SERVICE, `${unbacked} is back`).not.toContain(unbacked);
    }
  });

  it('nothing promises an unlimited allowance', () => {
    // Dan 2026-09-04: "THERE IS NOTHING UNLIMITED LIKE THROWABLES OR TIME BANKS."
    expect(VIP_PAGE).not.toContain('Unlimited');
    expect(VIP_PAGE).not.toContain('All Packs');
    expect(VIP_PAGE).not.toContain('500 Free Throws');
  });
});
