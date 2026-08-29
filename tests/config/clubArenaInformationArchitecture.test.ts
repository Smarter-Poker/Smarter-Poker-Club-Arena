import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLUB_ARENA_SUPPORT_NAV,
  getClubArenaNavigation,
  getClubNavigationCapabilities,
} from '../../src/config/clubArenaNavigation';
import {
  getActiveArenaSectionPath,
  getArenaSectionNavigation,
} from '../../src/config/arenaSectionNavigation';

describe('Club Arena information architecture', () => {
  it('keeps the global menu concise and free of retired aliases', () => {
    const items = getClubArenaNavigation({ clubId: null }).flatMap((group) => group.items);
    const paths = items.map((item) => item.path);

    expect(paths).toContain('/tournaments');
    expect(paths).toContain('/hand-history');
    expect(paths).toContain('/session-history');
    expect(paths).not.toContain('/tournament-lobby');
    expect(paths).not.toContain('/hands');
    expect(paths).not.toContain('/history');
    expect(paths).not.toContain('/messages/clubs');
    expect(paths).not.toContain('/invite');
    expect(paths).not.toContain('/waitlist');
    expect(paths.length).toBeLessThanOrEqual(24);
  });

  it('uses club-scoped operation routes when a club is active', () => {
    const items = getClubArenaNavigation({ clubId: 'shark-club', clubRole: 'owner' }).flatMap(
      (group) => group.items
    );
    const paths = items.map((item) => item.path);

    expect(paths).toContain('/clubs/shark-club/members');
    expect(paths).toContain('/clubs/shark-club/data');
    expect(paths).toContain('/clubs/shark-club/settings');
    expect(paths).toContain('/clubs/shark-club/agents');
    expect(paths).not.toContain('/agent-management');
    expect(paths).not.toContain('/data');
  });

  it('shows platform-only controls only to platform staff', () => {
    const playerPaths = getClubArenaNavigation({ clubId: null }).flatMap((group) =>
      group.items.map((item) => item.path)
    );
    const staffPaths = getClubArenaNavigation({ clubId: null, isPlatformStaff: true }).flatMap(
      (group) => group.items.map((item) => item.path)
    );

    expect(playerPaths).not.toContain('/house-ads');
    expect(playerPaths).not.toContain('/admin');
    expect(staffPaths).toContain('/house-ads');
    expect(staffPaths).toContain('/admin');
    expect(CLUB_ARENA_SUPPORT_NAV.map((item) => item.path)).toContain('/legal/privacy');
  });

  it('does not advertise operator tools to ordinary club members', () => {
    const paths = getClubArenaNavigation({ clubId: 'shark-club', clubRole: 'member' }).flatMap(
      (group) => group.items.map((item) => item.path)
    );

    expect(paths).toContain('/clubs/shark-club');
    expect(paths).not.toContain('/clubs/shark-club/members');
    expect(paths).not.toContain('/clubs/shark-club/data');
    expect(paths).not.toContain('/clubs/shark-club/settings');
    expect(paths).not.toContain('/clubs/shark-club/agents');
  });

  it('uses one fail-closed club capability matrix across navigation surfaces', () => {
    expect(getClubNavigationCapabilities('member')).toEqual({
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
    });
    expect(getClubNavigationCapabilities('agent')).toEqual({
      isClubStaff: true,
      canViewFinance: false,
      canControlClub: false,
    });
    expect(getClubNavigationCapabilities('super_agent')).toEqual({
      isClubStaff: true,
      canViewFinance: true,
      canControlClub: false,
    });
    expect(getClubNavigationCapabilities('owner')).toEqual({
      isClubStaff: true,
      canViewFinance: true,
      canControlClub: true,
    });
  });

  it('redirects legacy duplicate routes to their canonical destinations', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

    expect(appSource).toContain(
      'path="tournament-lobby" element={<Navigate to="/tournaments" replace />}'
    );
    expect(appSource).toContain('path="hands" element={<Navigate to="/hand-history" replace />}');
    expect(appSource).toContain('path="history" element={<Navigate to="/hand-history" replace />}');
    expect(appSource).toContain('path="session-history"');
  });

  it('resolves legacy operator entrances into a real club workspace', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const redirectSource = readFileSync(
      resolve(process.cwd(), 'src/components/navigation/LegacyClubToolRedirect.tsx'),
      'utf8'
    );

    expect(appSource).toContain(
      '<LegacyClubToolRedirect destination="agents" toolName="Agent Management" />'
    );
    expect(appSource).toContain(
      '<LegacyClubToolRedirect destination="members" toolName="Players" />'
    );
    expect(appSource).toContain(
      '<LegacyClubToolRedirect destination="data" toolName="Club Data" />'
    );
    expect(appSource).toContain(
      '<LegacyClubToolRedirect destination="invite" toolName="Club Invite" />'
    );
    expect(redirectSource).toContain("destination === 'invite'");
    expect(redirectSource).toContain('`/clubs/${target.id}/${destination}`');
    expect(redirectSource).toContain('{ replace: true }');
  });

  it('keeps sibling routes reachable through contextual section rails', () => {
    const rewards = getArenaSectionNavigation('/rakeback');
    const play = getArenaSectionNavigation('/tournaments/event-1');
    const union = getArenaSectionNavigation('/unions/union-1/statements');

    expect(rewards?.label).toBe('Rewards Circuit');
    expect(rewards?.items.map((item) => item.path)).toEqual(
      expect.arrayContaining(['/wallet', '/transactions', '/vip', '/bonuses', '/challenges'])
    );
    expect(play?.items.map((item) => item.path)).toContain('/session-history');
    expect(union?.items.map((item) => item.path)).toEqual([
      '/unions',
      '/unions/union-1',
      '/unions/union-1/games',
      '/unions/union-1/statements',
      '/unions/union-1/settlement',
    ]);
    const unionGames = getArenaSectionNavigation('/unions/union-1/games');
    expect(unionGames?.items.map((item) => item.path)).not.toContain('/unions/union-1/statements');
    expect(getActiveArenaSectionPath('/unions/union-1/games', unionGames?.items || [])).toBe(
      '/unions/union-1/games'
    );
  });

  it('does not duplicate the club rail or break the flush notifications page', () => {
    expect(getArenaSectionNavigation('/clubs/club-1/settings')).toBeNull();
    expect(getArenaSectionNavigation('/marketplace')).toBeNull();
    expect(getArenaSectionNavigation('/stats')).toBeNull();
    expect(getArenaSectionNavigation('/notifications')).toBeNull();
  });
});
