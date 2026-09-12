import { remainingVariantSpot, remainingCards } from './RemainingVariantPolicyEvidence.js';
import { settleRemainingReference } from './RemainingVariantReference.js';
import { evaluateRemainingVariantPolicy } from '../engine/remainingVariants/RemainingVariantLivePolicy.js';
import type { OmahaVariantEquityEvidence } from '../engine/omaha/OmahaVariantEquity.js';
import type { RemainingPolicyVariant } from '../engine/remainingVariants/RemainingVariantPolicyPack.js';

const FIXTURES: readonly {
  name: string;
  variant: RemainingPolicyVariant;
  hero: string;
  opponent: string;
  board: string;
  dead?: string;
  share: number;
}[] = Object.freeze([
  {
    name: 'short-deck-flush-beats-full-house',
    variant: 'short_deck',
    hero: 'As Ks',
    opponent: 'Qd 9c',
    board: 'Qs 9s 7s Qh 9h',
    share: 1,
  },
  {
    name: 'short-deck-ace-six-wheel',
    variant: 'short_deck',
    hero: 'As 6s',
    opponent: 'Ks Qc',
    board: '7h 8c 9d Kh Qd',
    share: 1,
  },
  {
    name: 'pineapple-retained-nut-flush',
    variant: 'pineapple',
    hero: 'As Ks',
    dead: '2d',
    opponent: 'Ah Ad',
    board: 'Qs Js 7s 4c 5c',
    share: 1,
  },
  {
    name: 'pineapple-known-discard-cannot-make-quads',
    variant: 'pineapple',
    hero: '9s 9d',
    dead: '9h',
    opponent: 'As Ad',
    board: '9c 7h 3s 2d Ac',
    share: 0,
  },
  {
    name: 'flh-board-royal-tie',
    variant: 'flh',
    hero: '2c 3d',
    opponent: '8c 9d',
    board: 'As Ks Qs Js Ts',
    share: 0.5,
  },
  {
    name: 'flh-full-house-beats-flush',
    variant: 'flh',
    hero: 'Qd 9c',
    opponent: 'As Ks',
    board: 'Qs 9s 7s Qh 9h',
    share: 1,
  },
  {
    name: 'flo8-quartered-low',
    variant: 'flo8',
    hero: 'As 2s Jh Td',
    opponent: 'Ah 2h Kh Kd',
    board: '3c 4d 8h Kc Qh',
    share: 0.25,
  },
  {
    name: 'flo8-no-low-high-scoop',
    variant: 'flo8',
    hero: 'As Ad Ks Kd',
    opponent: '2c 3d 4h 5d',
    board: 'Qs Js Ts Qc Jc',
    share: 1,
  },
]);

/** Terminal known-card goldens. Exact shares certify rules and per-pot pricing;
 * they are not confidence claims about an unknown live opponent range. */
export function remainingVariantReferenceSpots() {
  return FIXTURES.map((f) => {
    const s = remainingVariantSpot(f.variant);
    s.hero.cards = remainingCards(f.hero);
    s.state.communityCards = remainingCards(f.board);
    if (f.dead) s.hero.knownDeadCards = remainingCards(f.dead);
    const cost = Math.min(s.hero.stack, s.state.toCall!);
    const players = s.state.players.map((p, i) => ({
      id: p.user_id,
      seat: p.seat,
      contributed: p.totalInvested + (i === 0 ? cost : 0),
      cards: i === 0 ? s.hero.cards : remainingCards(f.opponent),
      folded: false,
    }));
    const reference = settleRemainingReference({
      variant: f.variant,
      players,
      board: s.state.communityCards,
      knownDeadCards: s.hero.knownDeadCards,
      chipUnit: 0.01,
      dealerSeat: s.state.dealerSeat!,
    });
    const perPot = reference.pots.flatMap((p, potIndex) => {
      if (!p.eligible.includes(s.hero.user_id)) return [];
      const awards = reference.awards.filter(
        (a) => a.potIndex === potIndex && a.playerId === s.hero.user_id
      );
      const low =
        awards.filter((a) => 'half' in a && a.half === 'low').reduce((n, a) => n + a.amount, 0) /
        p.amount;
      const total = awards.reduce((n, a) => n + a.amount, 0) / p.amount;
      return [
        {
          amount: p.amount,
          eligiblePlayers: p.eligible,
          highEquity: total - low,
          lowEquity: low,
          equity: total,
        },
      ];
    });
    const eligiblePot = perPot.reduce((n, p) => n + p.amount, 0),
      share = reference.totals[s.hero.user_id] / eligiblePot;
    if (Math.abs(share - f.share) > 1e-9)
      throw new Error(`Independent reference failed: ${f.name}`);
    const high = perPot.reduce((n, p) => n + p.amount * p.highEquity, 0) / eligiblePot;
    const evidence: OmahaVariantEquityEvidence = {
      analysisMs: 0,
      equity: share,
      highEquity: high,
      lowEquity: share - high,
      samples: 1,
      standardError: 0,
      confidence99: [share, share],
      scoopProbability: Number(share === 1),
      quarterOrLessProbability: Number(share > 0 && share <= 0.25),
      sixthOrLessProbability: Number(share > 0 && share <= 1 / 6),
      eligiblePot,
      expectedChips: share * eligiblePot,
      minimumObservedShare: share,
      maximumObservedShare: share,
      distribution: [{ share, probability: 1 }],
      perPot,
      provenance: 'independent_offline_oracle',
    };
    const policy = evaluateRemainingVariantPolicy(
      s.hero,
      s.state,
      s.baseline,
      evidence,
      'candidate',
      () => 0,
      1,
      false
    );
    if (!policy.receipt.fired)
      throw new Error(
        `Independent policy fixture did not fire: ${f.name}: ${policy.receipt.reason}`
      );
    return {
      name: f.name,
      variant: f.variant,
      expectedShare: f.share,
      reference,
      policy,
      evidenceScope: 'exact_terminal_known_cards_not_live_range_equity',
    };
  });
}
