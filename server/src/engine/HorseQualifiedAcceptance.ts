import type { HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import type { HorseAuthorityVerdict } from './HorseQualifiedAuthority.js';
import { liveHorsePhase8Authority } from './HorseQualifiedAuthority.js';
import { liveHorsePhase10Authority } from './HorsePhase10Authority.js';
import { liveHorsePhase11Authorities } from './HorsePhase11Authority.js';
import { liveHorsePhase12Authorities } from './HorsePhase12Authority.js';
import {
  liveHorsePhase13Authorities,
  horsePhase13BoardCountAdmitted,
} from './HorsePhase13Authority.js';
import { isOmahaPolicyVariant } from './omaha/OmahaVariantPolicyPack.js';
import { isRemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';
import { isJointVariant } from './multiway/JointInputBinding.js';
import { recheckHorsePhase8GuardBeforeAcceptance } from './HorsePhase8GuardAcceptance.js';
import {
  recordHorsePhase8Verdict,
  recordHorsePhase10Verdict,
  recordHorsePhase11Verdict,
  recordHorsePhase12Verdict,
  recordHorsePhase13Verdict,
  withdrawHorsePhase8Selection,
  withdrawHorsePhase10Selection,
  withdrawHorsePhase11Selection,
  withdrawHorsePhase12Selection,
  withdrawHorsePhase13Selection,
} from './HorseExecutionWitness.js';
/** Same existing release gates and reference selections used by classic turns.
 * Called synchronously at Lightning's controller door after its think delay. */
export function recheckHorseQualifiedBeforeAcceptance(
  decision: HorseDecision,
  snapshot: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>
): HorseDecision {
  let result = recheckHorsePhase8GuardBeforeAcceptance(decision, snapshot);
  const p11 = result.omahaVariantPolicy,
    p12 = result.remainingVariantPolicy,
    p13 = result.jointPolicy;
  const jointGate =
    p13 && isJointVariant(p13.variant) ? liveHorsePhase13Authorities[p13.variant] : null;
  const checks = [
    {
      ledger: result.tournamentPostflop,
      gate: liveHorsePhase8Authority,
      record: recordHorsePhase8Verdict,
      withdraw: withdrawHorsePhase8Selection,
    },
    {
      ledger: result.plo4Policy,
      gate: liveHorsePhase10Authority,
      record: recordHorsePhase10Verdict,
      withdraw: withdrawHorsePhase10Selection,
    },
    {
      ledger: p11,
      gate:
        p11 && isOmahaPolicyVariant(p11.variant) ? liveHorsePhase11Authorities[p11.variant] : null,
      record: recordHorsePhase11Verdict,
      withdraw: withdrawHorsePhase11Selection,
    },
    {
      ledger: p12,
      gate:
        p12 && isRemainingPolicyVariant(p12.variant)
          ? liveHorsePhase12Authorities[p12.variant]
          : null,
      record: recordHorsePhase12Verdict,
      withdraw: withdrawHorsePhase12Selection,
    },
    {
      ledger: p13,
      gate: jointGate,
      record: recordHorsePhase13Verdict,
      withdraw: withdrawHorsePhase13Selection,
    },
  ];
  for (const { ledger, gate, record, withdraw } of checks) {
    if (!ledger?.applied) continue;
    let verdict: HorseAuthorityVerdict = gate ? gate.check(ledger.authority) : 'mismatched';
    if (
      ledger === p13 &&
      verdict === 'usable' &&
      !horsePhase13BoardCountAdmitted(jointGate?.mainAuthority(), p13.boardCount)
    )
      verdict = 'mismatched';
    ledger.authorityVerdict = verdict;
    if (verdict === 'usable') {
      record(result.executionWitness, verdict);
      continue;
    }
    withdraw(result.executionWitness, snapshot, verdict);
    ledger.applied = false;
    ledger.selection = 'withdrawn_before_acceptance';
    if ('finalAction' in ledger) {
      ledger.finalAction = ledger.baselineAction;
      ledger.finalAmount = ledger.baselineAmount;
    }
    if (ledger === p13)
      for (const prior of [result.plo4Policy, p11, p12])
        if (prior) {
          prior.finalAction = ledger.baselineAction;
          prior.finalAmount = ledger.baselineAmount;
        }
    result = {
      ...result,
      action: ledger.baselineAction,
      amount: ledger.baselineAmount ?? undefined,
    };
  }
  if (p13 && !p13.applied) {
    p13.finalAction = result.action;
    p13.finalAmount = result.amount ?? null;
  }
  return result;
}
