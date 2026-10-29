/**
 * PREVIOUS HAND - PHASE 1 (2026-09-05): live, instant and honest at the table.
 *
 * - The list refetches on the first open for a table, after a failure, or when
 *   stale; a reopen inside the window is instant.
 * - A saved hand lands in play order, once, capped at the page size.
 * - A spectator is told they are watching, not that the table has no hands.
 * - The modal offers Copy Hand Number and Copy Link, and the link opens the
 *   archive on that hand.
 * - TablePage wires `hand_history_saved` into the list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HAND_HISTORY_PAGE,
  HAND_HISTORY_STALE_MS,
  handDeepLink,
  prependHand,
  mergeHandHistoryPages,
  shouldRefetchHandHistory,
} from '@/lib/handHistoryLive';
import HandHistoryPanel from '@/components/table/HandHistoryPanel';
import { HandDetailModal } from '@/components/table/HandDetailModal';
import { adaptServiceHandToPanel } from '@/lib/handHistoryAdapter';
import { routerBasenameFrom } from '@/lib/appBase';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
afterEach(cleanup);

describe('when the table list hits the network', () => {
  const base = { fetchedAt: 1_000_000, fetchedTableId: 't1', tableId: 't1', now: 1_000_000 + 1 };

  it('fetches on the first open, and again after a failure', () => {
    expect(shouldRefetchHandHistory({ ...base, state: 'idle', fetchedAt: null })).toBe(true);
    expect(shouldRefetchHandHistory({ ...base, state: 'failed' })).toBe(true);
  });

  it('does not fetch twice while a fetch is in flight', () => {
    expect(shouldRefetchHandHistory({ ...base, state: 'loading', fetchedAt: null })).toBe(false);
  });

  it('a reopen inside the staleness window is instant', () => {
    expect(shouldRefetchHandHistory({ ...base, state: 'ready' })).toBe(false);
    expect(
      shouldRefetchHandHistory({
        ...base,
        state: 'ready',
        now: base.fetchedAt + HAND_HISTORY_STALE_MS - 1,
      })
    ).toBe(false);
  });

  it('re-reads an empty result on an explicit reopen without duplicating an in-flight read', () => {
    expect(shouldRefetchHandHistory({ ...base, state: 'ready', handCount: 0 })).toBe(true);
    expect(shouldRefetchHandHistory({ ...base, state: 'ready', handCount: 1 })).toBe(false);
    expect(shouldRefetchHandHistory({ ...base, state: 'loading', handCount: 0 })).toBe(false);
  });

  it('a stale list refetches, in case an event was missed', () => {
    expect(
      shouldRefetchHandHistory({
        ...base,
        state: 'ready',
        now: base.fetchedAt + HAND_HISTORY_STALE_MS,
      })
    ).toBe(true);
  });

  it('a different table always refetches', () => {
    expect(shouldRefetchHandHistory({ ...base, state: 'ready', tableId: 't2' })).toBe(true);
  });
});

describe('a saved hand lands in the list', () => {
  const h = (id: string, n: number) => ({ id, handNumber: n });

  it('newest first, in play order, once', () => {
    const list = [h('b', 12), h('a', 11)];
    expect(prependHand(list, h('c', 13)).map((x) => x.id)).toEqual(['c', 'b', 'a']);
    // A late-landing older hand (the writer's retry queue) sorts into place.
    expect(prependHand(list, h('z', 10)).map((x) => x.id)).toEqual(['b', 'a', 'z']);
    // A re-emit replaces its copy rather than duplicating it.
    expect(prependHand(list, h('b', 12))).toHaveLength(2);
  });

  it('is capped at the page size', () => {
    const list = Array.from({ length: HAND_HISTORY_PAGE }, (_, i) => h(`h${i}`, 1000 - i));
    const next = prependHand(list, h('new', 2000));
    expect(next).toHaveLength(HAND_HISTORY_PAGE);
    expect(next[0].id).toBe('new');
    expect(next.some((x) => x.id === `h${HAND_HISTORY_PAGE - 1}`)).toBe(false);
  });

  it('retains older bomb pages through a new saved hand and a first-page refresh', () => {
    const recent = Array.from({ length: 50 }, (_, i) => h(`recent-${i}`, 500 - i));
    const older = Array.from({ length: 50 }, (_, i) => h(`older-${i}`, 450 - i));
    const bomb = { ...h('bomb', 400), bombPot: { boardCount: 2 } };
    const loaded = mergeHandHistoryPages(recent, [...older, bomb]);
    const live = prependHand(loaded, h('live', 501), Number.POSITIVE_INFINITY);
    const refreshed = mergeHandHistoryPages(live, [{ ...recent[0], corrected: true }]);
    expect(refreshed).toHaveLength(102);
    expect(refreshed.at(-1)).toEqual(bomb);
    expect(refreshed[0].id).toBe('live');
    expect(refreshed.find((hand) => hand.id === recent[0].id)).toHaveProperty('corrected', true);
    expect(new Set(refreshed.map((hand) => hand.id)).size).toBe(refreshed.length);
  });
});

describe('the deep link', () => {
  it('opens the archive on the hand, under the app base path', () => {
    expect(handDeepLink('abc-123', 'https://smarter.poker')).toBe(
      'https://smarter.poker/hub/club-arena/hand-history?hand=abc-123'
    );
  });

  it("uses the router's own basename", () => {
    // The basename is derived from the build base (src/lib/appBase.ts); on the
    // web that is '/hub/club-arena', and a deep link is a WEB link on every
    // target, so it must start with the web basename even in the native app.
    const main = read('src/main.tsx');
    expect(main).toContain('basename={ROUTER_BASENAME}');
    const webBasename = routerBasenameFrom('/hub/club-arena/');
    expect(
      handDeepLink('x', 'https://smarter.poker').startsWith(`https://smarter.poker${webBasename}/`)
    ).toBe(true);
  });

  it('is what the modal copies, and the archive reads', () => {
    expect(read('src/components/table/HandDetailModal.tsx')).toContain(
      "copyText('link', handDeepLink(hand.id))"
    );
    const page = read('src/pages/HandHistoryPage.tsx');
    expect(page).toContain("const linkedHandId = searchParams.get('hand');");
    expect(page).toContain('handHistoryService.getHand(linkedHandId)');
    expect(page).toContain('id={`hand-${hand.id}`}');
  });
});

describe('TablePage takes the saved hand as it lands', () => {
  const page = read('src/pages/TablePage.tsx');

  it('listens to hand_history_saved and prepends by id', () => {
    expect(page).toContain('void takeSavedHandRef.current(savedId);');
    expect(page).toContain('const row = await handHistoryService.getHand(savedId);');
    expect(page).toContain('const next = prependHand(prev, record, Number.POSITIVE_INFINITY);');
  });

  it('only into a list already fetched for THIS table', () => {
    // Format-tolerant: Prettier decides the line breaks, the pin decides the guard.
    expect(page).toMatch(
      /if \(\s*handHistoryStateRef\.current !== 'ready' \|\|\s*handHistoryTableRef\.current !== tableId\s*\)\s*return;/
    );
    // Ordinary tables still require physical table equality. A Lightning room
    // is a pool session, whose authenticated saved events name physical hands.
    expect(page).toMatch(
      /if \(!row \|\| \(!lightningRoom\?\.poolSessionId && row\.table_id !== tableId\)\) return;/
    );
  });

  it('uses the pool session for both history hydration and the lazy replay lookup', () => {
    const hydration = page.slice(page.indexOf('return startHandHistoryHydration({'));
    expect(hydration).toMatch(
      /getPlayerHands\(userId, HAND_HISTORY_PAGE, \{\s*tableId,\s*lightningPoolSessionId: lightningRoom\?\.poolSessionId,\s*throwOnError: true,/
    );
    expect(page).toMatch(
      /getPlayerHands\(userId, 1, \{\s*tableId,\s*lightningPoolSessionId: lightningRoom\?\.poolSessionId,\s*throwOnError: true,/
    );
  });

  it('rechecks the viewer and room after a saved-hand read before publishing its private record', () => {
    const savedRead = page.slice(
      page.indexOf('const takeSavedHand = useCallback('),
      page.indexOf('const takeSavedHandRef = useRef(')
    );
    const continuation = savedRead.split(
      'const row = await handHistoryService.getHand(savedId);'
    )[1];
    expect(continuation).toBeTruthy();
    const beforeCommit = continuation.split(
      'const record = adaptServiceHandToPanel(row, userId);'
    )[0];
    expect(beforeCommit).toContain('handHistoryScopeRef.current !== savedScope');
    expect(beforeCommit).toContain('handHistoryViewerRef.current !== userId');
    expect(beforeCommit).toContain('handHistoryTableRef.current !== tableId');
    expect(beforeCommit).toContain(
      'const readStateAfterAwait = () => handHistoryStateRef.current;'
    );
    expect(beforeCommit).toContain('const stateAfterAwait = readStateAfterAwait();');
    expect(beforeCommit).toContain("if (stateAfterAwait === 'loading') {");
    expect(beforeCommit).toContain("if (stateAfterAwait !== 'ready') return;");
    expect(beforeCommit).toContain('pendingSavedIdsRef.current.push(savedId)');
  });

  it('a hand announced during the page fetch is applied after it, not dropped', () => {
    expect(page).toContain("if (handHistoryStateRef.current === 'loading') {");
    expect(page).toContain('pendingSavedIdsRef.current.push(savedId)');
    expect(page).toContain('for (const id of pending) void takeSavedHandRef.current(id);');
  });

  it("another table's list is cleared before this table's loads", () => {
    expect(page).toContain('if (loadedHandHistoryScopeRef.current !== readScope) {');
    expect(page).toContain('handHistoryRowsRef.current = [];');
    expect(page).toContain('olderHandRequestRef.current = null;');
  });

  it('wires canonical older pages and rejects late responses from another review scope', () => {
    const older = page.slice(
      page.indexOf('const loadOlderReviewHands = useCallback'),
      page.indexOf('const takeSavedHand = useCallback')
    );
    expect(older).toContain('beforeHandNumber: oldest.handNumber');
    expect(older).toContain('handHistoryScopeRef.current !== readScope');
    expect(older).toContain('olderHandRequestRef.current !== request');
    expect(older).toContain('mergeHandHistoryPages(previous, page)');
    expect(page).toContain('onLoadOlder={loadOlderReviewHands}');
  });

  it('opens without a fetch when the list is fresh', () => {
    expect(page).toContain('!shouldRefetchHandHistory({');
    expect(page).toContain('handHistoryFetchedAtRef.current = Date.now();');
  });
});

describe('the surfaces', () => {
  const HERO = 'hero-1';
  const record = () =>
    adaptServiceHandToPanel(
      {
        id: 'h-1',
        serial_number: '7',
        table_id: 't-1',
        table_name: 'Midway 1/2',
        played_at: '2026-09-05T01:00:00.000Z',
        hand_number: 7,
        total_hands: 0,
        main_pot: 3,
        side_pots: [],
        community_cards: [],
        players: [
          {
            seat: 1,
            user_id: HERO,
            username: 'Hero',
            avatar_url: null,
            position: 'SB',
            hole_cards: [],
            result: 2,
            is_winner: true,
          },
          {
            seat: 2,
            user_id: 'v',
            username: 'Villain',
            avatar_url: null,
            position: 'BB',
            hole_cards: [],
            result: -2,
            is_winner: false,
          },
        ],
        actions: [{ player_id: 'v', action: 'fold', amount: 0, street: 'preflop', timestamp: 1 }],
        winners: [{ user_id: HERO, amount: 3, pot_index: 0 }],
        winners_by_board: [],
        rake: 0,
        bbj_fee: 0,
        game_type: 'NLH',
        stakes: '1/2',
      } as never,
      HERO
    );

  it('a spectator is told they are watching, in both surfaces', () => {
    render(
      <HandHistoryPanel isOpen onClose={() => {}} hands={[]} heroId={HERO} viewerSeated={false} />
    );
    expect(document.querySelector('.hh-panel__empty')?.textContent).toMatch(/You Are Watching/);
    cleanup();
    render(
      <HandDetailModal isOpen onClose={() => {}} hands={[]} heroId={HERO} viewerSeated={false} />
    );
    expect(document.querySelector('.hdm-empty')?.textContent).toMatch(/You Are Watching/);
  });

  it('a seated player with no hands yet is told that, not that the table has none', () => {
    render(<HandHistoryPanel isOpen onClose={() => {}} hands={[]} heroId={HERO} viewerSeated />);
    expect(document.querySelector('.hh-panel__empty')?.textContent).toMatch(
      /For You At This Table/
    );
    expect(document.querySelector('.hh-panel__empty')?.textContent).not.toMatch(
      /No Hands Recorded At This Table/
    );
  });

  it('a hand landing while the modal is open does not move the reader off the hand on screen', () => {
    const newest = record();
    const older = { ...record(), id: 'h-0', handNumber: 6 };
    const { rerender } = render(
      <HandDetailModal isOpen onClose={() => {}} hands={[newest, older]} heroId={HERO} />
    );
    expect(document.querySelector('.hdm-sn')?.textContent).toContain('#7');
    const landed = { ...record(), id: 'h-2', handNumber: 8 };
    rerender(
      <HandDetailModal isOpen onClose={() => {}} hands={[landed, newest, older]} heroId={HERO} />
    );
    // Still on #7; the navigator now counts three and the newer arrow is live.
    expect(document.querySelector('.hdm-sn')?.textContent).toContain('#7');
    expect(document.querySelector('.hdm-nav__label')?.textContent).toBe('2/3');
    expect((screen.getByLabelText('Newer Hand') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the modal copies the hand number and the link', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<HandDetailModal isOpen onClose={() => {}} hands={[record()]} heroId={HERO} />);
    fireEvent.click(screen.getByLabelText('Copy Hand Number 7'));
    fireEvent.click(screen.getByLabelText('Copy Link To This Hand'));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('#7');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/hand-history?hand=h-1'));
  });

  it('reaches an older saved bomb through the loaded-page boundary', async () => {
    const recent = Array.from({ length: 50 }, (_, i) => ({
      ...record(),
      id: `h-${100 - i}`,
      handNumber: 100 - i,
    }));
    const bomb = { ...record(), id: 'old-bomb', handNumber: 50, bombPot: { boardCount: 2 } };
    let finish!: (id: string | null) => void;
    const load = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        })
    );
    const props = {
      isOpen: true,
      onClose: () => {},
      heroId: HERO,
      onLoadOlder: load,
      hasOlderHands: true,
    };
    const view = render(<HandDetailModal {...props} hands={recent} />);
    fireEvent.change(screen.getByLabelText('Hand Position'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText('Load Older Hands'));
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<HandDetailModal {...props} hands={[...recent, bomb]} olderHandsLoading />);
    expect((screen.getByLabelText('Older Hand') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish(bomb.id);
    });
    view.rerender(<HandDetailModal {...props} hands={[...recent, bomb]} hasOlderHands={false} />);
    await waitFor(() => expect(document.querySelector('.hdm-sn')?.textContent).toContain('#50'));
    expect((screen.getByLabelText('Older Hand') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.hdm-nav__label')?.textContent).toBe('1/51');
  });

  it('keeps the current hand on a failed older read and permits an explicit retry', async () => {
    const load = vi.fn().mockResolvedValue(null);
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        heroId={HERO}
        hands={[record()]}
        hasOlderHands
        onLoadOlder={load}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Load Older Hands'));
    });
    expect(document.querySelector('.hdm-sn')?.textContent).toContain('#7');
    expect((screen.getByLabelText('Load Older Hands') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Load Older Hands'));
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not navigate a reopened review when an old page finishes late', async () => {
    let finish!: (id: string | null) => void;
    const load = () =>
      new Promise<string | null>((resolve) => {
        finish = resolve;
      });
    const props = { onClose: () => {}, heroId: HERO, onLoadOlder: load, hasOlderHands: true };
    const newest = record();
    const older = { ...record(), id: 'older', handNumber: 6 };
    const view = render(<HandDetailModal {...props} isOpen hands={[newest]} />);
    fireEvent.click(screen.getByLabelText('Load Older Hands'));
    view.rerender(<HandDetailModal {...props} isOpen={false} hands={[newest]} />);
    view.rerender(<HandDetailModal {...props} isOpen hands={[newest, older]} />);
    await act(async () => {
      finish(older.id);
    });
    expect(document.querySelector('.hdm-sn')?.textContent).toContain('#7');
  });
});
