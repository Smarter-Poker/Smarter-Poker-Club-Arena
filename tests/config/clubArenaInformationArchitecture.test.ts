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
import {
  getActiveClubOperationPath,
  getClubOperationContext,
  getClubOperationGroups,
  getClubOperationRailItems,
} from '../../src/config/clubOperationsNavigation';
import { getClubIntegrityNavigation } from '../../src/config/clubIntegrityNavigation';

describe('Club Arena information architecture', () => {
  it('keeps the global menu concise and free of retired aliases', () => {
    const items = getClubArenaNavigation({ clubId: null }).flatMap((group) => group.items);
    const paths = items.map((item) => item.path);

    expect(paths).toContain('/tournaments');
    expect(paths).toContain('/play');
    expect(paths).toContain('/hand-history');
    expect(paths).toContain('/session-history');
    expect(paths).toContain('/community');
    expect(paths).not.toContain('/tournament-lobby');
    expect(paths).not.toContain('/hands');
    expect(paths).not.toContain('/history');
    expect(paths).not.toContain('/messages/clubs');
    expect(paths).not.toContain('/invite');
    expect(paths).not.toContain('/waitlist');
    expect(paths.length).toBeLessThanOrEqual(24);
  });

  it('consolidates club tools behind one club-scoped operations entrance', () => {
    const items = getClubArenaNavigation({ clubId: 'shark-club', clubRole: 'owner' }).flatMap(
      (group) => group.items
    );
    const paths = items.map((item) => item.path);

    expect(paths).toContain('/clubs/shark-club/operations');
    expect(paths).not.toContain('/clubs/shark-club/members');
    expect(paths).not.toContain('/clubs/shark-club/data');
    expect(paths).not.toContain('/clubs/shark-club/settings');
    expect(paths).not.toContain('/clubs/shark-club/agents');
    expect(paths).not.toContain('/agent-management');
    expect(paths).not.toContain('/data');

    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(appSource).toContain('path="clubs/:clubId/operations"');
    expect(appSource).toContain('<ClubOperationsPage />');
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
    expect(CLUB_ARENA_SUPPORT_NAV.map((item) => item.path)).toEqual([
      '/help',
      '/legal',
      '/legal/fair-gaming',
      '/legal/tos',
      '/legal/privacy',
      '/legal/promotions',
    ]);
  });

  it('does not advertise operator tools to ordinary club members', () => {
    const paths = getClubArenaNavigation({ clubId: 'shark-club', clubRole: 'member' }).flatMap(
      (group) => group.items.map((item) => item.path)
    );

    expect(paths).toContain('/clubs/shark-club');
    expect(paths).not.toContain('/clubs/shark-club/operations');
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

    expect(appSource).toContain('destination="agents"');
    expect(appSource).toContain('destination="members"');
    expect(appSource).toContain('destination="data"');
    expect(appSource).toContain('destination="invite"');
    expect(redirectSource).toContain("destination === 'invite'");
    expect(redirectSource).toContain('`/clubs/${target.id}/${destination}`');
    expect(redirectSource).toContain('{ replace: true }');
    expect(redirectSource).toContain('readCachedQuickLinkClubs()');
    expect(redirectSource).toContain('CLUB_RESOLUTION_TIMEOUT_MS');
  });

  it('keeps sibling routes reachable through contextual section rails', () => {
    const rewards = getArenaSectionNavigation('/rakeback');
    const community = getArenaSectionNavigation('/community');
    const play = getArenaSectionNavigation('/tournaments/event-1');
    const union = getArenaSectionNavigation('/unions/union-1/statements');

    expect(rewards?.label).toBe('Rewards Circuit');
    expect(rewards?.items.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        '/wallet',
        '/transactions',
        '/vip',
        '/bonuses',
        '/challenges',
        '/marketplace',
      ])
    );
    expect(community?.items[0]).toEqual({ label: 'Overview', path: '/community' });
    expect(community?.items.map((item) => item.path)).toEqual(
      expect.arrayContaining(['/search', '/friends', '/messages', '/unions'])
    );
    expect(play?.items.map((item) => item.path)).toContain('/session-history');
    expect(play?.items[0]).toEqual({ label: 'Overview', path: '/play' });
    expect(union?.items.map((item) => item.path)).toEqual([
      '/unions',
      '/unions/union-1',
      '/unions/union-1/games',
      '/unions/union-1/operations',
      '/unions/union-1/statements',
      '/unions/union-1/settlement',
    ]);
    const unionGames = getArenaSectionNavigation('/unions/union-1/games');
    expect(unionGames?.items.map((item) => item.path)).not.toContain('/unions/union-1/statements');
    expect(getActiveArenaSectionPath('/unions/union-1/games', unionGames?.items || [])).toBe(
      '/unions/union-1/games'
    );
  });

  it('builds one permission-aware club operations workspace without changing deep links', () => {
    const ownerAccess = getClubNavigationCapabilities('owner');
    const ownerGroups = getClubOperationGroups('shark-club', ownerAccess);
    const ownerPaths = ownerGroups.flatMap((group) => group.items.map((item) => item.path));

    expect(ownerGroups.map((group) => group.label)).toEqual([
      'People & Safety',
      'Finance & Risk',
      'Club Control',
    ]);
    expect(ownerPaths).toEqual(
      expect.arrayContaining([
        '/clubs/shark-club/dashboard-full',
        '/clubs/shark-club/members',
        '/clubs/shark-club/reports',
        '/clubs/shark-club/disputes',
        '/clubs/shark-club/data',
        '/clubs/shark-club/financials',
        '/clubs/shark-club/settlement',
        '/clubs/shark-club/insurance-report',
        '/clubs/shark-club/announcements',
        '/clubs/shark-club/rules',
        '/clubs/shark-club/settings',
      ])
    );
    expect(new Set(ownerPaths).size).toBe(ownerPaths.length);

    const agentGroups = getClubOperationGroups(
      'shark-club',
      getClubNavigationCapabilities('agent')
    );
    const agentPaths = agentGroups.flatMap((group) => group.items.map((item) => item.path));
    expect(agentPaths).toContain('/clubs/shark-club/reports');
    expect(agentPaths).toContain('/clubs/shark-club/announcements');
    expect(agentPaths).not.toContain('/clubs/shark-club/data');
    expect(agentPaths).not.toContain('/clubs/shark-club/settings');
  });

  it('recognizes nested club operation routes and selects one current rail item', () => {
    const items = getClubOperationRailItems('shark-club', getClubNavigationCapabilities('owner'));

    expect(getClubOperationContext('/clubs/shark-club/members/player-1/statistics')).toBe(
      'shark-club'
    );
    expect(getClubOperationContext('/clubs/shark-club/lobby')).toBeNull();
    expect(getClubOperationContext('/clubs/shark-club/create-table')).toBeNull();
    expect(getActiveClubOperationPath('/clubs/shark-club/members/player-1', items)).toBe(
      '/clubs/shark-club/members'
    );
  });

  it('does not duplicate the club rail or break the flush notifications page', () => {
    expect(getArenaSectionNavigation('/clubs/club-1/settings')).toBeNull();
    expect(getArenaSectionNavigation('/marketplace')?.label).toBe('Rewards Circuit');
    expect(getArenaSectionNavigation('/stats')).toBeNull();
    expect(getArenaSectionNavigation('/notifications')).toBeNull();
    expect(getArenaSectionNavigation('/profile')?.label).toBe('Player Identity');
    expect(getArenaSectionNavigation('/profile/player-1')).toBeNull();
  });

  it('connects conduct reports, financial disputes, and exclusions as one permission-aware workflow', () => {
    const agentItems = getClubIntegrityNavigation(
      'shark-club',
      getClubNavigationCapabilities('agent')
    );
    const ownerItems = getClubIntegrityNavigation(
      'shark-club',
      getClubNavigationCapabilities('owner')
    );
    const memberItems = getClubIntegrityNavigation(
      'shark-club',
      getClubNavigationCapabilities('member')
    );

    expect(agentItems.map((item) => item.path)).toEqual([
      '/clubs/shark-club/reports',
      '/clubs/shark-club/disputes',
    ]);
    expect(ownerItems.map((item) => item.path)).toEqual([
      '/clubs/shark-club/reports',
      '/clubs/shark-club/disputes',
      '/clubs/shark-club/blacklist',
    ]);
    expect(memberItems).toEqual([]);
  });
});
