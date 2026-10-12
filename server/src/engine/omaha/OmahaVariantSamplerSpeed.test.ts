import { describe, it } from 'vitest';
import type { Card } from '../../types.js';
import {
  omahaVariantHandQuality,
  omahaVariantHandShape,
  OMAHA_VARIANT_PACKS,
} from './OmahaVariantPolicyPack.js';
import { scoreOmahaHi, scoreOmahaHiPartial, scoreOmahaLow } from '../HorseEval.js';
import { omahaSamplerScoring } from './OmahaVariantSampler.js';

const RANKS = '23456789TJQKA';
const SUITS: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
const DECK: Card[] = SUITS.flatMap((suit) =>
  RANKS.split('').map((rank) => ({ rank: rank as Card['rank'], suit }))
);

describe('Phase 11 sampler hand quality', () => {
  it.each(['plo5', 'plo6', 'plo8'] as const)(
    '%s: the fast quality is bit-identical to omahaVariantHandShape over 200,000 hands',
    (variant) => {
      let state = 0x9e3779b9 ^ variant.charCodeAt(3);
      const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
      };
      for (let i = 0; i < 200_000; i++) {
        const deck = DECK.slice();
        const cards = Array.from(
          { length: OMAHA_VARIANT_PACKS[variant].holes },
          () => deck.splice(Math.floor(random() * deck.length), 1)[0]
        );
        const fast = omahaVariantHandQuality(variant, cards);
        const full = omahaVariantHandShape(variant, cards).quality;
        if (!Object.is(fast, full))
          throw new Error(`${variant} ${JSON.stringify(cards)}: ${fast} !== ${full}`);
      }
    }
  );
});

describe('Phase 11 sampler integer scoring', () => {
  const {
    codeOf,
    newTriples,
    loadTriples,
    omahaHiFast,
    omahaHiTable,
    omahaLowFast,
    rankPairTable,
  } = omahaSamplerScoring;
  it.each([4, 5, 6])(
    '%i-card hands: high, partial high and low are bit-identical to HorseEval over 150,000 deals',
    (holes) => {
      let state = 0x2545f491 ^ holes;
      const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
      };
      const tri = newTriples();
      for (let i = 0; i < 150_000; i++) {
        const deck = DECK.slice();
        const draw = () => deck.splice(Math.floor(random() * deck.length), 1)[0];
        const hole = Array.from({ length: holes }, draw);
        const boardLength = 3 + (i % 3);
        const board = Array.from({ length: boardLength }, draw);
        loadTriples(tri, board.map(codeOf), boardLength);
        const codes = hole.map(codeOf);
        const fastHi = omahaHiFast(codes, tri);
        const refHi =
          boardLength === 5 ? scoreOmahaHi(hole, board) : scoreOmahaHiPartial(hole, board);
        if (!Object.is(fastHi, refHi))
          throw new Error(`hi ${JSON.stringify({ hole, board })}: ${fastHi} !== ${refHi}`);
        const tableHi = omahaHiTable(codes, tri, rankPairTable(tri));
        if (!Object.is(tableHi, refHi))
          throw new Error(`table ${JSON.stringify({ hole, board })}: ${tableHi} !== ${refHi}`);
        if (boardLength === 5) {
          const fastLow = omahaLowFast(codes, tri);
          const refLow = scoreOmahaLow(hole, board);
          if (!Object.is(fastLow, refLow))
            throw new Error(`low ${JSON.stringify({ hole, board })}: ${fastLow} !== ${refLow}`);
        }
      }
    }
  );
});
