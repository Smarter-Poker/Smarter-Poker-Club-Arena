/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY ROUTE IS REACHABLE — THE INVERSE AUDIT (Dan 2026-08-30, phase 2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "MAKE SURE EVERY PAGE AND SUBPAGE IS FULLY BUILD OUT AND ACTUALLY
 * CONNECTED AND FUNCTIONAL."
 *
 * `navigationSurfacesLaw.test.ts` proves every MENU ENTRY reaches a real
 * route. That is one direction, and it passes. This file asserts the OTHER
 * direction, which did not: every declared ROUTE must be reachable from
 * somewhere a player can click.
 *
 * Measured when this was written: 126 declared routes, 91 reachable, 35 not.
 * Nine of the unreachable ones are finished, substantial pages - UnionDashboard
 * is 3,105 lines, AgentDashboard 1,544, PlayerSessions 1,482, AntiCheat 1,175 -
 * that a player can only open by typing the URL. That is ~9,900 lines of built
 * product with no door.
 *
 * WHY THIS IS A RATCHET, NOT A PASS/FAIL
 *
 * Connecting or retiring those pages is a PRODUCT decision (which nav surface,
 * which permission, or retire it), not something a test should invent. So the
 * current 35 are listed below with an honest reason each, and the test asserts
 * two things:
 *
 *   1. NO NEW ORPHANS. A route added without a way in fails immediately, at the
 *      moment the person who added it is still holding the context.
 *   2. NO STALE ALLOWLIST. Every entry must still be a declared, still-orphaned
 *      route. Connect one and its entry must be deleted in the same change, so
 *      the list can only ever shrink.
 *
 * REACHABILITY IS COMPUTED, NOT ASSUMED. The reachable set is the union of the
 * navigation registries (CALLED, because two compose paths from templates that
 * no regex can resolve) and every navigate() / to= / href= target in src/. A
 * static scan alone reports 85 reachable; calling the builders finds 91. The
 * six-route difference is exactly the club-operations family built through
 * `clubPath('/finance')`, which is why this cannot be done by grep.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import {
  getClubArenaNavigation,
  CLUB_ARENA_SUPPORT_NAV,
  type ClubNavigationCapabilities,
} from '../../src/config/clubArenaNavigation';
import { getArenaSectionNavigation } from '../../src/config/arenaSectionNavigation';
import { getClubOperationItems } from '../../src/config/clubOperationsNavigation';
import { getClubIntegrityNavigation } from '../../src/config/clubIntegrityNavigation';

const ROOT = resolve(__dirname, '../../');
const APP = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
const DECLARED = [...APP.matchAll(/path="([^"]+)"/g)]
  .map((m) => m[1].replace(/^\//, ''))
  .filter((p) => p && p !== '*');

const CAPS: ClubNavigationCapabilities = {
  isClubStaff: true,
  canViewFinance: true,
  canControlClub: true,
};

/**
 * Routes with no click path, each with the reason it is acceptable — or, where
 * it is NOT acceptable, an explicit marker that it is queued work.
 *
 * `ORPHANED PRODUCT PAGE` entries are real features with no door. They are
 * listed so the ratchet holds while they are worked, NOT because the situation
 * is fine. Deleting an entry (by connecting or retiring the page) is the goal.
 */
const ALLOWED_ORPHANS: Record<string, string> = {
  // ── Entry points that arrive from OUTSIDE the app ────────────────────────
  'share/hand/:handId':
    'external share URL - ShareableHighlight builds it for links sent off-platform',
  'clubs/create': 'legacy redirect to /?create=club, kept so old links resolve',

  // ── Developer and diagnostic surfaces, never advertised to players ───────
  replay: 'developer hand-replayer harness',
  sim: 'developer simulation harness',
  'dev/footer': 'developer showcase',
  'dev/customization': 'developer showcase',
  'dev/bus': 'developer bus inspector',
  'dev/club-ui': 'developer component showcase',
  'dev/game-cards': 'developer component showcase',
  health: 'diagnostic endpoint, probed by monitoring not by people',
  engine: 'diagnostic endpoint, probed by monitoring not by people',
  'stats/:userId': 'intentional owner-privacy boundary retained for old bookmarks',

  // ── LEGACY REDIRECTS — no page here, only a door that forwards ───────────
  //
  // These were all filed as ORPHANED PRODUCT PAGE until Phase 7 read what they
  // actually render. Not one of them is a page. They are compatibility
  // entrances: an old URL arrives, something resolves where it should go now,
  // and the visitor is forwarded. Being unreachable from navigation is the
  // POINT - nothing should link to a legacy URL. The old reasons were not just
  // vague, one was false: `agent-management` was recorded as "renders
  // RateAuditPage", which it has not done for some time.
  'tournament-lobby': 'legacy redirect to /tournaments',
  history: 'legacy redirect to /hand-history',
  hands: 'legacy redirect to /hand-history',
  'notification-center':
    'retired 2026-08-25 (Dan: "we need ONE DISPLAY") - redirects to /notifications',
  'messages/new': 'legacy redirect to the World Hub messenger, carrying the compose target',
  'messages/clubs': 'legacy redirect to the World Hub messenger',
  'messages/clubs/:conversationId':
    'legacy redirect to the World Hub messenger, carrying the conversation',
  'clubs/:clubId/messages': 'legacy redirect to the World Hub messenger, carrying the club',
  'agent-management': 'LegacyClubToolRedirect - resolves a club and forwards to its agents page',
  players: 'LegacyClubToolRedirect - resolves a club and forwards to its members page',
  data: 'LegacyClubToolRedirect - resolves a club and forwards to its data page',
  invite: 'LegacyClubToolRedirect - resolves a club and forwards to /invite/:clubId',
  'anti-cheat':
    'LegacyClubToolRedirect - the club-scoped clubs/:clubId/anti-cheat is the linked one (phase 7)',

  // ── RETIRED IN PHASE 7 — a second door onto something already reachable ──
  //
  // Each of these rendered a real page, and every one of those pages is still
  // served somewhere a player can actually get to. What was orphaned was the
  // duplicate URL, not the product. They are redirects now rather than
  // deletions so that bookmarks and old push payloads still land.
  'rakeback-dashboard': 'retired phase 7 - second rakeback display, redirects to /rakeback',
  'player-sessions':
    'retired phase 7 - global twin of clubs/:clubId/members, forwards through LegacyClubToolRedirect',
  waitlist: 'retired phase 7 - the queue is joined from the lobby and table, redirects to /',
  'union-dashboard':
    'retired phase 7 - UnionDashboardPage serves at unions/:unionId/operations, redirects to /unions',
  'union-games':
    'retired phase 7 - UnionGamesPage serves at unions/:unionId/games, redirects to /unions',
  'clubs/:clubId/dashboard':
    'retired phase 7 - rendered the same ClubDataPage as clubs/:clubId/data, redirects there',

  // ── ORPHANED PRODUCT PAGES — real features with no door ──────────────────
  //
  // What is left after Phase 7 read the other twenty-two. Both are built,
  // player-facing game modes whose launch is a product decision rather than a
  // wiring one, and Dan has them parked (2026-08-31) rather than connected or
  // retired. Deleting an entry - by connecting or retiring the page - is still
  // the goal.
  xmtt: 'ORPHANED PRODUCT PAGE - XMTTPage, 551 lines, cross-club tournaments, parked by Dan',
  'flash-pool':
    'ORPHANED PRODUCT PAGE - FlashPoolPage, 450 lines, fast-fold lobby, 4 pools exist, parked by Dan',
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(tsx|ts)$/.test(entry)) acc.push(p);
  }
  return acc;
}

/** Everything a player can be sent to: registries CALLED, plus every link. */
function reachableTargets(): Set<string> {
  const targets = new Set<string>();

  for (const g of getClubArenaNavigation({
    clubId: 'C',
    clubRole: 'owner',
    isPlatformStaff: true,
  })) {
    for (const i of g.items) targets.add(i.path);
  }
  for (const i of CLUB_ARENA_SUPPORT_NAV) targets.add(i.path);
  for (const probe of [
    '/play',
    '/community',
    '/wallet',
    '/profile',
    '/help',
    '/unions',
    '/unions/U',
    '/unions/U/games',
  ]) {
    const s = getArenaSectionNavigation(probe);
    if (s) for (const i of s.items) targets.add(i.path);
  }
  for (const i of getClubOperationItems('C', CAPS)) targets.add(i.path);
  for (const i of getClubIntegrityNavigation('C', CAPS)) targets.add(i.path);

  for (const f of walk(join(ROOT, 'src')).filter((f) => !f.endsWith('App.tsx'))) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/navigate\(\s*[`'"]([^`'"]+)[`'"]/g)) targets.add(m[1]);
    for (const m of s.matchAll(/\bto=[{]?\s*[`'"]([^`'"]+)[`'"]/g)) targets.add(m[1]);
    for (const m of s.matchAll(/\bhref=[{]?\s*[`'"](\/[^`'"]*)[`'"]/g)) targets.add(m[1]);
    for (const m of s.matchAll(/path:\s*[`'"]([^`'"]+)[`'"]/g)) targets.add(m[1]);
  }
  return targets;
}

/** Template holes and the sample ids above both collapse to one wildcard. */
const norm = (p: string) =>
  p
    .split('?')[0]
    .split('#')[0]
    .replace(/^\//, '')
    .replace(/\/+$/, '')
    .replace(/\$\{[^}]*\}/g, ':x')
    .split('/')
    .map((s) => (s === 'C' || s === 'U' ? ':x' : s))
    .join('/');

const REACHED = new Set([...reachableTargets()].map(norm));

function isReachable(pattern: string): boolean {
  const a = pattern.split('/');
  return [...REACHED].some((r) => {
    const b = r.split('/');
    if (a.length !== b.length) return false;
    return a.every((seg, i) => (seg.startsWith(':') ? b[i].length > 0 : seg === b[i]));
  });
}

const ORPHANS = DECLARED.filter((p) => !isReachable(p));

describe('the reachability analysis itself is sound', () => {
  it('reads a real route table and a real link graph', () => {
    // Guards against the analysis silently collapsing (a renamed App.tsx, a
    // regex that stops matching) and then reporting a triumphant zero.
    expect(DECLARED.length).toBeGreaterThan(100);
    expect(REACHED.size).toBeGreaterThan(60);
  });

  it('resolves paths the registries build from templates', () => {
    // The six-route difference between a grep and calling the builders. If
    // this breaks, orphan counts jump and the allowlist looks wrong.
    expect(isReachable('clubs/:clubId/finance')).toBe(true);
    expect(isReachable('clubs/:clubId/operations')).toBe(true);
  });
});

describe('every declared route is reachable, or explicitly justified', () => {
  it('has no orphan outside the allowlist', () => {
    const unexplained = ORPHANS.filter((p) => !(p in ALLOWED_ORPHANS));
    expect(
      unexplained,
      `These routes exist but nothing links to them. Connect them to a navigation\n` +
        `surface, or add them to ALLOWED_ORPHANS with the reason:\n` +
        unexplained.map((p) => `  /${p}`).join('\n')
    ).toEqual([]);
  });

  it('has no stale allowlist entry - the list can only shrink', () => {
    // Two ways to go stale, and both must fail: the route was deleted, or it
    // was connected and the entry was not removed with it.
    const gone = Object.keys(ALLOWED_ORPHANS).filter((p) => !DECLARED.includes(p));
    expect(gone, `allowlisted routes that no longer exist:\n${gone.join('\n')}`).toEqual([]);

    const nowReachable = Object.keys(ALLOWED_ORPHANS).filter((p) => isReachable(p));
    expect(
      nowReachable,
      `These are reachable now - delete their ALLOWED_ORPHANS entries:\n` +
        nowReachable.map((p) => `  /${p}`).join('\n')
    ).toEqual([]);
  });
});

describe('the orphaned product pages are counted, not quietly tolerated', () => {
  it('reports how much finished product still has no door', () => {
    const queued = Object.entries(ALLOWED_ORPHANS).filter(([, why]) =>
      why.startsWith('ORPHANED PRODUCT PAGE')
    );
    // A ceiling, not a target. It may fall; it must never rise, because a NEW
    // orphan is caught by the test above before it could be added here.
    // Phase 7 took this from 24 to 2. Twelve of the original entries were
    // legacy redirects that had been miscounted as pages, three were duplicate
    // doors onto components already reachable, three were retired as
    // duplicates, and four were connected to a navigation surface.
    expect(queued.length).toBeLessThanOrEqual(2);
  });
});
