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
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HAND_HISTORY_PAGE,
  HAND_HISTORY_STALE_MS,
  handDeepLink,
  prependHand,
  shouldRefetchHandHistory,
} from '@/lib/handHistoryLive';
import HandHistoryPanel from '@/components/table/HandHistoryPanel';
import { HandDetailModal } from '@/components/table/HandDetailModal';
import { adaptServiceHandToPanel } from '@/lib/handHistoryAdapter';

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
});

describe('the deep link', () => {
  it('opens the archive on the hand, under the app base path', () => {
    expect(handDeepLink('abc-123', 'https://smarter.poker')).toBe(
      'https://smarter.poker/hub/club-arena/hand-history?hand=abc-123'
    );
  });

  it("uses the router's own basename", () => {
    const main = read('src/main.tsx');
    const m = /basename="([^"]+)"/.exec(main);
    expect(m).not.toBeNull();
    expect(
      handDeepLink('x', 'https://smarter.poker').startsWith(`https://smarter.poker${m![1]}/`)
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
    expect(page).toContain('setHandHistory((prev) => prependHand(prev, record));');
  });

  it('only into a list already fetched for THIS table', () => {
    // Format-tolerant: Prettier decides the line breaks, the pin decides the guard.
    expect(page).toMatch(
      /if \(\s*handHistoryStateRef\.current !== 'ready' \|\|\s*handHistoryTableRef\.current !== tableId\s*\)\s*return;/
    );
    expect(page).toContain('if (!row || row.table_id !== tableId) return;');
  });

  it('a hand announced during the page fetch is applied after it, not dropped', () => {
    expect(page).toContain("if (handHistoryStateRef.current === 'loading') {");
    expect(page).toContain('pendingSavedIdsRef.current.push(savedId)');
    expect(page).toContain('for (const id of pending) void takeSavedHandRef.current(id);');
  });

  it("another table's list is cleared before this table's loads", () => {
    expect(page).toContain(
      'if (handHistoryTableRef.current !== (tableId ?? null)) setHandHistory([]);'
    );
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
});
