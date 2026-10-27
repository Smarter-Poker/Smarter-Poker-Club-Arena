/** Mechanical offline mirror of client.ts FAST receipt stamping and the
 * physical/Lightning doors' maintained last Phase 14 acceptance check.
 * Uses the REAL default main admissions and actual returned worker receipts;
 * never supplies a test authority, epoch, catalog or qualified result. */
import {
  liveHorsePhase8Authority,
  type HorsePhase8AuthorityGate,
  type HorseAuthorityReceipt,
} from '../engine/HorseQualifiedAuthority.js';
import { liveHorsePhase10Authority } from '../engine/HorsePhase10Authority.js';
import { liveHorsePhase11Authorities } from '../engine/HorsePhase11Authority.js';
import { liveHorsePhase12Authorities } from '../engine/HorsePhase12Authority.js';
import { liveHorsePhase13Authorities } from '../engine/HorsePhase13Authority.js';
import { liveHorsePhase14Authorities } from '../engine/HorsePhase14Authority.js';
import { recheckHorsePhase14BeforeAcceptance } from '../engine/HorsePhase14Acceptance.js';
import {
  CORRECTIVE_DOMAINS,
  correctiveDomainKey,
} from '../services/horseCorrectiveReview/domain.js';
import { horseJournalJson } from '../services/horseDecisionJournal/record.js';
import type { FastHorseDecisionResult } from '../engine/horseDecision/protocol.js';

const p11 = liveHorsePhase11Authorities as Readonly<Record<string, HorsePhase8AuthorityGate>>;
const p12 = liveHorsePhase12Authorities as Readonly<Record<string, HorsePhase8AuthorityGate>>;
const p13 = liveHorsePhase13Authorities as Readonly<Record<string, HorsePhase8AuthorityGate>>;
function eachMirror(
  result: FastHorseDecisionResult,
  fn: (gate: HorsePhase8AuthorityGate, receipt: HorseAuthorityReceipt) => void
) {
  if (result.phase8Authority) fn(liveHorsePhase8Authority, result.phase8Authority);
  if (result.phase10Authority) fn(liveHorsePhase10Authority, result.phase10Authority);
  for (const [receipts, gates] of [
    [result.phase11Authority, p11],
    [result.phase12Authority, p12],
    [result.phase13Authority, p13],
    [result.phase14Authority, liveHorsePhase14Authorities],
  ] as const)
    for (const [variant, receipt] of Object.entries(receipts ?? {}))
      if (gates[variant]) fn(gates[variant], receipt);
}
export function forgetFeatureAblationWorkerMirrors(result: FastHorseDecisionResult) {
  eachMirror(result, (gate, receipt) => gate.forgetWorker(receipt.epoch));
}
export function mirrorFeatureAblationAcceptance(result: FastHorseDecisionResult) {
  eachMirror(result, (gate, receipt) => {
    gate.ensureAdmitted();
    gate.observeWorker(receipt);
  });
  const d = result.decision;
  let appliedChecks = 0;
  function stamp(
    gate: HorsePhase8AuthorityGate | undefined,
    receipt: HorseAuthorityReceipt | null | undefined,
    applied: boolean
  ) {
    if (!receipt) {
      if (applied) throw Error('Applied policy has no original worker authority');
      return receipt;
    }
    if (!gate) throw Error('Original main policy gate unavailable');
    const stamped = gate.stamp(receipt);
    if (applied) {
      if (gate.check(stamped) !== 'usable')
        throw Error('Applied policy refused by actual main admission');
      appliedChecks++;
    }
    return stamped;
  }
  const applyStamp = (
    receipt: { authority?: HorseAuthorityReceipt | null; applied: boolean } | undefined,
    gate: HorsePhase8AuthorityGate | undefined
  ) => {
    if (!receipt) return;
    const stamped = stamp(gate, receipt.authority, receipt.applied);
    if (stamped) receipt.authority = stamped;
  };
  applyStamp(d.tournamentPostflop, liveHorsePhase8Authority);
  applyStamp(d.plo4Policy, liveHorsePhase10Authority);
  applyStamp(
    d.omahaVariantPolicy,
    d.omahaVariantPolicy ? p11[d.omahaVariantPolicy.variant] : undefined
  );
  applyStamp(
    d.remainingVariantPolicy,
    d.remainingVariantPolicy ? p12[d.remainingVariantPolicy.variant] : undefined
  );
  applyStamp(d.jointPolicy, d.jointPolicy ? p13[d.jointPolicy.variant] : undefined);
  const corrective = d.correctivePolicy;
  if (corrective?.baselineAuthorities) {
    const domain = CORRECTIVE_DOMAINS.find((x) => correctiveDomainKey(x) === corrective.domain);
    if (!domain) throw Error('Original corrective domain invalid');
    const v = domain.variant;
    const mirrors = {
      phase8: result.phase8Authority,
      phase10: result.phase10Authority,
      phase11: result.phase11Authority?.[v as keyof NonNullable<typeof result.phase11Authority>],
      phase12: result.phase12Authority?.[v as keyof NonNullable<typeof result.phase12Authority>],
      phase13: result.phase13Authority?.[v as keyof NonNullable<typeof result.phase13Authority>],
    };
    const gates = {
      phase8: liveHorsePhase8Authority,
      phase10: liveHorsePhase10Authority,
      phase11: p11[v],
      phase12: p12[v],
      phase13: p13[v],
    };
    for (const [owner, proof] of Object.entries(corrective.baselineAuthorities)) {
      const key = owner as keyof typeof mirrors;
      if (horseJournalJson(proof) !== horseJournalJson(mirrors[key]))
        throw Error('Corrective baseline authority was not originally mirrored');
      corrective.baselineAuthorities[key] =
        stamp(gates[key], proof, corrective.applied) ?? undefined;
    }
  }
  if (corrective?.authority)
    corrective.authority =
      stamp(
        liveHorsePhase14Authorities[corrective.domain],
        corrective.authority,
        corrective.applied
      ) ?? undefined;
  const before = { action: d.action, amount: d.amount, applied: corrective?.applied };
  const accepted = recheckHorsePhase14BeforeAcceptance(d);
  if (
    accepted.action !== before.action ||
    accepted.amount !== before.amount ||
    corrective?.applied !== before.applied
  )
    throw Error('Original main Phase14 check withdrew/coerced the stable-source proposal');
  return {
    decision: accepted,
    appliedAuthorityChecks: appliedChecks,
    phase14Rechecked: Boolean(corrective?.applied),
  };
}
