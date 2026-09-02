/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NAVIGATION SURFACES LAW (Dan 2026-08-30, phase 2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "THE FIRST LETTER OF EVERY WORD INSIDE THE HAMBURGER MENU MUST BE
 * CAPITALIZED. AS WELL AS EVERY CLICKABLE PAGE AND SUBPAGE." and "MAKE SURE
 * EVERY PAGE AND SUBPAGE IS FULLY BUILD OUT AND ACTUALLY CONNECTED AND
 * FUNCTIONAL."
 *
 * tests/unit/hamburgerMenuLaw.test.ts pinned those two rules for ONE surface.
 * Club Arena has six that render clickable destinations from a registry:
 *
 *   HamburgerMenu · ArenaSectionRail · ClubOperationsRail
 *   QuickActionsBar · ClubBottomNav
 *
 * (A sixth, Breadcrumbs, was listed here until 2026-08-31. It took its labels
 * from callers, so the source gate could not reach it - and it turned out to
 * have had NO callers in its entire history, along with SideNav and NavItem
 * and the barrel that exported all three. The hole was closed by deleting the
 * dead cluster rather than by casing code nobody runs.)
 *
 * Every one of them renders its copy through an expression (`{item.label}`),
 * and check-title-case.mjs states in its own header that it does not inspect
 * expressions because "their values are cased at their source". Nothing held
 * the source end of that promise, so 55 label/description/eyebrow literals
 * across the three navigation registries had never been Title Cased by
 * anything. scripts/ci/check-nav-title-case.mjs is that missing half; these
 * tests pin the law it enforces and the route-connectivity half beside it.
 *
 * Route connectivity is asserted by CALLING the registry builders, not by
 * reading their source: two of the three compose paths from a template
 * (`/clubs/${clubId}/${suffix}`), so a source-text audit reports them as
 * unresolvable and proves nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  getClubArenaNavigation,
  CLUB_ARENA_SUPPORT_NAV,
  type ClubNavigationCapabilities,
} from '../../src/config/clubArenaNavigation';
import { getArenaSectionNavigation } from '../../src/config/arenaSectionNavigation';
import { getClubOperationItems } from '../../src/config/clubOperationsNavigation';
import { getClubIntegrityNavigation } from '../../src/config/clubIntegrityNavigation';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const APP = read('src/App.tsx');
const GATE = read('scripts/ci/check-nav-title-case.mjs');
const PRE_PUSH = read('.husky/pre-push');
const CI = read('.github/workflows/ci.yml');
const ALL_GATES = read('scripts/ci/all-gates.sh');

/** Route patterns declared in App.tsx, leading slash stripped. */
const DECLARED = [...APP.matchAll(/path="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));

function resolvesToRoute(navPath: string): boolean {
  const clean = navPath.split('?')[0].replace(/^\//, '').replace(/\/+$/, '');
  if (clean === '') return APP.includes('path="/"');
  const nav = clean.split('/');
  return DECLARED.some((pattern) => {
    const segs = pattern.split('/');
    if (segs.length !== nav.length) return false;
    return segs.every((s, i) => s.startsWith(':') || s === '*' || s === nav[i]);
  });
}

/** The gate's own casing rule, mirrored so the test fails on real drift. */
const ACRONYMS = new Set([
  'nlh',
  'nlhe',
  'plo',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flh',
  'flo',
  'ofc',
  'nl',
  'pl',
  'fl',
  'sng',
  'mtt',
  'xmtt',
  'pko',
  'ko',
  'gtd',
  'hu',
  'wsop',
  'bbj',
  'vip',
  'id',
  'utg',
  'sb',
  'bb',
  'btn',
  'co',
  'mp',
  'hj',
  'lj',
  'rit',
  'gto',
  'ev',
  'roi',
  'itm',
  'usd',
  'kyc',
  'tos',
  'faq',
  'api',
  'url',
  'pc',
  'ios',
  'os',
  'ui',
  'ux',
  'qr',
  'sms',
  'otp',
  '2fa',
]);

function titleCased(text: string): string {
  return text.replace(/[A-Za-z][A-Za-z0-9'’]*/g, (word, offset: number, whole: string) => {
    if (whole.slice(Math.max(0, offset - 1), offset) === '&') return word;
    if (/^[0-9]/.test(word)) return word;
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (word.length > 1 && word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

const CAPS: ClubNavigationCapabilities = {
  isClubStaff: true,
  canViewFinance: true,
  canControlClub: true,
};

/** Every destination every registry can produce, at maximum permission. */
function everyDestination(): Array<{ surface: string; label: string; path: string }> {
  const out: Array<{ surface: string; label: string; path: string }> = [];

  for (const group of getClubArenaNavigation({
    clubId: 'sample-club',
    clubRole: 'owner',
    isPlatformStaff: true,
  })) {
    for (const item of group.items) {
      if (item.external) continue; // World Hub Messenger, not this SPA's router
      out.push({ surface: 'hamburger', label: item.label, path: item.path });
    }
  }
  for (const item of CLUB_ARENA_SUPPORT_NAV) {
    out.push({ surface: 'hamburger/support', label: item.label, path: item.path });
  }

  // One probe per route family the section rail recognises, plus both union
  // shapes (the owner workspace exposes three extra financial destinations).
  for (const probe of [
    '/play',
    '/community',
    '/wallet',
    '/profile',
    '/help',
    '/unions',
    '/unions/u1',
    '/unions/u1/games',
  ]) {
    const section = getArenaSectionNavigation(probe);
    if (!section) continue;
    for (const item of section.items) {
      out.push({ surface: `rail:${section.id}`, label: item.label, path: item.path });
    }
  }

  for (const item of getClubOperationItems('sample-club', CAPS)) {
    out.push({ surface: 'operations', label: item.label, path: item.path });
  }
  for (const item of getClubIntegrityNavigation('sample-club', CAPS)) {
    out.push({ surface: 'integrity', label: item.label, path: item.path });
  }

  return out;
}

const DESTINATIONS = everyDestination();

describe('every navigation destination is connected to a real route', () => {
  it('produces destinations from every registry, so this suite is not vacuous', () => {
    // A builder that silently returns [] would make every assertion below pass.
    expect(DESTINATIONS.length).toBeGreaterThan(50);
    for (const surface of ['hamburger', 'operations', 'integrity', 'rail:play', 'rail:union']) {
      expect(
        DESTINATIONS.some((d) => d.surface === surface),
        `no destinations collected for ${surface}`
      ).toBe(true);
    }
  });

  it('every destination resolves to a route declared in App.tsx', () => {
    const dead = DESTINATIONS.filter((d) => !resolvesToRoute(d.path));
    expect(
      dead,
      `dead navigation links:\n${dead.map((d) => `  [${d.surface}] ${d.label} -> ${d.path}`).join('\n')}`
    ).toEqual([]);
  });
});

describe('every navigation label is Title Cased at its source', () => {
  it('no label rendered by any surface is left uncased', () => {
    const bad = DESTINATIONS.filter((d) => titleCased(d.label) !== d.label);
    expect(
      bad,
      `labels not Title Cased:\n${bad.map((d) => `  [${d.surface}] "${d.label}"`).join('\n')}`
    ).toEqual([]);
  });

  it('descriptions are cased too - they are menu copy, not code comments', () => {
    const withDescriptions = [
      ...getClubArenaNavigation({ clubId: 'c', clubRole: 'owner', isPlatformStaff: true }).flatMap(
        (g) => g.items
      ),
      ...CLUB_ARENA_SUPPORT_NAV,
      ...getClubOperationItems('c', CAPS),
      ...getClubIntegrityNavigation('c', CAPS),
    ];
    expect(withDescriptions.length).toBeGreaterThan(30);
    const bad = withDescriptions.map((i) => i.description).filter((d) => d && titleCased(d) !== d);
    expect(bad, `descriptions not Title Cased:\n${bad.join('\n')}`).toEqual([]);
  });
});

describe('the source-side gate exists and actually runs', () => {
  it('covers every registry AND the two components that inline their own', () => {
    for (const registry of [
      'src/config/clubArenaNavigation.ts',
      'src/config/arenaSectionNavigation.ts',
      'src/config/clubOperationsNavigation.ts',
      'src/config/clubIntegrityNavigation.ts',
      'src/components/navigation/QuickActionsBar.tsx',
      'src/components/club/ClubBottomNav.tsx',
    ]) {
      expect(GATE, `${registry} must be in the gate's scope`).toContain(registry);
    }
    // label alone is not the rule: descriptions and eyebrows are menu copy too.
    expect(GATE).toMatch(/KEYS = new Set\(\['label', 'description', 'eyebrow'\]\)/);
  });

  it('is wired into every place the sibling copy gates are wired', () => {
    // A gate nothing invokes is a file, not a gate. check-title-case ran ONLY
    // in the local hook until 2026-08-22 and main went red three times in one
    // day because API-side pushes never touched it.
    expect(PRE_PUSH).toContain('node scripts/ci/check-nav-title-case.mjs');
    expect(CI).toContain('node scripts/ci/check-nav-title-case.mjs');
    expect(ALL_GATES).toContain('check-nav-title-case');
  });

  it('shares one definition of Title Case with the sibling gate', () => {
    // Two gates that disagree about the rule would each undo the other's fix
    // forever. The acronym list is the part most likely to drift apart.
    const sibling = read('scripts/ci/check-title-case.mjs');
    const acronymsOf = (src: string) =>
      src.slice(src.indexOf('const ACRONYMS'), src.indexOf(']);', src.indexOf('const ACRONYMS')));
    expect(acronymsOf(GATE).replace(/\s+/g, ' ')).toBe(acronymsOf(sibling).replace(/\s+/g, ' '));
  });
});
