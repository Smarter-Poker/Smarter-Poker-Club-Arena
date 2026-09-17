import type { HorseJournalRecord } from '../horseDecisionJournal/record.js';

export const CORRECTIVE_REVIEW_VERSION = 'horse-corrective-review-v1' as const;
export const CORRECTIVE_ROSTER_REVIEW_VERSION = 'horse-corrective-review-v2-roster' as const;
export const CORRECTIVE_LIMITS = Object.freeze({
  records: 256,
  references: 128,
  alternatives: 32,
  outputBytes: 524288,
});

/** Supplied by the source/qualification owner, separately from the artifacts.
 * A digest is byte binding, not an assertion that observational data is causal.
 * This module does not discover, grant or persist approval. */
export interface CorrectiveReviewAuthority {
  version: 1;
  role: 'accepted_source_and_counterfactual_reference';
  handKey: string;
  qualificationId: string;
  evidenceClass: 'synthetic_fixture' | 'reviewed_reference';
  commitmentDigest: string | null;
  referenceDigests: string[];
}

export interface CorrectiveAuthorityEnvelope {
  authority: CorrectiveReviewAuthority;
  publicKeyPem: string;
  signature: string;
}

/** Export of an accepted immutable transaction, not a sum of raise-to actions.
 * payloadText is the exact stored Postgres JSON text used by its SHA256. */
export interface AcceptedCommitmentEvidence {
  version: 1;
  source: 'accepted_transaction';
  committedHandId: string;
  acceptedHandRecordDigest: string;
  actionsDigest: string;
  bigBlind: number;
  horseActorIds: string[];
  payloadText: string;
  payloadDigest: string;
}

/** Amount matches the controller: calls are incremental; bets/raises/all-in
 * are the target wager; fold/check are zero. */
export interface CorrectiveAction {
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
  amount: number;
}
export interface CorrectiveReferenceBinding {
  decisionEventId: string;
  decisionDigest: string;
  executionDigest: string;
  acceptedHandDigest: string;
  inputDigest: string;
  readFrameDigest: string;
  sourceRelease: string;
}
export interface AlternativeActionReference {
  version: 1;
  sourceId: string;
  qualificationId: string;
  basis: 'counterfactual';
  method: 'exact_enumeration' | 'paired_simulation';
  causal: true;
  complete: true;
  informationSet: 'original_decision_only';
  utility: {
    unit: 'net_chip_bb' | 'net_tournament_utility';
    costsIncluded: true;
    contextDigest: string;
  };
  binding: CorrectiveReferenceBinding;
  /** Simultaneous intervals for the entire declared finite menu. No claim
   * is made about unenumerated bet sizes or global GTO optimality. */
  uncertainty: { familyWiseConfidence: number; independentSamples: number; simultaneous: true };
  alternatives: Array<{ choice: CorrectiveAction; mean: number; lower: number; upper: number }>;
}
export type CorrectiveDisposition =
  | 'pending'
  | 'insufficient_evidence'
  | 'reference_unavailable'
  | 'finding'
  | 'non_finding';
export interface InactiveCorrectiveCandidate {
  id: string;
  kind: 'bounded_action_preference';
  status: 'proposed_inactive';
  decisionId: string;
  referenceId: string;
  from: CorrectiveAction;
  to: CorrectiveAction;
  utilityUnit: AlternativeActionReference['utility']['unit'];
  conservativeGain: number;
  maximumProbabilityDelta: 0.05;
  scope: 'exact_original_information_set';
  requiredBeforeActivation: [
    'independent_holdout',
    'complete_policy_distribution',
    'qualified_source_window',
    'owner_approval',
    'rollback_qualification',
  ];
  activationAllowed: false;
}
export interface CorrectiveDecisionReview {
  decisionId: string;
  referenceId: string | null;
  disposition: CorrectiveDisposition;
  reason: string;
  candidate: InactiveCorrectiveCandidate | null;
}
export interface CorrectiveHandReview {
  version: typeof CORRECTIVE_REVIEW_VERSION | typeof CORRECTIVE_ROSTER_REVIEW_VERSION;
  scope: 'single_retained_hand_qualified_menu' | 'single_retained_hand_monetary_census';
  reviewId: string;
  journalManifest: string | null;
  evidenceClass: CorrectiveReviewAuthority['evidenceClass'] | 'reviewed_source' | 'unqualified';
  /** known_empty_census is monetary classification only, never a decision review. */
  status: 'reviewed' | 'incomplete' | 'known_empty_census';
  reasons: string[];
  rejectedReferences: Array<{ referenceId: string; reason: string }>;
  rejectedCandidates: Array<{ candidateId: string; reason: string }>;
  actors: Array<{
    actorRef: string;
    eligibility: 'over_10bb' | 'not_over_10bb' | 'unknown';
    grossCommittedBb: number | null;
    decisions: CorrectiveDecisionReview[];
    retainedActivity?: string;
  }>;
  completePopulation: false;
  replayVerified: false;
  gtoVerified: false;
  activationAllowed: false;
  requestLifecycleVerified: boolean;
  /** Optional v2 source census; never a discretionary decision proof. */
  rosterAudit?: CorrectiveRosterAudit;
}
export interface CorrectiveReviewInput {
  records: readonly HorseJournalRecord[];
  handKey: string;
  commitments?: unknown;
  references?: readonly unknown[];
  authority?: CorrectiveReviewAuthority;
  /** Raw private source only. Independent trust is a separate function option. */
  rosterSource?: { version: 1; rows: readonly unknown[]; authorityEnvelope?: unknown };
}

/** A separate source-signature domain; never loaded from source JSON. */
export interface CorrectiveRosterTrust {
  readonly publicKeyDigest?: string;
  readonly producerSourceDigest?: string;
  readonly allowSynthetic?: boolean;
}
export interface CorrectiveRosterAudit {
  version: 1;
  status: 'pending' | 'partial_unknown' | 'qualified_monetary_eligibility';
  evidenceClass: 'synthetic_fixture' | 'reviewed_source' | null;
  qualifiedExportDigest: string | null;
  acceptedActorClassificationVerified: boolean;
  unknownActorRefs: string[];
  reasons: string[];
  sourcePopulationVerified: false;
  completePopulation: false;
  replayVerified: false;
  gtoVerified: false;
  activationAllowed: false;
}
