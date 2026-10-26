import type { HorseDecision } from '../types.js';
import {
  liveHorsePhase14Authorities,
  horsePhase14AuthorityVerdict,
} from './HorsePhase14Authority.js';
import {
  withdrawHorsePhase14Selection,
  recordHorsePhase14Verdict,
} from './HorseExecutionWitness.js';
import { noteFire } from './BrainTelemetry.js';
/** Request-owned last check, shared by physical and Lightning action doors. */
export function recheckHorsePhase14BeforeAcceptance(decision: HorseDecision): HorseDecision {
  const receipt = decision.correctivePolicy;
  if (!receipt?.applied) return decision;
  const verdict = horsePhase14AuthorityVerdict(receipt);
  noteFire(`phase14_authority_verdict_${verdict}`);
  if (verdict === 'usable') {
    recordHorsePhase14Verdict(decision.executionWitness, verdict);
    return decision;
  }
  withdrawHorsePhase14Selection(decision.executionWitness, verdict);
  receipt.applied = false;
  receipt.reason = 'withdrawn_before_acceptance';
  receipt.selected = { ...receipt.baseline };
  noteFire('phase14_selection_withdrawn_before_acceptance');
  return { ...decision, action: receipt.baseline.action, amount: receipt.baseline.amount };
}
/** Called after the existing controller witness settles, never on submission. */
export function observeHorsePhase14Execution(decision: HorseDecision): void {
  const receipt = decision.correctivePolicy,
    witness = decision.executionWitness;
  if (!receipt || !witness) return;
  noteFire(`phase14_execution_${witness.executionStatus}`);
  if (witness.phase14Authority?.selection === 'controller_accepted')
    noteFire('phase14_selection_controller_accepted');
  else if (receipt.applied && ['coerced', 'fallback'].includes(witness.executionStatus)) {
    liveHorsePhase14Authorities[receipt.domain]?.withdraw(
      `controller_${witness.executionStatus}_candidate`
    );
    noteFire('phase14_authority_controller_withdrawn');
  }
}
