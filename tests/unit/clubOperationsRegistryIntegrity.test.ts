/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE REGISTRY AND THE GUARD READ THE SAME LIST
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03)
 *
 * `clubOperationsNavigation.ts` holds two lists: DEFINITIONS, which is what the
 * workspace ADVERTISES, and OPERATION_SUFFIXES, which is what
 * ClubCapabilityGuard and the operations rail RECOGNISE. Nothing made them
 * agree, and they had drifted:
 *
 *   - `anti-cheat` was a DEFINITION with `access: 'staff'` and a live route,
 *     and was absent from OPERATION_SUFFIXES. So
 *     getRequiredClubOperationAccess('/clubs/x/anti-cheat') returned null, the
 *     guard checked nothing, and any ordinary member of the club - 384 of the
 *     417 rows in the largest club on the estate - could open the collusion
 *     console by typing the URL. getClubOperationContext returned null for the
 *     same reason, so the operations rail VANISHED on that page: a staff member
 *     who clicked Anti-Cheat from /operations had no way back but the browser.
 *
 * A registry item is a promise about a route. These are the terms of it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getClubNavigationCapabilities } from '../../src/config/clubArenaNavigation';
import {
  getActiveClubOperationPath,
  getClubOperationBadge,
  getClubOperationContext,
  getClubOperationItems,
  getClubOperationRailItems,
  getRequiredClubOperationAccess,
  type ClubOperationItem,
  type ClubOperationSignalCounts,
} from '../../src/config/clubOperationsNavigation';

const CLUB = 'shark-club';
const PLATFORM = getClubNavigationCapabilities(null, true);
const EVERY_ITEM = getClubOperationItems(CLUB, PLATFORM);
const APP = readFileSync('src/App.tsx', 'utf8');

const suffixOf = (item: ClubOperationItem) => item.path.replace(`/clubs/${CLUB}/`, '');

/**
 * Routes that combine a member-facing experience with staff controls the page
 * itself gates. They are deliberately open at the route level, and the list is
 * pinned so widening it is a decision somebody has to make on purpose.
 */
const MEMBER_VISIBLE = ['announcements', 'cashier', 'promo-vault', 'promotions', 'rules'];

describe('every advertised operations tool is a recognised operations route', () => {
  it('collects the whole inventory, so the assertions below are not vacuous', () => {
    expect(EVERY_ITEM.length).toBeGreaterThanOrEqual(21);
    expect(EVERY_ITEM.map(suffixOf)).toContain('anti-cheat');
  });

  it.each(EVERY_ITEM.map((item) => [item.id, item] as const))(
    '%s is recognised by the rail and the guard',
    (_id, item) => {
      // The rail reads this. null here is the rail disappearing on that page.
      expect(getClubOperationContext(item.path)).toBe(CLUB);
      // A nested detail route still belongs to the workspace.
      expect(getClubOperationContext(`${item.path}/nested-detail`)).toBe(CLUB);
    }
  );

  it.each(EVERY_ITEM.map((item) => [item.id, item] as const))(
    '%s is guarded at exactly the access it advertises',
    (_id, item) => {
      const required = getRequiredClubOperationAccess(item.path);
      if (MEMBER_VISIBLE.includes(suffixOf(item))) {
        expect(required).toBeNull();
      } else {
        expect(required).toBe(item.access);
      }
    }
  );

  it('keeps the member-visible escape list to the routes that own their own gate', () => {
    const open = EVERY_ITEM.filter((item) => getRequiredClubOperationAccess(item.path) === null);
    expect(open.map(suffixOf).sort()).toEqual(MEMBER_VISIBLE);
  });

  it.each(EVERY_ITEM.map((item) => [item.id, item] as const))(
    '%s points at a route App.tsx actually declares',
    (_id, item) => {
      expect(APP).toContain(`path="clubs/:clubId/${suffixOf(item)}"`);
    }
  );

  it('has no duplicate id or destination', () => {
    expect(new Set(EVERY_ITEM.map((item) => item.id)).size).toBe(EVERY_ITEM.length);
    expect(new Set(EVERY_ITEM.map((item) => item.path)).size).toBe(EVERY_ITEM.length);
  });

  it('gives the three tools that had no door a door', () => {
    // All three were built, server-gated, and reachable only by typing the URL.
    const ids = EVERY_ITEM.map((item) => item.id);
    expect(ids).toContain('promo-vault');
    expect(ids).toContain('bomb-pot-report');
    expect(ids).toContain('table-management');
  });
});

describe('the rail always says where you are', () => {
  const rail = getClubOperationRailItems(CLUB, PLATFORM);

  it.each(EVERY_ITEM.map((item) => [item.id, item] as const))(
    'standing on %s selects a rail item',
    (_id, item) => {
      expect(getActiveClubOperationPath(item.path, rail)).not.toBeNull();
    }
  );

  it('prefers the exact tool over its group parent', () => {
    expect(getActiveClubOperationPath(`/clubs/${CLUB}/members/player-1`, rail)).toBe(
      `/clubs/${CLUB}/members`
    );
    // Blacklist is a People & Safety tool that only a control role may open,
    // so its rail parent is the workspace overview, not Control.
    expect(getActiveClubOperationPath(`/clubs/${CLUB}/blacklist`, rail)).toBe(
      `/clubs/${CLUB}/operations`
    );
    expect(getActiveClubOperationPath(`/clubs/${CLUB}/rules`, rail)).toBe(`/clubs/${CLUB}/control`);
    expect(getActiveClubOperationPath(`/clubs/${CLUB}/financials`, rail)).toBe(
      `/clubs/${CLUB}/finance`
    );
    expect(getActiveClubOperationPath(`/clubs/${CLUB}/anti-cheat`, rail)).toBe(
      `/clubs/${CLUB}/operations`
    );
  });

  it('selects nothing for a route outside the workspace', () => {
    expect(getActiveClubOperationPath(`/clubs/${CLUB}/lobby`, rail)).toBeNull();
  });
});

describe('a badge means work waiting, never volume', () => {
  const counts: ClubOperationSignalCounts = {
    members_pending: 3,
    reports_open: 2,
    disputes_open: 0,
    blacklist_expired: 1,
    chip_requests_pending: 4,
    cashouts_pending: 0,
    credit_requests_pending: 0,
    invoices_open: 5,
    tickets_outstanding: 0,
    anti_cheat_flags_open: 7,
  };
  const item = (id: string) => {
    const found = EVERY_ITEM.find((entry) => entry.id === id);
    if (!found) throw new Error(`${id} is not in the registry`);
    return found;
  };

  it('reads a tool queue from its declared signals', () => {
    expect(getClubOperationBadge(item('players'), counts, EVERY_ITEM)).toBe(3);
    expect(getClubOperationBadge(item('reports'), counts, EVERY_ITEM)).toBe(2);
    expect(getClubOperationBadge(item('anti-cheat'), counts, EVERY_ITEM)).toBe(7);
    expect(getClubOperationBadge(item('settlement'), counts, EVERY_ITEM)).toBe(5);
  });

  it('sums every queue that lands on one desk', () => {
    // The cashier takes chip requests, cash-out requests and credit requests.
    // A badge that counted the first of the three would send an operator to a
    // tile reading 4 with 9 things behind it.
    expect(item('cashier').signals).toEqual([
      'chip_requests_pending',
      'cashouts_pending',
      'credit_requests_pending',
    ]);
    expect(
      getClubOperationBadge(
        item('cashier'),
        { chip_requests_pending: 4, cashouts_pending: 3, credit_requests_pending: 2 },
        EVERY_ITEM
      )
    ).toBe(9);
  });

  it('stays quiet for a tool with nothing waiting and for a tool with no queue', () => {
    expect(getClubOperationBadge(item('disputes'), counts, EVERY_ITEM)).toBe(0);
    expect(getClubOperationBadge(item('dashboard'), counts, EVERY_ITEM)).toBe(0);
    expect(getClubOperationBadge(item('data'), counts, EVERY_ITEM)).toBe(0);
  });

  it('rolls a group overview up from the tools underneath it', () => {
    // finance: cashier 4 + settlement 5 (no cash-outs or credit requests here)
    expect(getClubOperationBadge(item('finance-overview'), counts, EVERY_ITEM)).toBe(9);
    // No tool in Club Control has a queue today, so its rail badge stays
    // quiet rather than inventing a number to display.
    expect(getClubOperationBadge(item('control-overview'), counts, EVERY_ITEM)).toBe(0);
    // everything
    expect(getClubOperationBadge(item('overview'), counts, EVERY_ITEM)).toBe(22);
  });

  it('never counts a queue the viewer cannot open', () => {
    const agentItems = getClubOperationItems(CLUB, getClubNavigationCapabilities('agent'));
    /* An agent has no control or finance tools, so the workspace total is only
       the staff queues they can actually open: players 3 + reports 2.
       Anti-Cheat moved to 'control' in phase 2 - every read on that page is
       gated in the database to owner/co_owner/admin, so advertising it to an
       agent meant advertising a page on which every panel refuses. */
    expect(agentItems.some((entry) => entry.id === 'anti-cheat')).toBe(false);
    const agentOverview = agentItems.find((entry) => entry.id === 'overview');
    expect(agentOverview).toBeDefined();
    expect(getClubOperationBadge(agentOverview!, counts, agentItems)).toBe(5);
  });

  it('treats a missing, null or negative count as nothing waiting', () => {
    expect(getClubOperationBadge(item('players'), null, EVERY_ITEM)).toBe(0);
    expect(getClubOperationBadge(item('settlement'), { invoices_open: null }, EVERY_ITEM)).toBe(0);
    expect(getClubOperationBadge(item('players'), { members_pending: -4 }, EVERY_ITEM)).toBe(0);
    expect(getClubOperationBadge(item('players'), {}, EVERY_ITEM)).toBe(0);
  });
});

describe('the rail keeps its reading out of first paint', () => {
  /**
   * AppLayout mounts ClubOperationsRail on every page with a global header, so
   * whatever it imports statically is in the entry chunk - the bundle every
   * player downloads before they have opened anything. Phase 1's badges brought
   * useClubOperationsOverview, useVisibilityRefresh and clubDashboard in with
   * them, and scripts/ci/entry-chunk-delta.mjs caught it: three modules of club
   * staff machinery paid for by players who will never open a staff tool.
   *
   * The rail is split, not baselined. These cases fail if someone puts the
   * reading back in the half that always loads.
   */
  const SHELL = readFileSync('src/components/navigation/ClubOperationsRail.tsx', 'utf8');
  const BODY = readFileSync('src/components/navigation/ClubOperationsRailBody.tsx', 'utf8');

  it('loads the reading half lazily rather than importing it', () => {
    expect(SHELL).toContain("lazy(() => import('./ClubOperationsRailBody'))");
    expect(SHELL).toContain('<Suspense fallback={null}>');
  });

  it('never imports a module that queries from the always-mounted half', () => {
    expect(SHELL).not.toContain('useClubOperationsOverview');
    expect(SHELL).not.toContain('utils/clubDashboard');
    expect(SHELL).not.toContain('useVisibilityRefresh');
    expect(SHELL).not.toContain('lib/supabase');
  });

  it('still answers the two questions that decide whether the rail applies', () => {
    // Both of these were already in the entry chunk before phase 1, so asking
    // them in the shell costs nothing new.
    expect(SHELL).toContain('getClubOperationContext(location.pathname)');
    expect(SHELL).toContain('useClubNavigationAccess(clubId)');
    expect(SHELL).toContain('!access.isClubStaff) return null');
  });

  it('keeps the badges in the half that loaded because it can render them', () => {
    expect(BODY).toContain('useClubOperationsOverview');
    expect(BODY).toContain('getClubOperationBadge');
  });
});
