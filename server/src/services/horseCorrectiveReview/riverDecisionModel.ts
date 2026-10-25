import type { RiverDecisionInput } from './riverReference.js';
import { priceRiverCallFoldDecision, type RiverDecisionPrices } from './riverReference.js';
import { createHash } from 'node:crypto';
import type { Card } from '../../types.js';
import { correctiveDecisionDomain, correctiveDomainIsValid } from './domain.js';
import { variantInfo } from '../../engine/HorseEval.js';
import { evidenceDigest } from './authority.js';
import { correctiveUtilityContextDigest } from './review.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
export const RIVER_DECISION_MODEL = Object.freeze({
  version: 'river-public-finite-prior-v1',
  samples: 32,
  maximumAttemptsPerCombination: 8,
  calibration: 'unqualified' as const,
});
export type RiverDecisionModelResult =
  | {
      status: 'built';
      modelVersion: string;
      samplingSeedDigest: string;
      input: RiverDecisionInput;
      prices: Extract<RiverDecisionPrices, { status: 'priced' }>;
      qualified: false;
      activationAllowed: false;
    }
  | { status: 'unavailable'; reason: string };
/** A declared finite prior, not calibrated opponent equity. All candidate
 * cards come from the public original state plus hero's own cards. No actor
 * identity, retrospective supplied range, observed opponent holes, RNG state,
 * outcome or future execution/accepted-hand record supplies a sample. */
export function buildOriginalRiverDecision(
  source: RiverDecisionInput['original']
): RiverDecisionModelResult {
  const no = (reason: string): RiverDecisionModelResult => ({ status: 'unavailable', reason });
  try {
    const original = JSON.parse(horseJournalJson(source)) as RiverDecisionInput['original'];
    const snapshot = original.snapshot,
      gs = snapshot.gameState,
      hero = snapshot.player;
    const domain = correctiveDecisionDomain(gs);
    if (!correctiveDomainIsValid(domain) || domain.format !== 'cash' || domain.mode !== 'cash')
      return no('unsupported_utility_domain');
    if (
      gs.stage !== 'river' ||
      gs.boardCount !== 1 ||
      gs.communityCards2?.length ||
      gs.communityCards3?.length ||
      gs.players.length !== 2 ||
      gs.players.some((p) => p.is_folded || (p.user_id !== hero.user_id && p.cards.length > 0))
    )
      return no('original_model_domain_unavailable');
    const opponent = gs.players.find((p) => p.user_id !== hero.user_id);
    if (!opponent?.is_all_in || opponent.stack !== 0) return no('original_opponent_not_all_in');
    const vi = variantInfo(domain.variant),
      count = domain.variant === 'pineapple' ? 2 : vi.holeCount;
    const ranks = vi.isShortDeck ? '6789TJQKA' : '23456789TJQKA';
    const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
    const deck: Card[] = suits.flatMap((suit) =>
      [...ranks].map((rank) => ({ rank: rank as Card['rank'], suit }))
    );
    const key = (c: Card) => c.rank + ':' + c.suit;
    const known = [...hero.cards, ...gs.communityCards],
      dead = new Set(known.map(key));
    const universe = new Set(deck.map(key));
    if (
      hero.cards.length !== count ||
      gs.communityCards.length !== 5 ||
      dead.size !== count + 5 ||
      known.some((c) => !universe.has(key(c)))
    )
      return no('original_cards_invalid');
    const available = deck.filter((c) => !dead.has(key(c)));
    if ((gs.actionHistory?.length ?? 0) > 256) return no('original_history_bounds');
    const samplingSeedDigest = evidenceDigest({
      model: RIVER_DECISION_MODEL.version,
      variant: domain.variant,
      heroSeat: hero.seat,
      hero: hero.cards.map(key).sort(),
      board: gs.communityCards.map(key).sort(),
      bigBlind: gs.bigBlind,
      toCall: gs.toCall,
      players: gs.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          seat: p.seat,
          stack: p.stack,
          bet: p.bet,
          totalInvested: p.totalInvested,
          deadInvested: p.deadInvested ?? 0,
          individualAnteInvested: p.individualAnteInvested ?? 0,
          allIn: p.is_all_in,
        })),
      actions: (gs.actionHistory ?? []).map((a) => ({
        seat: gs.players.find((p) => p.user_id === a.userId)?.seat ?? null,
        action: a.action,
        amount: a.amount,
        stage: a.stage,
      })),
    });
    const range: RiverDecisionInput['range'] = [],
      seen = new Set<string>();
    for (let index = 0; index < RIVER_DECISION_MODEL.samples; index++) {
      let added = false;
      for (
        let attempt = 0;
        attempt < RIVER_DECISION_MODEL.maximumAttemptsPerCombination;
        attempt++
      ) {
        const remaining = available.slice(),
          cards: Card[] = [];
        for (let slot = 0; slot < count; slot++) {
          const word = createHash('sha256')
            .update(samplingSeedDigest)
            .update(`:${index}:${attempt}:${slot}`)
            .digest()
            .readUInt32BE(0);
          cards.push(remaining.splice(word % remaining.length, 1)[0]!);
        }
        const combination = cards.map(key).sort().join('|');
        if (seen.has(combination)) continue;
        seen.add(combination);
        range.push({ cards, weight: 1 });
        added = true;
        break;
      }
      if (!added) return no('finite_prior_unique_sample_bound');
    }
    const input: RiverDecisionInput = {
      domain,
      stage: 'river',
      boardCount: 1,
      opponents: 1,
      opponentAllIn: true,
      hero: hero.cards,
      board: gs.communityCards,
      range,
      rangeDigest: evidenceDigest(range),
      rangeReadFrameDigest: evidenceDigest(original.readFrame),
      contestablePot: gs.contestablePot!,
      toCall: Math.min(gs.toCall!, hero.stack),
      stack: hero.stack,
      bigBlind: gs.bigBlind,
      utilityContextDigest: correctiveUtilityContextDigest(snapshot),
      original,
    };
    const prices = priceRiverCallFoldDecision(input);
    if (prices.status !== 'priced') return no(prices.reason);
    const freeze = <T>(value: T): T => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
      }
      return value;
    };
    return freeze({
      status: 'built',
      modelVersion: RIVER_DECISION_MODEL.version,
      samplingSeedDigest,
      input,
      prices,
      qualified: false,
      activationAllowed: false,
    });
  } catch {
    return no('original_model_unreadable');
  }
}
