import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  shareBoardPrefix,
  shareExtraBoards,
  visibleShareCards,
} from '../../src/lib/liveShareCards';

describe('live hand sharing with hidden card slots', () => {
  it('shares readable cards without dereferencing hidden or malformed slots', () => {
    const hidden = [null, undefined, {}, { rank: '?', suit: '?' }];
    expect(visibleShareCards(hidden)).toEqual([]);
    expect(visibleShareCards([null, 'As', { rank: '10', suit: 'hearts' }, null])).toEqual([
      { rank: 'A', suit: 's' },
      { rank: 'T', suit: 'h' },
    ]);
    expect(hidden).toEqual([null, undefined, {}, { rank: '?', suit: '?' }]);
  });

  it('retains all six exposed Omaha cards and never invents an unknown holding', () => {
    expect(visibleShareCards(['As', 'Kh', 'Qd', 'Jc', 'Ts', '9h'])).toHaveLength(6);
    expect(visibleShareCards(null)).toEqual([]);
    expect(visibleShareCards('As')).toEqual([]);
  });

  it('keeps a missing turn from relabelling the river', () => {
    const board = ['As', 'Kh', 'Qd', null, '9h'];
    expect(shareBoardPrefix(board)).toEqual([
      { rank: 'A', suit: 's' },
      { rank: 'K', suit: 'h' },
      { rank: 'Q', suit: 'd' },
    ]);
    expect(board).toEqual(['As', 'Kh', 'Qd', null, '9h']);
    expect(shareBoardPrefix([null, 'Kh', 'Qd'])).toEqual([]);
  });

  it('retains known streets and distinct run positions', () => {
    const first = ['As', 'Kh', 'Qd', 'Jc', 'Ts'];
    const second = ['2s', '3h', '4d', '5c'];
    expect(shareBoardPrefix(first)).toHaveLength(5);
    expect(shareExtraBoards([first, second])).toEqual([shareBoardPrefix(second)]);
    expect(shareExtraBoards([first, [null, '3h', '4d'], second])).toEqual([]);
    expect(shareExtraBoards(undefined)).toEqual([]);
  });

  it('the live completion handler uses these readers for holdings, streets and extra runs', () => {
    const page = readFileSync(resolve('src/pages/TablePage.tsx'), 'utf8');
    const start = page.indexOf('// ── Share Hand: capture');
    const end = page.indexOf("reportError(e, 'TablePage.buildSharedHand')", start);
    const share = page.slice(start, end);
    expect(share).toContain('shareBoardPrefix(st.communityCards)');
    expect(share).toContain('visibleShareCards(p.holeCards)');
    expect(share).toContain('shareExtraBoards(runs)');
    expect(share).not.toContain('.map(asShareCard)');
  });
});
