import { describe, it } from 'vitest';
import type { Card } from '../../types.js';
import {
  omahaVariantHandQuality,
  omahaVariantHandShape,
  OMAHA_VARIANT_PACKS,
} from './OmahaVariantPolicyPack.js';

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
