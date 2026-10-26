import type { AlternativeActionReference } from './contract.js';
import type { RiverReferenceInput } from './riverReference.js';
import { produceRiverCallFoldReference } from './riverReference.js';
import {
  settleJointBoardReference,
  type JointReferenceVariant,
} from '../../benchmark/JointBoardReference.js';
import { evidenceDigest } from './authority.js';
import { chipCents } from './eligibility.js';
export interface RiverIndependentReview {
  version: 'horse-river-independent-review-v1';
  status: 'numerically_consistent' | 'unavailable' | 'mismatch';
  reason: string;
  checkedCombinations: number;
  referenceDigest: string | null;
  qualified: false;
  activationAllowed: false;
}
/** Offline only: the independent benchmark scorer and contribution layers
 * supply the numerical answer. Producer output never supplies that answer.
 * Agreement does not authenticate original source, calibrate its range or
 * grant a production signature; those remain separate review obligations. */
export function reviewRiverEnumeration(
  input: RiverReferenceInput,
  reference: AlternativeActionReference
): RiverIndependentReview {
  let checked = 0;
  let referenceDigest: string | null = null;
  const result = (
    status: RiverIndependentReview['status'],
    reason: string
  ): RiverIndependentReview => ({
    status,
    version: 'horse-river-independent-review-v1',
    reason,
    checkedCombinations: checked,
    referenceDigest,
    qualified: false,
    activationAllowed: false,
  });
  try {
    const produced = produceRiverCallFoldReference(input);
    if (produced.status !== 'produced') return result('unavailable', produced.reason);
    if (evidenceDigest(reference) !== evidenceDigest(produced.reference))
      return result('unavailable', 'producer_reference_binding_mismatch');
    referenceDigest = evidenceDigest(reference);
    const gs = input.original.snapshot.gameState,
      hero = input.original.snapshot.player;
    // The independent layer reference has no shared-dead-money/individual-ante
    // representation. Refuse those states instead of flattening pot rights.
    if (
      gs.players.length !== 2 ||
      gs.dealtSeatIds?.length !== 2 ||
      gs.players.some(
        (p) => p.is_folded || (p.deadInvested ?? 0) !== 0 || (p.individualAnteInvested ?? 0) !== 0
      )
    )
      return result('unavailable', 'independent_pot_domain_unavailable');
    const opponent = gs.players.find((p) => p.user_id !== hero.user_id)!;
    let weight = 0,
      weightedReturn = 0;
    for (const row of input.range) {
      const settled = settleJointBoardReference({
        variant: input.domain.variant as JointReferenceVariant,
        players: gs.players.map((p) => ({
          id: p.user_id,
          seat: p.seat,
          cards: p.user_id === hero.user_id ? input.hero : row.cards,
          contributed: p.totalInvested + (p.user_id === hero.user_id ? input.toCall : 0),
        })),
        boards: [input.board],
        chipUnit: 0.01,
        dealerSeat: gs.dealerSeat!,
      });
      const ids = [...new Set(settled.awards.map((a) => a.playerId))];
      const entitlements = ids.map((id) => Math.round(settled.totals[id]! * 100));
      const gross = entitlements.reduce((a, b) => a + b, 0),
        r = gs.rakeConfig!;
      const tier = r.playerCountCaps
        ?.slice()
        .sort((a, b) => b.players - a.players)
        .find((c) => 2 >= c.players);
      const rake = Math.min(
        gross,
        Math.round((tier?.cap ?? r.cap) * 100),
        Math.round((gross * Math.min(r.percent, 5)) / 100)
      );
      const b = gs.bbjConfig;
      const bbj =
        b?.enabled && 2 >= b.minPlayersDealt
          ? Math.min(gross - rake, Math.round(input.bigBlind * b.feeBB * 100))
          : 0;
      if (rake + bbj !== chipCents(input.finalRake))
        return result('mismatch', 'independent_deduction_mismatch');
      if (gross <= 0 || !ids.every((id) => id === hero.user_id || id === opponent.user_id))
        return result('unavailable', 'independent_award_invalid');
      const target = gross - rake - bbj;
      // Exact integer rational rounding, independent of the production scaler.
      const net = entitlements.map((n) =>
        Number((2n * BigInt(n) * BigInt(target) + BigInt(gross)) / (2n * BigInt(gross)))
      );
      const residual = target - net.reduce((a, b) => a + b, 0);
      if (Math.abs(residual) > net.length)
        return result('unavailable', 'independent_rounding_invalid');
      let remaining = residual;
      for (let j = 0; j < net.length && remaining !== 0; j++) {
        if (remaining > 0 && net[j]! < entitlements[j]!) {
          net[j]++;
          remaining--;
        } else if (remaining < 0 && net[j]! > 0) {
          net[j]--;
          remaining++;
        }
      }
      if (remaining !== 0) return result('unavailable', 'independent_rounding_unresolved');
      const index = ids.indexOf(hero.user_id);
      const returned = (index < 0 ? 0 : net[index]!) / 100 + (settled.refunds[hero.user_id] ?? 0);
      weightedReturn += returned * row.weight;
      weight += row.weight;
      checked++;
    }
    const expected = (weightedReturn / weight - input.toCall) / input.bigBlind;
    const call = reference.alternatives.find((a) => a.choice.action === 'call')?.mean;
    if (!Number.isFinite(expected) || call === undefined || Math.abs(expected - call) > 1e-10)
      return result('mismatch', 'independent_call_value_mismatch');
    return result('numerically_consistent', 'independent_finite_range_agreement');
  } catch {
    return result('unavailable', 'independent_review_unreadable');
  }
}
