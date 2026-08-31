import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const PROFILE = read('src/pages/ProfilePage.tsx');
const SETTINGS = read('src/pages/SettingsPage.tsx');
const NOTIFICATIONS = read('src/pages/NotificationsPage.tsx');
const PUBLIC_PROFILE = read('src/pages/PublicProfilePage.tsx');
const GLOBAL_HEADER = read('src/components/navigation/GlobalHeader.tsx');
const PROFILE_EDIT = read('src/components/social/UserProfileEdit.tsx');
const BLOCK_MODAL = read('src/components/social/PlayerBlockModal.tsx');

describe('Player Identity Vault information architecture', () => {
  it('keeps dedicated reward and analytics workspaces authoritative', () => {
    expect(PROFILE).toContain("path: '/stats'");
    expect(PROFILE).toContain("path: '/bonuses'");
    expect(PROFILE).toContain("path: '/challenges'");
    expect(PROFILE).toContain("path: '/leaderboard'");
    expect(PROFILE).toContain("path: '/promotions'");
    expect(PROFILE).not.toContain('import DailyBonusWheel from');
    expect(PROFILE).not.toContain('import GamificationLeaderboard from');
    expect(PROFILE).not.toContain('import PromotionsList from');
    expect(PROFILE).not.toContain('import PerformanceTrends from');
  });

  it('makes every retained profile panel directly addressable and keyboard navigable', () => {
    expect(PROFILE).toContain(
      "const PROFILE_TABS = ['stats', 'achievements', 'history', 'social']"
    );
    expect(PROFILE).toContain('role="tablist"');
    expect(PROFILE).toContain('role="tabpanel"');
    expect(PROFILE).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']");
    expect(PROFILE).toContain("next.set('tab', tab)");
  });

  it('removes the empty gameplay panel but keeps old deep links useful', () => {
    expect(SETTINGS).not.toContain('<h2>Gameplay</h2>');
    expect(SETTINGS).toContain("case 'gameplay':");
    expect(SETTINGS).toContain("case 'table':");
    expect(SETTINGS).toContain("return 'display';");
    expect(SETTINGS).toContain('data: dangerRef');
    expect(SETTINGS).toContain('activeSettingsSection === item.id');
    expect(SETTINGS).toContain('aria-label="Settings Sections"');
  });

  it('routes the global profile control to the local identity workspace', () => {
    expect(GLOBAL_HEADER).toContain("onClick={() => navigate('/profile')}");
    expect(GLOBAL_HEADER).not.toContain("navigateToHub('/hub/profile')");
  });
});

describe('Player Identity Vault interaction semantics', () => {
  it('uses native notification controls without nested interactive elements', () => {
    expect(NOTIFICATIONS).toContain("useState<'all' | 'unread'>('all')");
    expect(NOTIFICATIONS).toContain("aria-pressed={filter === 'unread'}");
    expect(NOTIFICATIONS).toContain('className="ca-notif__delete"');
    expect(NOTIFICATIONS).not.toContain("role={clickable ? 'button'");
    expect(NOTIFICATIONS).not.toContain('tabIndex={clickable ? 0');
  });

  it('names sensitive account dialogs and their fields', () => {
    expect(SETTINGS.match(/role="dialog"/g)).toHaveLength(3);
    expect(SETTINGS.match(/aria-modal="true"/g)).toHaveLength(3);
    expect(SETTINGS).toContain('htmlFor="settings-new-email"');
    expect(SETTINGS).toContain('htmlFor="settings-new-password"');
    expect(SETTINGS).toContain('autoComplete="one-time-code"');
  });

  it('makes public-profile drill-ins and all nested dialogs keyboard operable', () => {
    expect(PUBLIC_PROFILE).toContain('type="button"');
    expect(PUBLIC_PROFILE).toContain('className="mutual-friend-chip"');
    expect(PROFILE_EDIT).toContain('role="dialog"');
    expect(PROFILE_EDIT).toContain('aria-pressed={formData.avatarUrl === url}');
    expect(BLOCK_MODAL).toContain('role="dialog"');
    expect(BLOCK_MODAL).toContain('htmlFor={reasonId}');
  });

  it('accepts reciprocal friendship rows without a false single-row error', () => {
    expect(PUBLIC_PROFILE).toContain("friendshipRows.some((row) => row.status === 'accepted')");
    expect(PUBLIC_PROFILE).toContain("friendshipRows.find((row) => row.status === 'pending')");
    expect(PUBLIC_PROFILE).toContain('.limit(2)');
    expect(PUBLIC_PROFILE).not.toContain('.maybeSingle()');
  });
});

describe('#SmarterCasinoRealism account surfaces', () => {
  it('uses one shared cinematic vault anchor and engineered visual tokens', () => {
    const hero = read('src/components/account/AccountSurfaceHeader.module.css');
    const heroComponent = read('src/components/account/AccountSurfaceHeader.tsx');
    const profileCss = read('src/pages/ProfilePage.module.css');
    const settingsCss = read('src/pages/SettingsPage.module.css');
    const notificationsCss = read('src/pages/NotificationsPage.css');

    expect(heroComponent).toContain("mediaUrl('images/bg-vault.jpg')");
    expect(hero).toContain('#030609');
    expect(hero).toContain('#3aa8ff');
    expect(profileCss).toContain('--identity-gunmetal: #26333d');
    expect(settingsCss).toContain('--control-steel: #b9cad7');
    expect(notificationsCss).toContain('--notif-card: #080d12');
    expect([profileCss, settingsCss, notificationsCss].join('\n')).not.toContain(
      'backdrop-filter: blur(10px)'
    );
  });
});
