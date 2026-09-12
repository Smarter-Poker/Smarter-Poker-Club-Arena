import type { Card } from '../../types.js';
import { horseVariantRulesFor, isKnownVariant } from '../VariantRules.js';

const ranks = '23456789TJQKA';
const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
const cardKey = (card: Card) => `${card.rank}:${card.suit}`;

export interface JointCardLayoutInput {
  variant: string;
  stage: 'preflop' | 'flop' | 'turn' | 'river';
  heroCards: readonly Card[];
  /** Only the acting player's own discard may be supplied. */
  knownDeadCards?: readonly Card[];
  /** Includes every original deal, including subsequently disconnected/folded seats. */
  dealtSeats: number;
  boards: readonly (readonly Card[])[];
  /** Bomb boards have disjoint cards. Runouts may repeat only their named prefix. */
  layout: 'independent' | 'shared_runout';
  sharedPrefixLength?: 0 | 3 | 4;
}

/** Physical construction for one joint deck. This is not a range estimate or
 * a live policy. It deliberately takes no opponents' private cards. Every
 * accepted card and returned deck entry is copied across the caller boundary. */
export function buildJointCardLayout(input: JointCardLayoutInput) {
  if (!isKnownVariant(input.variant)) throw new Error('joint_cards_unknown_variant');
  const rules = horseVariantRulesFor(input.variant);
  const boardLength = { preflop: 0, flop: 3, turn: 4, river: 5 }[input.stage];
  if (
    boardLength === undefined ||
    !Number.isSafeInteger(input.dealtSeats) ||
    input.dealtSeats < 2 ||
    input.dealtSeats > 10 ||
    !Array.isArray(input.boards) ||
    input.boards.length < 1 ||
    input.boards.length > 3 ||
    !['independent', 'shared_runout'].includes(input.layout)
  )
    throw new Error('joint_cards_invalid_domain');
  const prefix = input.sharedPrefixLength === undefined ? 0 : input.sharedPrefixLength;
  if (
    ![0, 3, 4].includes(prefix) ||
    prefix > boardLength ||
    (input.layout === 'independent' && prefix !== 0) ||
    (input.layout === 'shared_runout' && input.boards.length < 2)
  )
    throw new Error('joint_cards_invalid_prefix');
  const postDiscard = input.variant === 'pineapple' && input.stage !== 'preflop';
  const dead = input.knownDeadCards === undefined ? [] : input.knownDeadCards;
  if (
    !Array.isArray(input.heroCards) ||
    input.heroCards.length !== (postDiscard ? 2 : rules.holeCardsDealt) ||
    !Array.isArray(dead) ||
    dead.length !== (postDiscard ? 1 : 0) ||
    input.boards.some((board) => !Array.isArray(board) || board.length !== boardLength)
  )
    throw new Error('joint_cards_invalid_count');
  const validCard = (card: Card) =>
    card &&
    typeof card.rank === 'string' &&
    card.rank.length === 1 &&
    ranks.includes(card.rank) &&
    suits.includes(card.suit) &&
    (rules.deckSize !== 36 || ranks.indexOf(card.rank) >= 4);
  const all = [...input.heroCards, ...dead, ...input.boards.flat()];
  if (all.some((card) => !validCard(card))) throw new Error('joint_cards_invalid_card');
  const physical: Card[] = [...input.heroCards, ...dead];
  const firstBoard = input.boards[0];
  for (let index = 0; index < input.boards.length; index++) {
    const board = input.boards[index];
    if (index > 0 && prefix > 0)
      for (let card = 0; card < prefix; card++)
        if (cardKey(board[card]) !== cardKey(firstBoard[card]))
          throw new Error('joint_cards_prefix_mismatch');
    physical.push(...board.slice(index > 0 ? prefix : 0));
  }
  const known = new Set(physical.map(cardKey));
  if (known.size !== physical.length) throw new Error('joint_cards_collision');
  const availableCards = suits
    .flatMap((suit) =>
      [...ranks]
        .filter((rank) => rules.deckSize !== 36 || ranks.indexOf(rank) >= 4)
        .map((rank) => ({ rank: rank as Card['rank'], suit }))
    )
    .filter((card) => !known.has(cardKey(card)));
  // Opponent discards remain physically occupied unknown cards. Removing a
  // folded player from this count would let their original deal re-enter a board.
  const unknownHoleCards = (input.dealtSeats - 1) * rules.holeCardsDealt;
  const unknownRunoutCards = input.boards.reduce((n, board) => n + 5 - board.length, 0);
  if (unknownHoleCards + unknownRunoutCards > availableCards.length)
    throw new Error('joint_cards_deck_exhausted');
  return {
    variant: input.variant,
    deckSize: rules.deckSize,
    boardCount: input.boards.length,
    sharedPrefixLength: prefix,
    physicalKnownCards: physical.map((card) => ({ ...card })),
    boards: input.boards.map((board: readonly Card[]) => board.map((card) => ({ ...card }))),
    availableCards,
    unknownHoleCards,
    unknownRunoutCards,
  };
}
