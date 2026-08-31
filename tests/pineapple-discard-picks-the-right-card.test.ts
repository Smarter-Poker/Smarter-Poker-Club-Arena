/**
 * Crazy Pineapple, three bugs Dan hit in one hand on 2026-08-31.
 *
 * 1. "IT DOESN'T REMOVE THE CARD FROM YOU HAND AFTER YOU DISCARD IT."
 *
 *    Two independent causes, both pinned here.
 *
 *    (a) WRONG CARD. `GameServerAPI.submitDiscard(tableId, cardIndex)` indexes
 *        into `player.cards` — the ENGINE's delivery order. The picker was
 *        handed `hero.holeCards`, which cards_pre_sort (on by default,
 *        Bible V8 §11.1) has re-sorted rank-high-to-low. Two different arrays,
 *        one index. Clicking the six threw away the ace.
 *
 *    (b) NO REPAINT. `insert_hole_cards` is an upsert — ON CONFLICT
 *        (table_id, hand_number, user_id) DO UPDATE. The deal is an INSERT;
 *        the engine's re-push of the remaining two cards after performDiscard
 *        splices one out is an UPDATE on the same key. TablePage subscribed
 *        with `event: 'INSERT'`, so it was never told, and the third card sat
 *        on the felt for the rest of the hand.
 *
 * 2. The picker covered the board — see PineappleDiscard.css.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8');

/** The translation TablePage performs, restated so the rule itself is tested. */
function engineIndexOf(
  engineOrder: string[],
  displayed: { rank: string; suit: string }[],
  displayIndex: number
): number {
  const key = `${displayed[displayIndex].rank}${displayed[displayIndex].suit}`;
  const i = engineOrder.indexOf(key);
  return i < 0 ? displayIndex : i;
}

describe('the discard reaches the card the player pointed at', () => {
  // Dan's actual hand from the screenshot, displayed sorted A-7-6.
  const engineOrder = ['6c', 'Ah', '7s']; // the order the engine dealt them
  const displayed = [
    { rank: 'A', suit: 'h' },
    { rank: '7', suit: 's' },
    { rank: '6', suit: 'c' },
  ];

  it('maps every displayed position back to the engine position', () => {
    expect(engineIndexOf(engineOrder, displayed, 0)).toBe(1); // Ah
    expect(engineIndexOf(engineOrder, displayed, 1)).toBe(2); // 7s
    expect(engineIndexOf(engineOrder, displayed, 2)).toBe(0); // 6c
  });

  it('the raw display index would have discarded the wrong card', () => {
    // The bug, stated as an inequality: on this hand only one of the three
    // clicks happened to land on the right card.
    const wrong = [0, 1, 2].filter((i) => engineIndexOf(engineOrder, displayed, i) !== i);
    expect(wrong).toHaveLength(3);
  });

  it('falls back to the display index when the engine order is unknown', () => {
    expect(engineIndexOf([], displayed, 2)).toBe(2);
  });
});

describe('TablePage wiring', () => {
  const src = read('src/pages/TablePage.tsx');

  it('records the engine card order before cards_pre_sort reorders them', () => {
    const i = src.indexOf('heroEngineCardOrderRef.current = formattedCards');
    const j = src.indexOf('if (cardsPreSortRef.current) formattedCards = sortCardsByRank');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it('subscribes to hole-card UPDATEs, not just INSERTs', () => {
    const block = src.slice(
      src.indexOf("table: 'table_hole_cards'") - 400,
      src.indexOf("table: 'table_hole_cards'") + 400
    );
    expect(block).toContain("event: '*'");
    expect(block).not.toContain("event: 'INSERT'");
  });

  it('submits the translated index, never the clicked one', () => {
    expect(src).toContain('GameServerAPI.submitDiscard(tableId, engineIndex)');
  });
});

describe('the picker does not cover the flop', () => {
  const css = read('src/components/table/PineappleDiscard.css');

  it('is docked, not a full-viewport overlay', () => {
    const shell = css.slice(css.indexOf('\n.pineapple-discard {'), css.indexOf('__panel'));
    expect(shell).not.toContain('inset: 0');
    expect(shell).toContain('bottom:');
    expect(shell).toContain('pointer-events: none');
  });

  it('paints no scrim or blur over the board', () => {
    const shell = css.slice(css.indexOf('\n.pineapple-discard {'), css.indexOf('__panel'));
    expect(shell).not.toContain('backdrop-filter');
    expect(shell).not.toMatch(/background:\s*rgba\(0, 0, 0/);
  });
});
