/**
 * SHOW-CARD PICKS: TWO OF THEM, AND YOU CAN TAKE THEM BACK
 *
 * From Dan's screen recording, 2026-09-05: "THE CLICK TO 'SHOW ONE, OR SHOW
 * TWO' IS BROKEN, IT ONLY ALLOWS YOU TO SHOW 1, NEVER BOTH, AND THE EYE BALL
 * STAYS 'LOCKED' YOU CAN NEVER UNLOCK IT OR 'UNSHOW' AND IT STAYS LOCKED FOR
 * FUTURE HANDS AS WELL."
 *
 * Four separate defects sat behind that sentence. This file pins the two that
 * are pure enough to pin here - the wire contract and the index translation.
 * The other two (the badge drawn on an unclickable face-down card, and the
 * per-hand reset hanging off an event clients demonstrably miss) are pinned in
 * tests/components/CardSlidePeel.test.tsx and by the handNumber effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { setShownCards } from '../../src/services/ShowCardsService';

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, shownCardIndexes: [] }),
    } as unknown as Response);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the wire contract', () => {
  it('SENDS an empty selection instead of swallowing it', async () => {
    /* This was `if (cardIndexes.length === 0) return { success: true }` - a
       local no-op, added because the engine answered "no valid card indexes".
       The effect was that un-picking your LAST card removed the badge and left
       the engine holding the card, which it then turned face up at hand end.
       That is the whole of "you can never unshow". */
    const res = await setShownCards('t1', []);
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ tableId: 't1', cardIndexes: [] });
  });

  it('sends the full selection, not a delta', async () => {
    await setShownCards('t1', [0, 1]);
    expect(calls[0].body.cardIndexes).toEqual([0, 1]);
  });

  it('a missing table is refused without a request', async () => {
    const res = await setShownCards('', [0]);
    expect(res.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a network failure costs a reveal, never the hand', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(setShownCards('t1', [0])).resolves.toEqual({
      success: false,
      error: 'Network error',
    });
  });
});

/**
 * THE INDEX IS INTO THE ENGINE'S ARRAY, NOT THE ONE ON SCREEN.
 *
 * `cards_pre_sort` (default true, in the hook and in the column) re-orders the
 * hero's hand for display, and the engine applies the index to `player.cards`
 * in DEALT order. So clicking the ace queued the deuce.
 *
 * This repo has already fixed exactly this once, for the Pineapple discard -
 * "Two different arrays, one index. Clicking the six threw away the ace." The
 * translation ref it introduced was simply never wired to this second caller.
 * The mapping TablePage now performs is reproduced here so the rule has a test
 * of its own rather than living only inside a 24k-line component.
 */
describe('display order is not dealt order', () => {
  type C = { rank: string; suit: string };
  const key = (c: C) => `${c.rank}${c.suit}`;
  const toEngineIndex = (display: C[], engineOrder: string[] | null, di: number): number => {
    const card = display[di];
    if (!card || !engineOrder) return di;
    const at = engineOrder.indexOf(key(card));
    return at < 0 ? di : at;
  };

  // Dealt 7-then-A; shown A-then-7 because pre-sort is on.
  const dealt: C[] = [
    { rank: '7', suit: 'd' },
    { rank: 'A', suit: 's' },
  ];
  const engineOrder = dealt.map(key);
  const display: C[] = [dealt[1], dealt[0]];

  it('clicking the ace queues the ACE', () => {
    expect(toEngineIndex(display, engineOrder, 0)).toBe(1);
  });

  it('clicking the seven queues the SEVEN', () => {
    expect(toEngineIndex(display, engineOrder, 1)).toBe(0);
  });

  it('both picks translate, and stay two picks', () => {
    const picks = [0, 1].map((i) => toEngineIndex(display, engineOrder, i)).sort((a, b) => a - b);
    expect(picks).toEqual([0, 1]);
  });

  it('falls back to the display index when no order was recorded', () => {
    // A mid-hand mount that recovered cards by polling has no record. Same
    // fallback the Pineapple path uses: no worse than before, never a crash.
    expect(toEngineIndex(display, null, 0)).toBe(0);
    expect(toEngineIndex(display, [], 1)).toBe(1);
  });
});
