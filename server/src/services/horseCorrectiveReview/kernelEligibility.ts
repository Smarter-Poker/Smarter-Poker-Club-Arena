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
