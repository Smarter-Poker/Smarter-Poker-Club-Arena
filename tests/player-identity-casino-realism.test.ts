/**
 * PLAYER IDENTITY SURFACES — #SmarterCasinoRealism audit, 2026-09-04
 *
 * Profile, public profile, settings and notifications. Each assertion below
 * pins a bug that was live on 2026-09-04 or a rule Dan stated that day:
 *
 *   - "THERE IS NO SUCH THING AS 'PLATINUM VIP'. JUST VIP, AND LIFETIME VIP."
 *   - unlimited gameplay copy belongs only to the exact Lifetime VIP state;
 *   - the profile printed ROI as +1.6500000000000001% (no truncation);
 *   - the alias editor wrote `username` but the arena resolves `alias` first;
 *   - the edit dialog offered six dicebear avatars that were never saved;
 *   - the public profile showed `display_name` (can be a legal name) and the
 *     social photo, and drew its QR through api.qrserver.com;
 *   - settings wrote profiles.settings on every save and never read it back;
 *   - "Delete Account" signed the player out and deleted nothing.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveVipStatus, vipStatusLabel } from '../src/utils/vipStatus';
import { aliasProblem } from '../src/utils/aliasRules';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PROFILE = read('src/pages/ProfilePage.tsx');
const PROFILE_CODE = strip(PROFILE);
const PUBLIC = read('src/pages/PublicProfilePage.tsx');
const PUBLIC_CODE = strip(PUBLIC);
const SETTINGS = read('src/pages/SettingsPage.tsx');
const SETTINGS_CODE = strip(SETTINGS);
const NOTIFICATIONS = read('src/pages/NotificationsPage.tsx');
const EDIT = read('src/components/social/UserProfileEdit.tsx');
const PROFILE_SERVICE = read('src/services/ProfileService.ts');
const GAUGE = strip(read('src/components/common/CircularGauge.tsx'));

describe('VIP is VIP or Lifetime VIP, nothing else', () => {
  it('resolves the three real states from the three real columns', () => {
    expect(resolveVipStatus({ is_vip: false })).toBe('none');
    expect(resolveVipStatus(null)).toBe('none');
    expect(resolveVipStatus({ is_vip: true, vip_tier: 'lifetime' })).toBe('lifetime');
    expect(resolveVipStatus({ is_vip: true, vip_tier: 'Lifetime' })).toBe('vip');
    // A lifetime row with a stale expiry is still lifetime.
    expect(
      resolveVipStatus({
        is_vip: true,
        vip_tier: 'lifetime',
        vip_expires_at: '2020-01-01T00:00:00Z',
      })
    ).toBe('lifetime');
    expect(
      resolveVipStatus(
        { is_vip: true, vip_tier: 'monthly', vip_expires_at: '2030-01-01T00:00:00Z' },
        Date.parse('2026-09-04T00:00:00Z')
      )
    ).toBe('vip');
    expect(
      resolveVipStatus(
        { is_vip: true, vip_tier: 'monthly', vip_expires_at: '2026-01-01T00:00:00Z' },
        Date.parse('2026-09-04T00:00:00Z')
      )
    ).toBe('none');
    expect(vipStatusLabel('lifetime')).toBe('Lifetime VIP');
    expect(vipStatusLabel('vip')).toBe('VIP');
  });

  it('draws no tier ladder and gates unlimited copy on exact Lifetime VIP', () => {
    for (const ghost of [
      'VIP_TIERS',
      'VIPProgressRing',
      'VIPStatusCard',
      'Auto Time Bank',
      "'platinum'",
      "'bronze'",
    ]) {
      expect(PROFILE_CODE, `${ghost} is back on the profile`).not.toContain(ghost);
    }
    /* The benefits it does show are the VIP page's own constants, renamed on
       2026-09-05: there is no Gold, and the three entries with nothing behind
       them (leaderboardBoost, themes, clubCreation) went with the ladder. */
    expect(PROFILE).toContain('VIP_MONTHLY_ALLOWANCES.rabbitHunts');
    expect(PROFILE).toContain('VIP_MONTHLY_ALLOWANCES.timeBankSeconds');
    expect(PROFILE).toContain("user.vipStatus === 'lifetime'");
    expect(PROFILE).toContain("? 'Lifetime VIP Digital Benefits'");
    expect(PROFILE).toContain("? 'Digital Emoji Packs' : 'Emojis / Mo'");
    expect(PROFILE).toContain("? 'Digital Player Tag Packs' : 'Player Tags / Mo'");
    expect(PROFILE).toContain("? 'Unlimited'");
    expect(PROFILE_CODE).not.toContain('VIP_GOLD_LIMITS');
    expect(PROFILE_CODE).not.toContain('leaderboardBoost');
    expect(PROFILE).toContain('resolveVipStatus(profile)');
    expect(PUBLIC_CODE).not.toContain('VIP_LABELS');
    expect(PUBLIC).toContain('vipStatusLabel(profile.vipStatus)');
    expect(PROFILE_SERVICE).toContain('vipStatus: resolveVipStatus(data)');
  });
});

describe('no figure on the credential is rounded or fabricated', () => {
  it('truncates every percentage and amount', () => {
    expect(PROFILE_CODE).not.toMatch(/\.toFixed\(/);
    expect(PROFILE).toContain('Math.trunc(value * factor) / factor');
    expect(PROFILE).toContain('statsAvailable ? `${fixedTrunc(stats.vpip, 1)}%` : NO_DATA');
    expect(GAUGE).not.toContain('Math.round(animatedValue)');
  });

  it('shows the arena handle, not the raw username, as the credential title', () => {
    expect(PROFILE).toContain('{user.displayName}');
    expect(PROFILE_CODE).not.toMatch(/styles\.displayName\}>\s*\{user\.username\}/);
  });
});

describe('the alias editor writes what the arena reads', () => {
  it('updates alias and username together, and reports a taken handle', () => {
    expect(PROFILE).toContain('alias: data.username,');
    expect(PROFILE).toContain("error.code === '23505'");
  });

  it('shares one alias rule with the first-run modal', () => {
    expect(aliasProblem('ab')).toMatch(/at least 3/);
    expect(aliasProblem('a'.repeat(17))).toMatch(/16 characters/);
    expect(aliasProblem('king fish')).toMatch(/letters, numbers/i);
    expect(aliasProblem('KingFish')).toBeNull();
    expect(EDIT).toContain("from '../../utils/aliasRules'");
    expect(EDIT).not.toContain('api.dicebear.com');
    expect(PROFILE).toContain('<AvatarGallery');
    expect(PROFILE_CODE).not.toContain("window.open('https://smarter.poker/hub/avatars'");
  });
});

describe('the public credential is the felt view of a player', () => {
  it('resolves the arena name and arena avatar in the data layer', () => {
    expect(PROFILE_SERVICE).toContain("displayName: playerDisplayName(data, 'arena')");
    expect(PROFILE_SERVICE).toMatch(/arena_avatar_url as string \| null\) \|\|/);
  });

  it('renders the QR locally and reports a refused clipboard', () => {
    expect(PUBLIC).toContain("from 'qrcode.react'");
    expect(PUBLIC_CODE).not.toContain('qrserver');
    expect(PUBLIC).toContain('await navigator.clipboard.writeText(link)');
    expect(PUBLIC_CODE).not.toContain('(profile as any).achievements');
    expect(read('src/services/MessagingService.ts')).not.toContain('generateProfileQRData(');
  });
});

describe('settings round-trip and the account door', () => {
  it('reads the server copy back before it can overwrite it', () => {
    expect(SETTINGS).toContain(".select('settings').eq('id', authUser.id)");
    expect(SETTINGS).toContain(".select('tournament_reminders, friend_activity, club_updates')");
  });

  it('closes the account through the platform endpoint or not at all', () => {
    expect(SETTINGS).toContain("fetch('/api/auth/delete-account'");
    expect(SETTINGS).toContain("method: 'DELETE'");
    // Only a confirmed success signs the player out.
    const block = SETTINGS_CODE.slice(
      SETTINGS_CODE.indexOf("if (actionType === 'delete-account')"),
      SETTINGS_CODE.indexOf("} else if (actionType === 'disable-2fa')")
    );
    expect(block.indexOf('if (!res.ok')).toBeGreaterThan(-1);
    expect(block.indexOf('identityDNA.logout()')).toBeGreaterThan(block.indexOf('if (!res.ok'));
    expect(SETTINGS_CODE).not.toContain('Contact support@smarter.poker for full account deletion');
    expect(SETTINGS).toContain('onClick={handleSignOut}');
  });

  it('never leaves the export button stuck on a signed-out tab', () => {
    const exportFn = SETTINGS_CODE.slice(
      SETTINGS_CODE.indexOf('const handleExportData = async () => {'),
      SETTINGS_CODE.indexOf('const [confirmAction, setConfirmAction]')
    );
    expect(exportFn).toContain('} finally {');
    expect(exportFn).toContain('setActionLoading(false);');
  });
});

describe('notifications speak poker and load their own placeholder', () => {
  it('does not resolve the placeholder against the World Hub root', () => {
    expect(strip(NOTIFICATIONS)).not.toContain("'/default-avatar.png'");
    expect(NOTIFICATIONS).toContain('import.meta.env.BASE_URL');
    expect(NOTIFICATIONS).toContain('ca-notif__systemTile');
    expect(NOTIFICATIONS).not.toContain('When Someone Likes, Comments, Or Tags You');
    expect(NOTIFICATIONS).toContain('function dayBucket(');
    expect(NOTIFICATIONS).toContain('useVisibilityRefresh(() => refresh())');
  });
});

describe('every identity surface ships its own web-sized casino render', () => {
  const heroes = [
    ['identity-vault-hero-v1.webp', PROFILE],
    ['public-dossier-hero-v1.webp', PUBLIC],
    ['control-room-hero-v1.webp', SETTINGS],
    ['signal-desk-hero-v1.webp', NOTIFICATIONS],
  ] as const;

  it.each(heroes)(
    '%s exists, is under 150 KB, and is referenced through the media base',
    (file, src) => {
      const path = resolve(ROOT, 'public/images/account', file);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeLessThan(150_000);
      expect(src).toContain(`images/account/${file}`);
    }
  );

  it('keeps the account palette tokenised for the brushed-silver light mode', () => {
    for (const css of [
      'src/pages/ProfilePage.module.css',
      'src/pages/SettingsPage.module.css',
      'src/components/account/AccountSurfaceHeader.module.css',
    ]) {
      expect(read(css)).toContain(":global([data-theme='light'])");
    }
    /* 2026-09-05: this page became a CSS Module (PR #3077). `.action-btn`,
       `.share-btn`, `.vip-badge`, `.level-badge` and six more of its class
       names were bare globals that seven other stylesheets also define, and
       with those chunks loaded the Share button left the grid entirely
       (`.share-btn { position: absolute }` in the hand replayer). Hashed
       names make that impossible. The light-mode contract is unchanged, so
       the assertion follows the file. */
    expect(read('src/pages/PublicProfilePage.module.css')).toContain(
      ":global([data-theme='light']) .publicProfilePage"
    );
    expect(read('src/pages/NotificationsPage.css')).toContain("[data-theme='light'] .ca-notif");
    // The dead sibling stylesheets are gone, not lingering as a second owner.
    expect(existsSync(resolve(ROOT, 'src/pages/ProfilePage.css'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'src/pages/SettingsPage.css'))).toBe(false);
  });
});
