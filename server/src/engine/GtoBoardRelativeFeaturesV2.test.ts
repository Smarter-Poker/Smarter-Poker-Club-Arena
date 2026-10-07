import { describe, expect, it } from 'vitest';
import {
  boardRelativeFeaturesV1,
  boardRelativeFeatureKeyV1,
} from './GtoBoardRelativeFeaturesV1.js';
import {
  boardRelativeFeaturesV2,
  boardRelativeFeatureKeyV2,
  boardRelativeFeatureKeyV2Valid,
} from './GtoBoardRelativeFeaturesV2.js';

describe('immutable board-relative-v2 contract', () => {
  it('strictly admits its canonical positional key and rejects mismatched or malformed wire shapes', () => {
    const key = boardRelativeFeatureKeyV2(['Ac', 'Qd'], ['Qs', '8d', '3c']);
    expect(boardRelativeFeatureKeyV2Valid(key, 3)).toBe(true);
    expect(boardRelativeFeatureKeyV2Valid(key, 4)).toBe(false);
    expect(boardRelativeFeatureKeyV2Valid(key.replace('v2', 'v3'), 3)).toBe(false);
    expect(boardRelativeFeatureKeyV2Valid(JSON.stringify(JSON.parse(key), null, 2), 3)).toBe(false);
    const malformed = JSON.parse(key);
    malformed[2] = 9;
    expect(boardRelativeFeatureKeyV2Valid(JSON.stringify(malformed), 3)).toBe(false);
  });
  it('rejects cross-field mutations of draw mass, suit totals, rank roles and hole contribution', () => {
    const baseline = JSON.parse(boardRelativeFeatureKeyV2(['Ac', 'Qd'], ['Ks', '9d', '4c']));
    const mutations: Array<(f: any[]) => void> = [
      (f) => {
        f[7] = 1;
      },
      (f) => {
        f[9] = 1;
      },
      (f) => {
        f[4][0][2] = 2;
      },
      (f) => {
        f[8][0][0] += 1;
      },
      (f) => {
        f[8][0][1] = 2;
      },
      (f) => {
        f[10].pop();
      },
      (f) => {
        f[10][0][0] = 0;
        f[10][0][2] = 1;
      },
      (f) => {
        f[11][0] = 0;
      },
      (f) => {
        f[11] = [2, 1];
      },
      (f) => {
        f[5] = true;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(baseline);
      mutate(changed);
      expect(boardRelativeFeatureKeyV2Valid(JSON.stringify(changed), 3)).toBe(false);
    }
  });
  it('does not change any V1 descriptor or contract version', () => {
    const hole = ['Ac', 'Qd'],
      board = ['Qs', '8d', '3c'];
    expect(boardRelativeFeaturesV1(hole, board).version).toBe('holdem-board-relative-v1');
    expect(boardRelativeFeaturesV2(hole, board).version).toBe('holdem-board-relative-v2');
  });

  it('separates actual kicker ranks V1 merged without binding the full board', () => {
    const board = ['9c', '7d', '2h'];
    const king = ['Ks', 'Qd'],
      jack = ['Js', 'Qd'];
    // V1's nut-blocker ordinal already separates many suits; verify tiebreak
    // roles independently, not assume these two complete V1 keys collide.
    expect(boardRelativeFeaturesV2(king, board).madeTiebreakRoles[0]).toEqual([1, -1, 1]);
    expect(boardRelativeFeaturesV2(jack, board).madeTiebreakRoles[0]).toEqual([1, -1, 2]);
    expect(boardRelativeFeatureKeyV2(king, board)).not.toBe(boardRelativeFeatureKeyV2(jack, board));
  });

  it('reports board-playing and hole contribution independently of literal ranks', () => {
    const royal = boardRelativeFeaturesV2(['2d', '3h'], ['As', 'Ks', 'Qs', 'Js', 'Ts']);
    expect(royal.madeCategory).toBe(8);
    expect(royal.bestHoleContribution).toEqual([0, 0]);
    const set = boardRelativeFeaturesV2(['Ac', 'Ad'], ['As', '8h', '3c']);
    expect(set.bestHoleContribution).toEqual([2, 2]);
    expect(set.madeTiebreakRoles[0]).toEqual([2, 0, 0]);
  });

  it('retains different rank signatures that can genuinely share a feature key', () => {
    // Same authored card role, different low board ranks: not a suit-only
    // holdout, and not an exact-board-key disguised as a feature vector.
    const hole = ['Ac', 'Qd'];
    const first = ['Qs', '8d', '3c'],
      second = ['Qs', '8d', '4c'];
    expect(boardRelativeFeatureKeyV1(hole, first)).toBe(boardRelativeFeatureKeyV1(hole, second));
    expect(boardRelativeFeatureKeyV2(hole, first)).toBe(boardRelativeFeatureKeyV2(hole, second));
  });

  it('is suit-isomorphic and order-invariant without forgetting wheel connectivity', () => {
    const remap = (card: string) =>
      card[0] + ({ c: 'h', d: 's', h: 'c', s: 'd' } as Record<string, string>)[card[1]];
    const hole = ['Ac', 'Qd'],
      board = ['Qs', '8d', '3c', '2h'];
    expect(boardRelativeFeatureKeyV2(hole.map(remap).reverse(), board.map(remap).reverse())).toBe(
      boardRelativeFeatureKeyV2(hole, board)
    );
    expect(boardRelativeFeaturesV2(['Kc', 'Qd'], ['As', '2h', '3c']).boardConnectivity).toEqual([
      2, 1, 0,
    ]);
  });
});
