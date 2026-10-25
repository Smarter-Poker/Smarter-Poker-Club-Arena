import { correctiveDecisionDomain, correctiveDomainIsValid } from './domain.js';
import type { HorseDecision } from '../../types.js';
import type { RiverDecisionInput } from './riverReference.js';
/** Shared by live execution and full-policy measurement, before sampling. */
export function correctiveBaselineRefusal(
  original: RiverDecisionInput['original'],
  baseline: HorseDecision
): string | null {
  if (baseline.action === 'fold' && baseline.continuationGuard) return 'protected_continuation';
  if (
    [
      baseline.tournamentPostflop,
      baseline.plo4Policy,
      baseline.omahaVariantPolicy,
      baseline.remainingVariantPolicy,
      baseline.jointPolicy,
    ].some((r) => r?.applied)
  )
    return 'earlier_phase_applied';
  if (baseline.action !== 'fold' && baseline.action !== 'call') return 'baseline_outside_family';
  // HorseLogic's legalizer converts a stack-sized call to all_in. This kernel
  // prices fold/call only, so a change on that boundary must remain inactive.
  const gs = original.snapshot.gameState,
    hero = original.snapshot.player;
  if (!Number.isFinite(gs.toCall) || gs.toCall! <= 0 || gs.toCall! >= hero.stack)
    return 'call_requires_all_in_alias';
  return null;
}

/** Necessary original-state family checks, before worker observation capture.
 * The calculator reuses these exact checks; passing does not grant authority
 * or establish a profitable/legal correction. No reads, I/O or RNG. */
export function correctiveRiverSnapshotRefusal(
  snapshot: RiverDecisionInput['original']['snapshot']
): string | null {
  const gs = snapshot.gameState,
    hero = snapshot.player,
    domain = correctiveDecisionDomain(gs);
  if (!correctiveDomainIsValid(domain) || domain.format !== 'cash' || domain.mode !== 'cash')
    return 'unsupported_utility_domain';
  if (
    !['chips', 'diamonds'].includes(gs.asset ?? '') ||
    typeof gs.chipUnit !== 'number' ||
    !Number.isFinite(gs.chipUnit) ||
    gs.chipUnit <= 0 ||
    !Array.isArray(gs.dealtSeatIds) ||
    gs.dealtSeatIds.length < 2 ||
    new Set(gs.dealtSeatIds).size !== gs.dealtSeatIds.length ||
    gs.dealtSeatIds.some((seat) => !Number.isSafeInteger(seat)) ||
    gs.players.some((player) =>
      [player.deadInvested ?? 0, player.individualAnteInvested ?? 0].some(
        (value) => !Number.isFinite(value) || value < 0
      )
    )
  )
    return 'original_model_metadata_unavailable';
  if (gs.asset !== 'chips' || gs.chipUnit !== 0.01) return 'original_model_money_unit_unsupported';
  // The independent layer/terminal oracle represents exactly two dealt seats
  // and has no shared dead-money or individual-ante ownership representation.
  // A qualified catalog must never silently extend into those geometries.
  if (
    gs.dealtSeatIds.length !== 2 ||
    gs.players.some(
      (player) => (player.deadInvested ?? 0) > 0 || (player.individualAnteInvested ?? 0) > 0
    )
  )
    return 'original_model_pot_domain_unsupported';
  if (
    gs.stage !== 'river' ||
    gs.boardCount !== 1 ||
    gs.communityCards2?.length ||
    gs.communityCards3?.length ||
    gs.players.length !== 2 ||
    gs.players.some((p) => p.is_folded || (p.user_id !== hero.user_id && p.cards.length > 0))
  )
    return 'original_model_domain_unavailable';
  const opponent = gs.players.find((p) => p.user_id !== hero.user_id);
  if (!opponent?.is_all_in || opponent.stack !== 0) return 'original_opponent_not_all_in';
  return null;
}
