/** OUTSIDE-TREE, PREPARED/UNEXECUTED v2 census integration. */
import { bindHorseDecisionToCommittedHand } from '../../engine/HorseDecisionHandBinding.js';
import type { HorseExecutionWitness } from '../../engine/HorseExecutionWitness.js';
import type {
  FastHorseDecisionRequest,
  CompletedHandObservation,
} from '../../engine/horseDecision/protocol.js';
import {
  horseJournalJson,
  journalHash,
  type HorseJournalRecord,
} from '../horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../horseDecisionJournal/review.js';
import { evidenceDigest, isVerifiedCorrectiveAuthority } from './authority.js';
import { acceptedCommitmentEligibility, actorIdValid, chipCents } from './eligibility.js';
import {
  CORRECTIVE_LIMITS,
  CORRECTIVE_REVIEW_VERSION,
  CORRECTIVE_ROSTER_REVIEW_VERSION,
  type CorrectiveReviewInput,
  type CorrectiveHandReview,
  type CorrectiveDecisionReview,
  type CorrectiveReferenceBinding,
  type AlternativeActionReference,
  type CorrectiveAction,
} from './contract.js';

import { resolveRosterCommitment } from './roster-adapter.js';
import type { CorrectiveRosterTrust } from './contract.js';

type Capture = { snapshot: FastHorseDecisionRequest; readFrame: unknown; decision: unknown };
const same = (a: unknown, b: unknown) => horseJournalJson(a) === horseJournalJson(b);
const safeDigest = (value: unknown, fallback: string) => {
  try {
    return evidenceDigest(value);
  } catch {
    return journalHash(fallback);
  }
};

export function correctiveReferenceBinding(
  decision: HorseJournalRecord,
  execution: HorseJournalRecord,
  acceptedHand: HorseJournalRecord
): CorrectiveReferenceBinding {
  const capture = JSON.parse(decision.body) as Capture;
  if (!decision.sourceRelease) throw Error('original_source_release_missing');
  return {
    decisionEventId: decision.eventId,
    decisionDigest: decision.sha256,
    executionDigest: execution.sha256,
    acceptedHandDigest: acceptedHand.sha256,
    inputDigest: evidenceDigest(capture.snapshot),
    readFrameDigest: evidenceDigest(capture.readFrame),
    sourceRelease: decision.sourceRelease,
  };
}

export function correctiveUtilityContextDigest(snapshot: FastHorseDecisionRequest): string {
  return evidenceDigest({
    gameMode: snapshot.gameState.gameMode ?? null,
    format: snapshot.gameState.format ?? null,
    tournament: snapshot.gameState.tournament ?? null,
    rakeConfig: snapshot.gameState.rakeConfig ?? null,
    bigBlind: snapshot.gameState.bigBlind,
  });
}

/** Uses the original controller-supplied legal menu/price/bounds. It never
 * substitutes current reads or converts a raise-to amount into an increment. */
export function correctiveActionIsLegal(
  snapshot: FastHorseDecisionRequest,
  choice: CorrectiveAction
): boolean {
  if (
    !choice ||
    typeof choice !== 'object' ||
    Object.keys(choice).sort().join(',') !== 'action,amount'
  )
    return false;
  const s = snapshot.gameState,
    p = snapshot.player;
  const amount = chipCents(choice?.amount),
    stack = chipCents(p?.stack),
    bet = chipCents(p?.bet),
    call = chipCents(s?.toCall);
  if (
    s?.stateSchemaVersion !== 1 ||
    !Array.isArray(s.legalActions) ||
    !s.legalActions.includes(choice?.action) ||
    amount === null ||
    stack === null ||
    bet === null ||
    call === null
  )
    return false;
  if (choice.action === 'fold') return amount === 0;
  if (choice.action === 'check') return amount === 0 && call === 0;
  if (choice.action === 'call') return call > 0 && amount === Math.min(call, stack);
  const maximum = chipCents(s.maxRaiseTo),
    minimum = chipCents(s.minRaiseTo);
  if (choice.action === 'all_in')
    return amount === stack + bet && (maximum === null || amount <= maximum);
  return (
    (choice.action === 'bet' || choice.action === 'raise') &&
    minimum !== null &&
    maximum !== null &&
    amount >= minimum &&
    amount <= maximum &&
    amount <= stack + bet
  );
}

function compareReference(
  raw: unknown,
  id: string,
  snapshot: FastHorseDecisionRequest,
  selected: CorrectiveAction,
  binding: CorrectiveReferenceBinding,
  decisionId: string,
  qualificationId: string
): CorrectiveDecisionReview {
  const no = (
    disposition: CorrectiveDecisionReview['disposition'],
    reason: string
  ): CorrectiveDecisionReview => ({
    decisionId,
    referenceId: id,
    disposition,
    reason,
    candidate: null,
  });
  const r = raw as AlternativeActionReference;
  if (
    !r ||
    r.version !== 1 ||
    typeof r.sourceId !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(r.sourceId) ||
    r.qualificationId !== qualificationId ||
    !r.binding ||
    !same(r.binding, binding)
  )
    return no('reference_unavailable', 'reference_input_or_source_mismatch');
  if (
    r.basis !== 'counterfactual' ||
    r.causal !== true ||
    r.informationSet !== 'original_decision_only'
  )
    return no('reference_unavailable', 'reference_not_causal');
  if (r.complete !== true || !['exact_enumeration', 'paired_simulation'].includes(r.method))
    return no('insufficient_evidence', 'reference_incomplete');
  if (!['cash', 'tournament'].includes(snapshot.gameState.gameMode ?? ''))
    return no('insufficient_evidence', 'original_game_mode_unavailable');
  const tournament = snapshot.gameState.gameMode === 'tournament';
  if (
    tournament &&
    (snapshot.gameState.tournament?.schemaVersion !== 1 ||
      snapshot.gameState.tournament.contextStatus !== 'complete')
  )
    return no('insufficient_evidence', 'original_tournament_context_incomplete');
  if (
    !r.utility ||
    r.utility.costsIncluded !== true ||
    r.utility.unit !== (tournament ? 'net_tournament_utility' : 'net_chip_bb') ||
    r.utility.contextDigest !== correctiveUtilityContextDigest(snapshot)
  )
    return no('reference_unavailable', 'net_utility_context_mismatch');
  const u = r.uncertainty;
  if (
    !u ||
    u.simultaneous !== true ||
    !Number.isFinite(u.familyWiseConfidence) ||
    u.familyWiseConfidence < 0.95 ||
    u.familyWiseConfidence > 1 ||
    !Number.isSafeInteger(u.independentSamples) ||
    u.independentSamples < (r.method === 'paired_simulation' ? 100 : 1)
  )
    return no('insufficient_evidence', 'reference_uncertainty_unqualified');
  if (
    !Array.isArray(r.alternatives) ||
    r.alternatives.length < 2 ||
    r.alternatives.length > CORRECTIVE_LIMITS.alternatives
  )
    return no('insufficient_evidence', 'reference_menu_incomplete');
  const keys = new Set<string>();
  for (const a of r.alternatives) {
    if (
      !a ||
      !correctiveActionIsLegal(snapshot, a.choice) ||
      [a.mean, a.lower, a.upper].some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12) ||
      a.lower > a.mean ||
      a.mean > a.upper
    )
      return no('reference_unavailable', 'reference_illegal_action_or_interval');
    const key = horseJournalJson(a.choice);
    if (keys.has(key)) return no('reference_unavailable', 'reference_duplicate_action');
    keys.add(key);
  }
  if (
    snapshot.gameState.legalActions!.some(
      (action) => !r.alternatives.some((a) => a.choice.action === action)
    )
  )
    return no('insufficient_evidence', 'reference_menu_incomplete');
  const chosen = r.alternatives.find((a) => same(a.choice, selected));
  if (!chosen) return no('reference_unavailable', 'executed_action_not_in_reference');
  const alternatives = r.alternatives.filter((a) => a !== chosen);
  const best = [...alternatives].sort(
    (a, b) =>
      b.lower - a.lower || horseJournalJson(a.choice).localeCompare(horseJournalJson(b.choice))
  )[0]!;
  const gain = best.lower - chosen.upper;
  // The comparison is conditional on this qualified finite menu. A positive
  // result proposes at most a five-point probability move and cannot execute it.
  if (gain > 0.01) {
    const candidate = {
      id: journalHash(
        horseJournalJson([CORRECTIVE_REVIEW_VERSION, decisionId, id, selected, best.choice, gain])
      ),
      kind: 'bounded_action_preference' as const,
      status: 'proposed_inactive' as const,
      decisionId,
      referenceId: id,
      from: selected,
      to: { action: best.choice.action, amount: best.choice.amount },
      utilityUnit: r.utility.unit,
      conservativeGain: gain,
      maximumProbabilityDelta: 0.05 as const,
      scope: 'exact_original_information_set' as const,
      requiredBeforeActivation: [
        'independent_holdout',
        'complete_policy_distribution',
        'qualified_source_window',
        'owner_approval',
        'rollback_qualification',
      ] as const,
      activationAllowed: false as const,
    };
    return {
      ...no('finding', 'qualified_menu_alternative_dominates'),
      candidate: {
        ...candidate,
        requiredBeforeActivation: [...candidate.requiredBeforeActivation],
      },
    };
  }
  if (alternatives.every((a) => a.upper <= chosen.lower + 0.01))
    return no('non_finding', 'no_material_qualified_menu_gain');
  return no('insufficient_evidence', 'alternative_uncertainty_overlaps');
}

/** Offline private retained-hand consumer. There is no database, policy write,
 * scheduler or current-policy call on this path. */
export function reviewHorseCorrectiveHand(
  input: CorrectiveReviewInput,
  options: { rosterTrust?: CorrectiveRosterTrust } = {}
): CorrectiveHandReview {
  const rosterV2 = (input.commitments as { version?: unknown } | undefined)?.version === 2;
  const out: CorrectiveHandReview = {
    version: rosterV2 ? CORRECTIVE_ROSTER_REVIEW_VERSION : CORRECTIVE_REVIEW_VERSION,
    scope: 'single_retained_hand_qualified_menu',
    reviewId: '',
    journalManifest: null,
    evidenceClass: 'unqualified',
    status: 'incomplete',
    reasons: ['complete_source_population_unverified'],
    rejectedReferences: [],
    rejectedCandidates: [],
    actors: [],
    completePopulation: false,
    replayVerified: false,
    gtoVerified: false,
    activationAllowed: false,
    requestLifecycleVerified: false,
  };
  const reason = (value: string) => {
    if (!out.reasons.includes(value)) out.reasons.push(value);
  };
  const refs = Array.isArray(input.references) ? input.references : [];
  const ids = refs
    .slice(0, CORRECTIVE_LIMITS.references)
    .map((r, i) => safeDigest(r, `invalid-reference-${i}`));
  const finish = () => {
    out.reviewId = journalHash(
      horseJournalJson([
        out.version,
        input.handKey,
        out.journalManifest,
        safeDigest(input.commitments ?? null, 'invalid-commitments'),
        ids,
        safeDigest(input.authority ?? null, 'invalid-authority'),
        out.actors,
        out.rejectedReferences,
        out.rejectedCandidates,
        out.reasons,
        ...(rosterV2
          ? [
              safeDigest(input.rosterSource ?? null, 'invalid-roster-source'),
              out.rosterAudit ?? null,
            ]
          : []),
        ...(out.status === 'known_empty_census' ? [out.scope, out.status] : []),
      ])
    );
    return out;
  };
  try {
    if (!Array.isArray(input.records) || input.records.length > CORRECTIVE_LIMITS.records) {
      reason('journal_input_bounds');
      return finish();
    }
    if (
      (input.references !== undefined && !Array.isArray(input.references)) ||
      refs.length > CORRECTIVE_LIMITS.references
    ) {
      reason('reference_input_bounds');
      return finish();
    }
    try {
      if (
        refs.reduce((sum, r) => sum + Buffer.byteLength(horseJournalJson(r)), 0) >
        2 * 1024 * 1024
      )
        throw Error('reference_bounds');
    } catch {
      reason('reference_input_bounds');
      return finish();
    }
    const journal = reconcileHorseJournalHand(input.records, input.handKey);
    out.journalManifest = journal.manifest;
    out.requestLifecycleVerified =
      (journal as typeof journal & { requestLifecycleVerified?: boolean })
        .requestLifecycleVerified === true;
    if (!out.requestLifecycleVerified) reason('request_lifecycle_unverified');
    for (const gap of journal.gaps) reason(`journal_${gap}`);
    if (journal.status === 'unavailable') {
      reason('original_hand_evidence_pending');
      return finish();
    }
    const rows = [...new Map(input.records.map((r) => [r.eventId, r])).values()];
    const accepted = rows.filter((r) => r.kind === 'accepted_hand');
    const acceptedRecord =
      accepted.find(
        (r) =>
          r.sha256 ===
          (input.commitments as { acceptedHandRecordDigest?: string })?.acceptedHandRecordDigest
      ) ?? accepted[0];
    if (!acceptedRecord) {
      reason('original_hand_evidence_pending');
      return finish();
    }
    const hand = JSON.parse(acceptedRecord.body) as CompletedHandObservation;
    let authority =
      isVerifiedCorrectiveAuthority(input.authority) && input.authority.handKey === input.handKey
        ? input.authority
        : undefined;
    // V2 monetary authority never substitutes for the existing independently
    // signed reference authority or its exact commitment pin.
    if (
      rosterV2 &&
      authority &&
      authority.commitmentDigest !== safeDigest(input.commitments, 'invalid-commitments')
    ) {
      authority = undefined;
      reason('reference_commitment_authority_pin_missing');
    }
    if (authority) out.evidenceClass = authority.evidenceClass;
    else if (!rosterV2) reason('trusted_source_authority_missing');
    const roster = rosterV2
      ? resolveRosterCommitment(input, acceptedRecord, options.rosterTrust)
      : null;
    let rosterEvidenceClassMismatch = false;
    if (roster) {
      out.rosterAudit = roster.audit;
      for (const gap of roster.audit.reasons) reason(gap);
      if (roster.audit.evidenceClass === 'synthetic_fixture')
        out.evidenceClass = 'synthetic_fixture';
      if (
        roster.audit.evidenceClass &&
        authority &&
        (roster.audit.evidenceClass === 'synthetic_fixture') !==
          (authority.evidenceClass === 'synthetic_fixture')
      ) {
        rosterEvidenceClassMismatch = true;
        authority = undefined;
        reason('roster_reference_evidence_class_mismatch');
      }
    }
    const commitment = roster
      ? roster.commitment
      : acceptedCommitmentEligibility(input.commitments, authority, hand, acceptedRecord.sha256);
    if (commitment.status === 'unavailable') reason(commitment.reason);
    // A signed all-human transaction is a known empty monetary census. It
    // cannot supply a Horse decision, request lifecycle, reference or GTO proof.
    // Any retained Horse work is contradictory/incomplete for this narrow lane.
    // Legacy action-origin gaps remain visible; independently qualified human
    // classification does not turn them into missing monetary population.
    const knownEmptyCensus = Boolean(
      rosterV2 &&
      roster?.audit.status === 'qualified_monetary_eligibility' &&
      roster.audit.acceptedActorClassificationVerified === true &&
      roster.audit.unknownActorRefs.length === 0 &&
      commitment.status === 'available' &&
      commitment.actors.length === 0 &&
      !rosterEvidenceClassMismatch &&
      (journal.status === 'reconciled' ||
        (journal.status === 'incomplete' &&
          journal.gaps.every(
            (gap) => gap === 'action_origin_unavailable' || gap === 'unmatched_discard_action'
          ))) &&
      rows.every((row) => row.kind === 'accepted_hand')
    );
    if (rosterV2 && !authority && !knownEmptyCensus) reason('trusted_source_authority_missing');
    if (
      roster &&
      commitment.status === 'available' &&
      commitment.actors.length === 0 &&
      roster.audit.status === 'qualified_monetary_eligibility' &&
      rows.some((row) => row.kind !== 'accepted_hand')
    )
      reason('known_empty_roster_conflicts_with_retained_horse_work');
    const actorIds = new Set(
      (hand.actions ?? [])
        .filter((a) => a.origin === 'horse_policy' || a.origin === 'horse_fallback')
        .map((a) => a.userId)
        .filter(actorIdValid)
        .map((id) => id.toLowerCase())
    );
    if (commitment.status === 'available') for (const a of commitment.actors) actorIds.add(a.id);
    if (actorIds.size > 10) {
      reason('horse_population_invalid');
      return finish();
    }
    const usedReferences = new Set<number>();
    for (const id of [...actorIds].sort()) {
      const eligibility =
        commitment.status === 'available' ? commitment.actors.find((a) => a.id === id) : undefined;
      const actor: CorrectiveHandReview['actors'][number] = {
        actorRef: journalHash(id),
        eligibility: eligibility ? (eligibility.over ? 'over_10bb' : 'not_over_10bb') : 'unknown',
        grossCommittedBb: eligibility?.grossBb ?? null,
        decisions: [],
      };
      if (roster?.activities.has(id)) actor.retainedActivity = roster.activities.get(id);
      out.actors.push(actor);
      if (eligibility && !eligibility.over) continue;
      for (const decision of rows.filter((r) => r.kind === 'decision')) {
        const capture = JSON.parse(decision.body) as Capture;
        if (capture.snapshot?.player?.user_id?.toLowerCase() !== id) continue;
        const base: CorrectiveDecisionReview = {
          decisionId: decision.sha256,
          referenceId: null,
          disposition: 'pending',
          reason: 'original_execution_evidence_pending',
          candidate: null,
        };
        actor.decisions.push(base);
        if (!eligibility) {
          base.reason = 'commitment_eligibility_unknown';
          continue;
        }
        if (roster && roster.audit.status !== 'qualified_monetary_eligibility') {
          base.reason = 'accepted_roster_classification_partial';
          continue;
        }
        if (journal.status !== 'reconciled') continue;
        const execution = rows.find(
          (r) =>
            r.kind === 'execution' &&
            r.producerId === decision.producerId &&
            r.turnKey === decision.turnKey
        );
        if (!execution) continue;
        const witness = JSON.parse(execution.body) as HorseExecutionWitness;
        if (witness.executionStatus === 'not_executed') {
          actor.decisions.pop();
          continue;
        }
        const binding = bindHorseDecisionToCommittedHand(witness, hand);
        if (binding.status !== 'bound') continue;
        if (witness.executionStatus !== 'intended') {
          base.disposition = 'insufficient_evidence';
          base.reason = 'controller_coercion_requires_separate_review';
          continue;
        }
        if (!decision.sourceRelease) {
          base.disposition = 'insufficient_evidence';
          base.reason = 'original_source_release_missing';
          continue;
        }
        const selected = {
          action: witness.acceptedActions[0]!.record.action,
          amount: witness.acceptedActions[0]!.record.amount,
        } as CorrectiveAction;
        if (!correctiveActionIsLegal(capture.snapshot, selected)) {
          base.disposition = 'insufficient_evidence';
          base.reason = 'original_canonical_legality_unavailable';
          continue;
        }
        const matches = refs
          .map((ref, i) => ({ ref, i }))
          .filter(
            ({ ref }) =>
              (ref as AlternativeActionReference)?.binding?.decisionEventId === decision.eventId
          );
        if (matches.length !== 1) {
          base.disposition = 'reference_unavailable';
          base.reason = matches.length
            ? 'reference_identity_ambiguous'
            : 'matching_reference_missing';
          continue;
        }
        const { ref, i } = matches[0]!;
        usedReferences.add(i);
        base.referenceId = ids[i]!;
        if (!authority?.referenceDigests.includes(ids[i]!)) {
          base.disposition = 'reference_unavailable';
          base.reason = 'reference_authority_pin_missing';
          continue;
        }
        Object.assign(
          base,
          compareReference(
            ref,
            ids[i]!,
            capture.snapshot,
            selected,
            correctiveReferenceBinding(decision, execution, acceptedRecord),
            decision.sha256,
            authority.qualificationId
          )
        );
      }
      if (!actor.decisions.length && eligibility?.over) {
        reason('eligible_actor_decisions_missing');
      }
    }
    for (let i = 0; i < refs.length; i++) {
      const decision = out.actors.flatMap((a) => a.decisions).find((d) => d.referenceId === ids[i]);
      if (
        !usedReferences.has(i) ||
        decision?.disposition === 'reference_unavailable' ||
        decision?.disposition === 'insufficient_evidence'
      )
        out.rejectedReferences.push({
          referenceId: ids[i]!,
          reason: decision?.reason ?? 'reference_unmatched_or_duplicate',
        });
    }
    if (knownEmptyCensus && out.actors.length === 0) {
      reason('known_empty_horse_census');
      reason('no_horse_decision_or_lifecycle_records_retained');
      reason('discretionary_horse_review_not_applicable');
      out.scope = 'single_retained_hand_monetary_census';
      out.evidenceClass = roster!.audit.evidenceClass ?? 'unqualified';
    } else if (!out.actors.length) reason('horse_population_unavailable');
    const eligible = out.actors.filter((a) => a.eligibility === 'over_10bb');
    out.status =
      knownEmptyCensus && out.actors.length === 0
        ? 'known_empty_census'
        : commitment.status === 'available' &&
            (!roster || roster.audit.status === 'qualified_monetary_eligibility') &&
            !rosterEvidenceClassMismatch &&
            journal.status === 'reconciled' &&
            out.actors.length > 0 &&
            out.actors.every((a) => a.eligibility !== 'unknown') &&
            eligible.every(
              (a) =>
                a.decisions.length > 0 &&
                a.decisions.every(
                  (d) => d.disposition === 'finding' || d.disposition === 'non_finding'
                )
            )
          ? 'reviewed'
          : 'incomplete';
    if (Buffer.byteLength(horseJournalJson(out)) > CORRECTIVE_LIMITS.outputBytes)
      throw Error('output_bounds');
    return finish();
  } catch {
    out.status = 'incomplete';
    out.rejectedCandidates = out.actors.flatMap((actor) =>
      actor.decisions.flatMap((decision) =>
        decision.candidate
          ? [{ candidateId: decision.candidate.id, reason: 'invalid_review_evidence' }]
          : []
      )
    );
    // A failed final serialization must never retain partially accepted
    // findings or exceed the private result bound. Keep only their identities.
    out.actors = [];
    out.rejectedReferences = ids.map((referenceId) => ({
      referenceId,
      reason: 'invalid_review_evidence',
    }));
    reason('invalid_review_evidence');
    return finish();
  }
}
