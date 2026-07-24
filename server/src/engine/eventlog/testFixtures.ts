/**
 * Shared test fixtures for the event-sourced engine. Builds a complete,
 * internally-consistent example hand (blinds -> deal -> bets -> showdown ->
 * payout) as an explicit event stream. NOT production code.
 *
 * 3-handed NLH, SB 5 / BB 10, all seats start with 1000 (initial total 3000).
 * Button = seat 1, SB = seat 2, BB = seat 3.
 *   Preflop: btn(1) raises to 30, SB(2) folds, BB(3) calls.
 *   Flop:    BB(3) checks, btn(1) bets 40, BB(3) calls.
 *   Turn:    both check.
 *   River:   BB(3) checks, btn(1) bets 100, BB(3) calls -> showdown.
 *   Payout:  btn(1) wins; rake 5. Pot = 345, paid 340.
 * Expected final stacks: seat1 1170, seat2 995, seat3 830; rakeTaken 5.
 */

import type { Card, CardRank, CardSuit } from '../../types.js';
import { HAND_EVENT_SCHEMA_VERSION, type HandEvent, type HandEventBody } from './events.js';

export const HAND_ID = 'hand-test-0001';

function card(rank: CardRank, suit: CardSuit): Card {
  return { rank, suit };
}

/** Stamp a bare event body with sequential seq + fixed ts + version + handId. */
function build(bodies: HandEventBody[]): HandEvent[] {
  return bodies.map(
    (b, i) =>
      ({
        ...b,
        handId: HAND_ID,
        seq: i,
        ts: 1_700_000_000_000 + i * 1000,
        v: HAND_EVENT_SCHEMA_VERSION,
      }) as HandEvent
  );
}

export function buildExampleHand(): HandEvent[] {
  return build([
    {
      type: 'HandStarted',
      seed: 424242,
      handNumber: 1,
      buttonSeat: 1,
      players: [
        { seat: 1, userId: 'u1', stack: 1000 },
        { seat: 2, userId: 'u2', stack: 1000 },
        { seat: 3, userId: 'u3', stack: 1000 },
      ],
      stakes: { smallBlind: 5, bigBlind: 10 },
    },
    {
      type: 'BlindsPosted',
      postings: [
        { seat: 2, kind: 'small_blind', amount: 5 },
        { seat: 3, kind: 'big_blind', amount: 10 },
      ],
    },
    {
      type: 'HoleCardsDealt',
      cardsPerPlayer: 2,
      hands: [
        { seat: 1, cards: [card('A', 'spades'), card('K', 'spades')] },
        { seat: 2, cards: [card('7', 'hearts'), card('2', 'clubs')] },
        { seat: 3, cards: [card('Q', 'diamonds'), card('Q', 'clubs')] },
      ],
    },
    // Preflop
    { type: 'PlayerActed', seat: 1, action: 'raise', amount: 30 },
    { type: 'PlayerActed', seat: 2, action: 'fold', amount: 0 },
    { type: 'PlayerActed', seat: 3, action: 'call', amount: 0 },
    // Flop
    {
      type: 'StreetAdvanced',
      street: 'flop',
      board: [card('A', 'hearts'), card('Q', 'spades'), card('2', 'diamonds')],
    },
    { type: 'PlayerActed', seat: 3, action: 'check', amount: 0 },
    { type: 'PlayerActed', seat: 1, action: 'bet', amount: 40 },
    { type: 'PlayerActed', seat: 3, action: 'call', amount: 0 },
    // Turn
    {
      type: 'StreetAdvanced',
      street: 'turn',
      board: [card('A', 'hearts'), card('Q', 'spades'), card('2', 'diamonds'), card('9', 'clubs')],
    },
    { type: 'PlayerActed', seat: 3, action: 'check', amount: 0 },
    { type: 'PlayerActed', seat: 1, action: 'check', amount: 0 },
    // River
    {
      type: 'StreetAdvanced',
      street: 'river',
      board: [
        card('A', 'hearts'),
        card('Q', 'spades'),
        card('2', 'diamonds'),
        card('9', 'clubs'),
        card('5', 'hearts'),
      ],
    },
    { type: 'PlayerActed', seat: 3, action: 'check', amount: 0 },
    { type: 'PlayerActed', seat: 1, action: 'bet', amount: 100 },
    { type: 'PlayerActed', seat: 3, action: 'call', amount: 0 },
    // Showdown + payout
    {
      type: 'ShowdownRevealed',
      reveals: [
        { seat: 1, userId: 'u1', cards: [card('A', 'spades'), card('K', 'spades')] },
        { seat: 3, userId: 'u3', cards: [card('Q', 'diamonds'), card('Q', 'clubs')] },
      ],
    },
    {
      type: 'PotAwarded',
      payouts: [{ seat: 1, userId: 'u1', amount: 340, potIndex: 0 }],
      rake: 5,
    },
    { type: 'HandEnded', handNumber: 1 },
  ]);
}

/** A hand that deals hole cards + board purely from the seed (no explicit cards). */
export function buildSeedOnlyHand(): HandEvent[] {
  return build([
    {
      type: 'HandStarted',
      seed: 987654,
      handNumber: 2,
      buttonSeat: 1,
      players: [
        { seat: 1, userId: 'u1', stack: 500 },
        { seat: 2, userId: 'u2', stack: 500 },
      ],
      stakes: { smallBlind: 5, bigBlind: 10 },
    },
    {
      type: 'BlindsPosted',
      postings: [
        { seat: 1, kind: 'small_blind', amount: 5 },
        { seat: 2, kind: 'big_blind', amount: 10 },
      ],
    },
    { type: 'HoleCardsDealt', cardsPerPlayer: 2 },
    { type: 'PlayerActed', seat: 1, action: 'call', amount: 0 },
    { type: 'PlayerActed', seat: 2, action: 'check', amount: 0 },
    { type: 'StreetAdvanced', street: 'flop' },
    { type: 'PlayerActed', seat: 2, action: 'check', amount: 0 },
    { type: 'PlayerActed', seat: 1, action: 'check', amount: 0 },
    { type: 'StreetAdvanced', street: 'turn' },
    { type: 'PlayerActed', seat: 2, action: 'check', amount: 0 },
    { type: 'PlayerActed', seat: 1, action: 'check', amount: 0 },
    { type: 'StreetAdvanced', street: 'river' },
    { type: 'PlayerActed', seat: 2, action: 'check', amount: 0 },
    { type: 'PlayerActed', seat: 1, action: 'check', amount: 0 },
    {
      type: 'PotAwarded',
      payouts: [{ seat: 1, userId: 'u1', amount: 20, potIndex: 0 }],
      rake: 0,
    },
    { type: 'HandEnded', handNumber: 2 },
  ]);
}
