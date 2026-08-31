import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getClubNavigationCapabilities } from '../../src/config/clubArenaNavigation';
import {
  getClubOperationItems,
  getRequiredClubOperationAccess,
} from '../../src/config/clubOperationsNavigation';
import { getArenaSectionNavigation } from '../../src/config/arenaSectionNavigation';

describe('club workspace capability contract', () => {
  it.each([
    ['player', false, false, false],
    ['agent', true, false, false],
    ['manager', true, false, false],
    ['super_agent', true, true, false],
    ['admin', true, true, true],
    ['co_owner', true, true, true],
    ['owner', true, true, true],
  ])('%s receives the expected navigation capabilities', (role, staff, finance, control) => {
    expect(getClubNavigationCapabilities(role)).toEqual({
      isClubStaff: staff,
      canViewFinance: finance,
      canControlClub: control,
    });
  });

  it('fails closed for unknown roles and grants platform staff the full contract', () => {
    expect(getClubNavigationCapabilities('unknown')).toEqual({
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
    });
    expect(getClubNavigationCapabilities(null, true)).toEqual({
      isClubStaff: true,
      canViewFinance: true,
      canControlClub: true,
    });
  });

  it.each([
    ['/clubs/club-1/operations', 'staff'],
    ['/clubs/club-1/reports', 'staff'],
    ['/clubs/club-1/finance', 'finance'],
    ['/clubs/club-1/cashier', null],
    ['/clubs/club-1/insurance-report', 'finance'],
    ['/clubs/club-1/control', 'control'],
    ['/clubs/club-1/settings', 'control'],
    ['/clubs/club-1/promo-vault', null],
    ['/clubs/club-1/promotions', null],
    ['/clubs/club-1/rules', null],
    ['/clubs/club-1/lobby', null],
  ])('%s requires %s access', (path, access) => {
    expect(getRequiredClubOperationAccess(path)).toBe(access);
  });

  it('only advertises routes a role can open', () => {
    const player = getClubOperationItems('club-1', getClubNavigationCapabilities('player'));
    const agent = getClubOperationItems('club-1', getClubNavigationCapabilities('agent'));
    const finance = getClubOperationItems('club-1', getClubNavigationCapabilities('super_agent'));
    const owner = getClubOperationItems('club-1', getClubNavigationCapabilities('owner'));

    expect(player).toHaveLength(0);
    expect(agent.every((item) => item.access === 'staff')).toBe(true);
    expect(finance.some((item) => item.path.endsWith('/finance'))).toBe(true);
    expect(finance.some((item) => item.access === 'control')).toBe(false);
    expect(owner.some((item) => item.path.endsWith('/control'))).toBe(true);
  });
});

describe('consolidated route families', () => {
  it('makes overview routes the first stop in play, rewards, community, and legal rails', () => {
    expect(getArenaSectionNavigation('/play')?.items[0]).toEqual({
      label: 'Overview',
      path: '/play',
    });
    expect(getArenaSectionNavigation('/rewards')?.items[0]).toEqual({
      label: 'Overview',
      path: '/rewards',
    });
    expect(getArenaSectionNavigation('/legal')?.items).toContainEqual({
      label: 'Legal Center',
      path: '/legal',
    });
    expect(getArenaSectionNavigation('/community')?.items[0]).toEqual({
      label: 'Overview',
      path: '/community',
    });
  });

  it('keeps every union operations route reachable from the canonical union rail', () => {
    const paths = getArenaSectionNavigation('/unions/union-1/operations')?.items.map(
      (item) => item.path
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/unions/union-1',
        '/unions/union-1/games',
        '/unions/union-1/operations',
        '/unions/union-1/statements',
        '/unions/union-1/settlement',
      ])
    );
  });

  it('registers every new workspace without replacing legacy route handlers', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    for (const route of [
      'path="play"',
      'path="rewards"',
      'path="community"',
      'path="legal"',
      'path="clubs/:clubId/finance"',
      'path="clubs/:clubId/control"',
      'path="unions/:unionId/operations"',
      'path="union-dashboard"',
      'path="union-games"',
    ]) {
      expect(app).toContain(route);
    }
  });

  it('keeps the command drawer intelligent and permission-aware', () => {
    const menu = readFileSync('src/components/navigation/HamburgerMenu.tsx', 'utf8');
    expect(menu).toContain('Search Destinations Or The Arena');
    expect(menu).toContain('club_arena_nav_recents_v1');
    expect(menu).toContain('club_arena_nav_pins_v1');
    expect(menu).toContain('fetchQuickLinkClubs');
    expect(menu).toContain('attentionCount');
    expect(menu).toContain('workspace.canViewFinance');
  });
});
