/** Offline reference for the complete physical multiboard payout. Production
 * card scoring, pot construction, board splitting and winner functions never
 * supply an answer. Existing independent Omaha and remaining-game references
 * own ranking; this composes every board with independently built pot rights. */
import type { Card } from '../types.js';
import {
  contributionLayers,
  physicalBoardCards,
  settleOmahaReference,
  type OmahaVariant,
  type ReferencePlayer,
  type ReferenceAward,
} from './OmahaReference.js';
import { referenceRemainingHigh, validateReferenceCards } from './RemainingVariantReference.js';

export type JointReferenceVariant = OmahaVariant | 'nlh' | 'flh' | 'pineapple' | 'short_deck';
export function settleJointBoardReference(input: {
  variant: JointReferenceVariant;
  players: ReferencePlayer[];
  boards: Card[][];
  knownDeadCards?: Card[];
  sharedPrefixLength?: 0 | 3 | 4;
  chipUnit: 0.01 | 1;
  dealerSeat: number;
}) {
  if (
    !['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'flh', 'pineapple', 'short_deck'].includes(
      input.variant
    )
  )
    throw new Error('Unknown joint reference variant');
  if (![0, 3, 4].includes(input.sharedPrefixLength ?? 0))
    throw new Error('Invalid joint reference prefix');
  const physicalBoards = physicalBoardCards(input.boards, input.sharedPrefixLength);
  validateReferenceCards(
    [...physicalBoards, ...input.players.flatMap((p) => p.cards), ...(input.knownDeadCards ?? [])],
    input.variant === 'short_deck'
  );
  if (['plo4', 'plo5', 'plo6', 'plo8', 'flo8'].includes(input.variant))
    return settleOmahaReference({ ...input, variant: input.variant as OmahaVariant });
  if (
    input.boards.some((board) => board.length !== 5) ||
    input.players.some((p) => p.cards.length !== 2) ||
    !Number.isInteger(input.dealerSeat) ||
    input.dealerSeat < 1 ||
    input.dealerSeat > 10
  )
    throw new Error('Invalid joint reference showdown');
  const variant =
    input.variant === 'nlh' ? 'flh' : (input.variant as 'flh' | 'pineapple' | 'short_deck');
  const { pots, refunds } = contributionLayers(input.players, input.chipUnit);
  const scores = input.boards.map(
    (board) =>
      new Map(
        input.players
          .filter((p) => !p.folded)
          .map((p) => [p.id, referenceRemainingHigh(variant, p.cards, board).score])
      )
  );
  const awards: ReferenceAward[] = [];
  const totals = Object.fromEntries(input.players.map((p) => [p.id, 0]));
  for (let potIndex = 0; potIndex < pots.length; potIndex++) {
    const pot = pots[potIndex],
      units = Math.round(pot.amount / input.chipUnit);
    for (let boardIndex = 0; boardIndex < input.boards.length; boardIndex++) {
      const boardUnits =
        Math.floor(units / input.boards.length) + Number(boardIndex < units % input.boards.length);
      const best = Math.max(...pot.eligible.map((id) => scores[boardIndex].get(id)!));
      const winners = input.players
        .filter((p) => pot.eligible.includes(p.id) && scores[boardIndex].get(p.id) === best)
        .sort(
          (a, b) =>
            Number(a.seat <= input.dealerSeat) - Number(b.seat <= input.dealerSeat) ||
            a.seat - b.seat
        );
      if (!winners.length) throw new Error('Joint reference has no eligible winner');
      winners.forEach((player, index) => {
        const amount =
          (Math.floor(boardUnits / winners.length) + Number(index < boardUnits % winners.length)) *
          input.chipUnit;
        totals[player.id] += amount;
        if (amount)
          awards.push({ playerId: player.id, potIndex, boardIndex, half: 'high', amount });
      });
    }
  }
  const contributed = input.players.reduce((n, p) => n + p.contributed, 0);
  const distributed = [...Object.values(totals), ...Object.values(refunds)].reduce(
    (a, b) => a + b,
    0
  );
  if (Math.abs(contributed - distributed) > input.chipUnit / 1e4)
    throw new Error('Joint reference failed conservation');
  return {
    version: 'joint-board-reference-round1-v1',
    pots,
    refunds,
    awards,
    totals,
    contributed,
    distributed,
  };
}
