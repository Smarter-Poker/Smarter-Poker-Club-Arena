import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLUB_ARENA_SUPPORT_NAV,
  getClubArenaNavigation,
} from '../../src/config/clubArenaNavigation';
import { getArenaSectionNavigation } from '../../src/config/arenaSectionNavigation';

const appSource = readFileSync('src/App.tsx', 'utf8');
const declaredPatterns = [...appSource.matchAll(/\bpath="([^"]+)"/g)].map((match) => match[1]);

function normalizeTarget(target: string): string {
  const pathname = target.split(/[?#]/, 1)[0] || '/';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function routePatternMatches(pattern: string, target: string): boolean {
  const normalizedPattern = pattern === '*' ? '*' : normalizeTarget(pattern);
  if (normalizedPattern === '*') return false;
  const source = normalizedPattern
    .split('/')
    .map((segment) => {
      if (!segment) return '';
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}/?$`).test(normalizeTarget(target));
}

function expectDeclared(target: string) {
  if (normalizeTarget(target) === '/') return;
  expect(
    declaredPatterns.some((pattern) => routePatternMatches(pattern, target)),
    `${target} is advertised by retained navigation but has no App route`
  ).toBe(true);
}

describe('retained Club Arena navigation route contract', () => {
  it('keeps every global, contextual, staff, and support destination declared', () => {
    const contexts = [
      { clubId: null },
      { clubId: 'club-1', clubRole: 'member' },
      { clubId: 'club-1', clubRole: 'agent' },
      { clubId: 'club-1', clubRole: 'owner' },
      { clubId: 'club-1', clubRole: 'owner', isPlatformStaff: true },
    ] as const;

    const targets = new Set([
      ...contexts.flatMap((context) =>
        getClubArenaNavigation(context).flatMap((group) => group.items.map((item) => item.path))
      ),
      ...CLUB_ARENA_SUPPORT_NAV.map((item) => item.path),
    ]);

    targets.forEach(expectDeclared);
  });

  it('keeps every contextual rail destination declared for representative nested routes', () => {
    const routes = [
      '/play',
      '/tournaments/tournament-1',
      '/community',
      '/search',
      '/rewards',
      '/marketplace',
      '/profile',
      '/settings',
      '/help',
      '/legal/privacy',
      '/unions',
      '/unions/union-1/operations',
      '/unions/union-1/games',
    ];

    const targets = new Set(
      routes.flatMap(
        (route) => getArenaSectionNavigation(route)?.items.map((item) => item.path) || []
      )
    );

    targets.forEach(expectDeclared);
  });

  it('does not use duplicate destinations inside a navigation group', () => {
    for (const group of getClubArenaNavigation({
      clubId: 'club-1',
      clubRole: 'owner',
      isPlatformStaff: true,
    })) {
      const paths = group.items.map((item) => item.path);
      expect(new Set(paths).size, `${group.label} contains a duplicate destination`).toBe(
        paths.length
      );
    }
  });
});
