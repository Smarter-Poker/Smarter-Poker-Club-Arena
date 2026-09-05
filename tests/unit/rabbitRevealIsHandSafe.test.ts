/**
 * A RABBIT REVEAL NO LONGER FREEZES A LIVE HAND (P1, 2026-09-05)
 *
 * Until today a reveal called setRabbitHuntFreezeEnd(Date.now() + 3000) and
 * TablePage parked every engine snapshot and event for three seconds, then
 * replayed them 50ms apart. The finished board stayed up under the ghost
 * cards - and so did everything else: the next deal, the blinds, the hero's
 * own action prompt and its clock, which the engine keeps running. A late
 * click into the inter-hand rest could put the hero on the clock for up to
 * three seconds before their screen said so.
 *
 * The reveal now keeps its own copy of the board it was bought against and
 * the felt paints that copy while the live hand has nothing in the middle.
 * The rule that picks the board is pure (retainedRabbitBoard.ts) and is
 * pinned here without rendering the page. Every pin was run against the
 * pre-fix tree: the pure-helper pins fail there because the module does not
 * exist, and the page pins fail because the freeze is still wired.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  boardForRabbitReveal,
  retainedBoardShows,
  RABBIT_REVEAL_MIN_VISIBLE_MS,
  type RetainedRabbitBoard,
} from '../../src/components/table/retainedRabbitBoard';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const page = read('src/pages/TablePage.tsx');

const c = (rank: string, suit: 'h' | 'd' | 'c' | 's') => ({ rank: rank as never, suit });
const flop = [c('A', 's'), c('K', 'd'), c('7', 'c')];
const retained: RetainedRabbitBoard = {
  handNumber: 41,
  cards: flop,
  stage: 'flop',
  rabbitCards: [c('2', 'h'), c('9', 's')],
};

describe('which board the felt shows', () => {
  it('no reveal: the live board', () => {
    expect(retainedBoardShows(null, { handNumber: 41, cardCount: 3 })).toBe(false);
    expect(retainedBoardShows(null, { handNumber: 42, cardCount: 0 })).toBe(false);
  });
  it('on the finished hand with its board still up: the live path (same picture, no remount)', () => {
    expect(retainedBoardShows(retained, { handNumber: 41, cardCount: 3 })).toBe(false);
  });
  it('the finished hand cleared, or the next hand preflop: the retained copy', () => {
    expect(retainedBoardShows(retained, { handNumber: 41, cardCount: 0 })).toBe(true);
    expect(retainedBoardShows(retained, { handNumber: 42, cardCount: 0 })).toBe(true);
  });
  it('a NEWER hand with cards of its own: the live board, immediately', () => {
    expect(retainedBoardShows(retained, { handNumber: 42, cardCount: 3 })).toBe(false);
    expect(retainedBoardShows(retained, { handNumber: 43, cardCount: 5 })).toBe(false);
  });
  it('a preflop-fold reveal (empty board) shows across the boundary too', () => {
    const pre: RetainedRabbitBoard = { ...retained, cards: [], stage: 'preflop' };
    expect(retainedBoardShows(pre, { handNumber: 41, cardCount: 0 })).toBe(true);
    expect(retainedBoardShows(pre, { handNumber: 42, cardCount: 0 })).toBe(true);
    expect(retainedBoardShows(pre, { handNumber: 42, cardCount: 3 })).toBe(false);
  });
});

describe('which board a reveal is painted against', () => {
  it('the last board the felt showed, when it belongs to the rabbit hand', () => {
    const b = boardForRabbitReveal({ handNumber: 41, cards: flop, stage: 'flop' }, 41, [
      c('2', 'h'),
    ]);
    expect(b).toEqual({ handNumber: 41, cards: flop, stage: 'flop', rabbitCards: [c('2', 'h')] });
  });
  it('an empty preflop board when the rabbit hand never had one (a preflop fold)', () => {
    const b = boardForRabbitReveal({ handNumber: 40, cards: flop, stage: 'flop' }, 41, [
      c('2', 'h'),
    ]);
    expect(b.handNumber).toBe(41);
    expect(b.cards).toEqual([]);
    expect(b.stage).toBe('preflop');
  });
  it('and when nothing was ever shown', () => {
    const b = boardForRabbitReveal(null, 7, []);
    expect(b).toEqual({ handNumber: 7, cards: [], stage: 'preflop', rabbitCards: [] });
  });
  it('the guarantee is the three seconds the freeze used to buy', () => {
    expect(RABBIT_REVEAL_MIN_VISIBLE_MS).toBe(3000);
  });
});

describe('the page', () => {
  it('no longer freezes or queues the engine pipeline', () => {
    expect(page).not.toContain('rabbitHuntFreezeEnd');
    expect(page).not.toContain('frozenEventQueueRef');
    expect(page).not.toContain('frozenSnapshotRef');
    expect(page).not.toContain('setEngineSnapshot(');
    expect(page).toContain('const engineSnapshot = rawEngineSnapshot;');
    expect(page).toContain('const engineLastEvent = rawEngineLastEvent;');
  });
  it('a reveal retains its board and lets it expire on its own', () => {
    expect(page).toMatch(/setRetainedRabbitBoard\(\s*boardForRabbitReveal\(/);
    expect(page).toContain('}, RABBIT_REVEAL_MIN_VISIBLE_MS);');
  });
  it('the felt paints the retained copy - cards, ghost cards, stage and hand id together', () => {
    expect(page).toContain(
      'cards={showRetainedRabbitBoard ? retainedCards : tableState.communityCards}'
    );
    expect(page).toContain(
      'rabbitCards={showRetainedRabbitBoard ? retainedRabbitCards : liveRabbitCards}'
    );
    // The HAND_STARTED event clears the live ghost cards before the snapshot
    // moves the hand number; the live path borrows the retained copy's for
    // the same hand so the reveal never blinks at the boundary.
    expect(page).toMatch(
      /const liveRabbitCards =[\s\S]*retainedRabbitBoard\.handNumber === \(tableState\.handNumber \?\? 0\)/
    );
    expect(page).toContain('? retainedRabbitBoard!.stage');
    expect(page).toContain(
      'handId={showRetainedRabbitBoard ? retainedRabbitBoard!.handNumber : tableState.handNumber}'
    );
  });
  it('the hand-boundary clears are untouched (Dan 2026-08-26: the cards never linger)', () => {
    expect(page.match(/setRabbitRevealedCards\(\[\]\)/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
