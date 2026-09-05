/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HUB TABS — the "+" tab is an internal browser tab (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "when you click the + button from inside the club lobby i should be able to
 * go anywhere, its basically opening up a new browser tab internally, it
 * shouldn't be limited to just poker ... I should still see my action bar, I
 * should still be able to swipe right or left."
 *
 * The decisions a hub tab turns on are pure (src/utils/hubTab.ts,
 * src/utils/tabSlots.ts) and pinned here by running them, not by grepping
 * the source. The container-level pins (the frame is same-origin, uses no
 * postMessage, is the one sanctioned iframe) are in
 * tests/hub-tab-is-a-browser-tab.law.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  CLUB_ARENA_PREFIX,
  HUB_FRAME_POLL_MS,
  clubArenaPathFromHubUrl,
  hubTabTitle,
  isHubPath,
} from '../../src/utils/hubTab';
import {
  HUB_TAB_PREFIX,
  isFreeSlot,
  isHubLike,
  isLobbyLike,
  isPageTab,
  pickObserveSlot,
  pruneStaleSeatedTabs,
  type SlotTab,
} from '../../src/utils/tabSlots';

describe('hubTabTitle names the pill for where the frame is', () => {
  it.each([
    ['/hub', 'Hub'],
    ['/hub/', 'Hub'],
    ['/hub?x=1', 'Hub'],
    ['/hub/social', 'Social'],
    ['/hub/media', 'Media'],
    ['/hub/trivia', 'Trivia'],
    ['/hub/training', 'Training'],
    ['/hub/training/drills/3', 'Training'],
    ['/hub/social?tab=feed#top', 'Social'],
    ['/hub/hand-of-the-day', 'Hand Of The Day'],
    ['/hub/vip-membership', 'VIP'],
    ['/hub/messenger', 'Messages'],
    ['/hub/diamond-store?tab=vip', 'Diamonds'],
  ])('%s -> %s', (path, title) => {
    expect(hubTabTitle(path)).toBe(title);
  });

  it('follows the popup rule: First Letter Of Every Word', () => {
    // No em dashes, no lower-case leading words - the strip is player-facing copy.
    expect(hubTabTitle('/hub/daily_free_roll')).toBe('Daily Free Roll');
    expect(hubTabTitle('/hub/daily_free_roll')).not.toContain('—');
  });
});

describe('clubArenaPathFromHubUrl notices the frame heading back into Club Arena', () => {
  it('maps the SPA root and paths under it, keeping the search', () => {
    expect(clubArenaPathFromHubUrl(CLUB_ARENA_PREFIX)).toBe('/');
    expect(clubArenaPathFromHubUrl(`${CLUB_ARENA_PREFIX}/`)).toBe('/');
    expect(clubArenaPathFromHubUrl(`${CLUB_ARENA_PREFIX}/clubs/abc`)).toBe('/clubs/abc');
    expect(clubArenaPathFromHubUrl(`${CLUB_ARENA_PREFIX}/table/t1?name=NLH&stakes=1%2F2`)).toBe(
      '/table/t1?name=NLH&stakes=1%2F2'
    );
    expect(clubArenaPathFromHubUrl(`${CLUB_ARENA_PREFIX}/tournaments/x?watch=1#lobby`)).toBe(
      '/tournaments/x?watch=1'
    );
  });

  it('is null for every World Hub page, including near-miss names', () => {
    for (const p of ['/hub', '/hub/social', '/hub/club-arenas', '/hub/club-arena-news', '/']) {
      expect(clubArenaPathFromHubUrl(p), p).toBeNull();
    }
  });
});

describe('isHubPath: a hub tab is a window onto /hub, not a general browser', () => {
  it('accepts /hub and anything under it', () => {
    for (const p of ['/hub', '/hub/', '/hub/social', '/hub/vip-membership', '/hub/messenger?x=1']) {
      expect(isHubPath(p), p).toBe(true);
    }
  });

  it('refuses Club Arena itself and everything outside /hub', () => {
    for (const p of [
      '/hub/club-arena',
      '/hub/club-arena/clubs/x',
      '/hubs',
      '/',
      '/social',
      'https://evil.example/hub',
    ]) {
      expect(isHubPath(p), p).toBe(false);
    }
  });
});

describe('a hub tab in the slot model', () => {
  const hubTab: SlotTab = { id: `${HUB_TAB_PREFIX}1`, kind: 'hub' };
  const lobbyTab: SlotTab = { id: 'lobby:1', kind: 'lobby' };
  const seated = (id: string): SlotTab => ({ id, kind: 'table', seated: true });

  it('is a page, not a table, and not a lobby', () => {
    expect(isHubLike(hubTab)).toBe(true);
    expect(isPageTab(hubTab)).toBe(true);
    expect(isLobbyLike(hubTab)).toBe(false);
    // Either proof works, like lobby tabs.
    expect(isHubLike({ id: 'hub:9' })).toBe(true);
    expect(isPageTab(lobbyTab)).toBe(true);
    expect(isPageTab(seated('T1'))).toBe(false);
  });

  it('is never a free slot: a page the player is reading is not parking space', () => {
    expect(isFreeSlot(hubTab)).toBe(false);
    expect(isFreeSlot(lobbyTab)).toBe(true);
  });

  it('is skipped by an observe in favour of a real lobby tab or a new slot', () => {
    const tabs = [seated('T1'), hubTab, lobbyTab];
    // Active on the hub tab: not taken in place; the parked lobby tab is used.
    expect(pickObserveSlot(tabs, 1, 'T2', 4)).toEqual({ action: 'lobby', index: 2 });
    // No lobby tab: append rather than replace the hub tab.
    expect(pickObserveSlot([seated('T1'), hubTab], 1, 'T2', 4)).toEqual({
      action: 'append',
      index: 2,
    });
  });

  it('survives a server-truth rebuild (it holds no seat to have lost)', () => {
    expect(pruneStaleSeatedTabs([seated('T1'), hubTab, lobbyTab], new Set())).toEqual([
      hubTab,
      lobbyTab,
    ]);
  });
});

describe('the poll is fast enough to beat a second app boot', () => {
  it('reads the frame at least four times a second', () => {
    expect(HUB_FRAME_POLL_MS).toBeLessThanOrEqual(250);
  });
});
