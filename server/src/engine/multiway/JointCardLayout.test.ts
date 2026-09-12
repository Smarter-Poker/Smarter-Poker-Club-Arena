import { describe, expect, it } from 'vitest';
import type { Card } from '../../types.js';
import { buildJointCardLayout, type JointCardLayoutInput } from './JointCardLayout.js';
import { KNOWN_VARIANTS, horseVariantRulesFor } from '../VariantRules.js';

const cards = (text: string): Card[] =>
  text.split(' ').map((card) => ({
    rank: card[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[card[1] as 'c'],
  }));
const spot = (): JointCardLayoutInput => ({
  variant: 'nlh',
  stage: 'flop',
  heroCards: cards('As Ad'),
  dealtSeats: 3,
  boards: [cards('Ks Qs Js'), cards('7h 6h 5h')],
  layout: 'independent',
});

describe('joint physical board ownership', () => {
  it('excludes every board and only the hero private cards from one shared deck', () => {
    const input = spot(),
      before = JSON.stringify(input);
    const result = buildJointCardLayout(input);
    expect(result.availableCards).toHaveLength(44);
    expect(result.unknownHoleCards).toBe(4);
    expect(result.unknownRunoutCards).toBe(4);
    expect(
      new Set([...result.physicalKnownCards, ...result.availableCards].map((c) => c.rank + c.suit))
        .size
    ).toBe(52);
    result.boards[0][0].rank = '2';
    result.physicalKnownCards[0].rank = '2';
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([1, 2])('rejects hero or inter-board collisions on board %s', (index) => {
    const input = spot();
    input.boards = [...input.boards, cards('4c 3c 2c')];
    const changed = input.boards.map((b) => [...b]);
    changed[index][0] = index === 1 ? input.heroCards[0] : changed[1][0];
    expect(() => buildJointCardLayout({ ...input, boards: changed })).toThrow('collision');
  });
  it.each([0, 3, 4] as const)('only repeats an explicit shared runout prefix of %s', (prefix) => {
    const board1 = cards('Ks Qs Js 7h 6h'),
      alternative = cards('5d 4d 3d 2d Tc');
    const boards = [board1, [...board1.slice(0, prefix), ...alternative.slice(prefix)]];
    const result = buildJointCardLayout({
      ...spot(),
      stage: 'river',
      boards,
      layout: 'shared_runout',
      sharedPrefixLength: prefix,
    });
    expect(result.physicalKnownCards).toHaveLength(12 - prefix);
    if (prefix) {
      boards[1][0] = alternative[0];
      expect(() =>
        buildJointCardLayout({
          ...spot(),
          stage: 'river',
          boards,
          layout: 'shared_runout',
          sharedPrefixLength: prefix,
        })
      ).toThrow('prefix_mismatch');
    }
  });
  it('does not allow a duplicate runout suffix or an unnamed shared prefix', () => {
    const board = cards('Ks Qs Js 7h 6h');
    expect(() =>
      buildJointCardLayout({
        ...spot(),
        stage: 'river',
        boards: [board, board],
        layout: 'shared_runout',
        sharedPrefixLength: 3,
      })
    ).toThrow('collision');
    expect(() =>
      buildJointCardLayout({ ...spot(), boards: [board.slice(0, 3), board.slice(0, 3)] })
    ).toThrow('collision');
  });
  it('keeps Pineapple discarded and folded-seat cards physically occupied', () => {
    const input = { ...spot(), variant: 'pineapple', knownDeadCards: cards('2c'), dealtSeats: 9 };
    const result = buildJointCardLayout(input);
    expect(result.unknownHoleCards).toBe(24);
    expect(result.availableCards.some((c) => c.rank === '2' && c.suit === 'clubs')).toBe(false);
    expect(() => buildJointCardLayout({ ...input, knownDeadCards: [] })).toThrow('invalid_count');
    expect(() => buildJointCardLayout({ ...input, knownDeadCards: cards('Ks') })).toThrow(
      'collision'
    );
  });
  it('refuses impossible second/third-board shapes, low Short Deck ranks and malformed input', () => {
    const changes: Partial<JointCardLayoutInput>[] = [
      { boards: [cards('Ks Qs Js'), cards('7h 6h')] },
      { boards: [cards('Ks Qs Js'), null as never] },
      { boards: [cards('Ks Qs Js'), [{ rank: 'X', suit: 'clubs' } as never, ...cards('7h 6h')]] },
      { variant: 'short_deck' },
      { dealtSeats: 2.5 },
      { dealtSeats: 11 },
      { layout: 'independent', sharedPrefixLength: 3 },
      { layout: 'shared_runout', sharedPrefixLength: 2 as never },
      { sharedPrefixLength: null as never },
      { knownDeadCards: null as never },
    ];
    for (const change of changes)
      expect(() => buildJointCardLayout({ ...spot(), ...change })).toThrow();
  });
  it('reserves future cards at flop and turn and treats a shared prefix as one physical deal', () => {
    const heroCards = cards('As Ad Ac Ah Ks'),
      board = cards('Qs Js Ts 9s');
    expect(() =>
      buildJointCardLayout({
        variant: 'plo5',
        stage: 'turn',
        heroCards,
        dealtSeats: 9,
        boards: [board, cards('8h 7h 6h 5h')],
        layout: 'independent',
      })
    ).toThrow('deck_exhausted');
    const result = buildJointCardLayout({
      variant: 'plo5',
      stage: 'turn',
      heroCards,
      dealtSeats: 9,
      boards: [board, board],
      layout: 'shared_runout',
      sharedPrefixLength: 4,
    });
    expect(result.unknownRunoutCards).toBe(2);
    expect(result.availableCards.length - result.unknownHoleCards - result.unknownRunoutCards).toBe(
      1
    );
    expect(() =>
      buildJointCardLayout({
        variant: 'plo5',
        stage: 'flop',
        heroCards,
        dealtSeats: 9,
        boards: [board.slice(0, 3), board.slice(0, 3), board.slice(0, 3)],
        layout: 'shared_runout',
        sharedPrefixLength: 3,
      })
    ).toThrow('deck_exhausted');
  });
  it.each(KNOWN_VARIANTS)(
    '%s conserves physical capacity at every seat/board boundary',
    (variant) => {
      const rules = horseVariantRulesFor(variant);
      const deck = ['clubs', 'diamonds', 'hearts', 'spades'].flatMap((suit) =>
        [...(rules.deckSize === 36 ? '6789TJQKA' : '23456789TJQKA')].map(
          (rank) => ({ rank, suit }) as Card
        )
      );
      for (let seats = 2; seats <= 10; seats++)
        for (let boardCount = 1; boardCount <= 3; boardCount++) {
          const holeCount = variant === 'pineapple' ? 2 : rules.holeCardsDealt;
          const heroCards = deck.slice(0, holeCount);
          const dead = variant === 'pineapple' ? deck.slice(holeCount, holeCount + 1) : [];
          const start = heroCards.length + dead.length;
          const boards = Array.from({ length: boardCount }, (_, b) =>
            deck.slice(start + b * 5, start + (b + 1) * 5)
          );
          const input: JointCardLayoutInput = {
            variant,
            stage: 'river',
            heroCards,
            knownDeadCards: dead,
            boards,
            dealtSeats: seats,
            layout: 'independent',
          };
          // Independently deal every opponent's original holes from the physical
          // suffix. An incomplete final deal must be refused, even if they folded.
          let remaining = deck.slice(start + boardCount * 5),
            complete = true;
          for (let player = 1; player < seats; player++) {
            const dealt = remaining.splice(0, rules.holeCardsDealt);
            if (dealt.length !== rules.holeCardsDealt) complete = false;
          }
          if (complete) {
            const result = buildJointCardLayout(input);
            expect(result.availableCards.length - result.unknownHoleCards).toBe(remaining.length);
          } else expect(() => buildJointCardLayout(input)).toThrow('deck_exhausted');
        }
    }
  );
});
