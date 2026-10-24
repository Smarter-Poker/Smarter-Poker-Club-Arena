import { describe, expect, it } from 'vitest';
import { cashBoardComparator, type CashBoardRow } from '../../src/components/lobby/cashBoardOrder';

/* The Sort By sheet's cash order (ClubHomePage). The ALL tab renders this
   order as-is, so it is where "game variations are never to be mixed
   together" has to hold for the stakes sorts (Dan 2026-10-23). */
const row = (
  name: string,
  game_variant: string,
  big_blind: number,
  current_players = 3
): CashBoardRow => ({ name, game_variant, big_blind, current_players });
const names = (rows: CashBoardRow[], key: string, tab: string) =>
  [...rows].sort(cashBoardComparator(key, tab)).map((r) => r.name);

const board = [
  row('PLO8 1/2', 'plo8', 2, 6),
  row('NLH .5/1', 'nlh', 1, 1),
  row('Short Deck 1/2', 'short_deck', 2, 5),
  row('PLO 1/2', 'plo4', 2, 1),
  row('NLH 1/2', 'nlh', 2, 2),
  row('Pineapple 1/2', 'pineapple', 2, 9),
  row('PLO5 .5/1', 'plo5', 1, 9),
  row('FLH 2/4', 'flh', 2, 9),
];

describe('cashBoardComparator', () => {
  it('ALL: Stakes High To Low keeps each price together in canonical variant order', () => {
    expect(names(board, 'stakes_high', 'ALL')).toEqual([
      'FLH 2/4',
      'NLH 1/2',
      'Pineapple 1/2',
      'Short Deck 1/2',
      'PLO 1/2',
      'PLO8 1/2',
      'NLH .5/1',
      'PLO5 .5/1',
    ]);
  });

  it('ALL: Stakes Low To High reverses the prices, never the variant order', () => {
    expect(names(board, 'stakes_low', 'ALL')).toEqual([
      'NLH .5/1',
      'PLO5 .5/1',
      'NLH 1/2',
      'Pineapple 1/2',
      'Short Deck 1/2',
      'PLO 1/2',
      'PLO8 1/2',
      'FLH 2/4',
    ]);
  });

  it('OMAHA: legacy spellings rank as the game the Variant chips call them', () => {
    const omaha = [
      row('Hi-Lo', 'plo8', 2),
      row('Bare', 'plo', 2),
      row('Six', 'plo6', 2),
      row('Five', 'plo5', 2),
    ];
    expect(names(omaha, 'stakes_high', 'OMAHA')).toEqual(['Bare', 'Five', 'Six', 'Hi-Lo']);
    expect(names(omaha, 'players', 'OMAHA')).toEqual(['Bare', 'Five', 'Six', 'Hi-Lo']);
  });

  it('the other sorts are unchanged: ALL stays a flat list, OMAHA keeps its variant groups', () => {
    expect(names(board, 'recommended', 'ALL')).toEqual([
      'FLH 2/4',
      'Pineapple 1/2',
      'PLO8 1/2',
      'Short Deck 1/2',
      'NLH 1/2',
      'PLO 1/2',
      'PLO5 .5/1',
      'NLH .5/1',
    ]);
    expect(names(board, 'players', 'ALL').slice(0, 3)).toEqual([
      'FLH 2/4',
      'Pineapple 1/2',
      'PLO5 .5/1',
    ]);
  });
});

describe('a fixed-limit row is ordered by the stakes it prints (2026-10-24)', () => {
  // Blinds 0.50/1 FLH prints "1/2"; blinds 1/2 NLH prints "1/2" too. On ALL
  // they are one stakes level, never split around the 0.50/1 group.
  const mixed = [
    row('FLH prints 1/2', 'flh', 1),
    row('NLH 1/2', 'nlh', 2),
    row('NLH .5/1', 'nlh', 1),
    row('PLO 1/2', 'plo4', 2),
  ];
  it('High To Low keeps every "1/2" ahead of every "0.50/1"', () => {
    expect(names(mixed, 'stakes_high', 'ALL')).toEqual([
      'NLH 1/2',
      'PLO 1/2',
      'FLH prints 1/2',
      'NLH .5/1',
    ]);
  });
  it('Low To High reverses the levels, not the variant order', () => {
    expect(names(mixed, 'stakes_low', 'ALL')).toEqual([
      'NLH .5/1',
      'NLH 1/2',
      'PLO 1/2',
      'FLH prints 1/2',
    ]);
  });
});
