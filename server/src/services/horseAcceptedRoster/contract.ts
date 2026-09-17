/** Private proposed accepted-transaction roster contracts. No installed producer. */
import type { CompletedHandObservation } from '../../engine/horseDecision/protocol.js';
import type { HorseJournalRecord } from '../horseDecisionJournal/record.js';
import type { HorseJournalHandReview } from '../horseDecisionJournal/review.js';
export type UnknownObject = Record<string, unknown>;
export type ActorClassification = 'horse' | 'human' | 'unknown';
export interface AcceptedRosterActor {
  userId: string;
  seat: number;
  seatId: string;
  seatJoinedAt: string;
  classification: ActorClassification;
  status: 'canonical_boolean' | 'profile_missing' | 'classification_null';
}
export interface AcceptedRoster {
  version: 1;
  basis: 'profiles_read_in_acceptance_transaction';
  tableId: string;
  handId: string;
  handNumber: number;
  capturedAt: string;
  actors: AcceptedRosterActor[];
}
export interface ReturnedRosterTransport {
  version: 1;
  payloadDigest: string;
  rosterDigest: string;
  roster: AcceptedRoster;
}
export type PrivateRosterHand = CompletedHandObservation & { acceptedActorRoster?: unknown };
export interface AcceptedRosterReadRequest {
  records: readonly HorseJournalRecord[];
  handKey: string;
  acceptedHandRecordDigest: string;
  payloadText: unknown;
  payloadDigest: unknown;
}
export type AcceptedRosterReadResult =
  | {
      status: 'pending';
      reason: string;
      producerAuthorityVerified: false;
      completePopulation: false;
    }
  | {
      status: 'structurally_bound';
      producerAuthorityVerified: false;
      completePopulation: false;
      acceptedActorClassification: 'all_present_untrusted' | 'partial_unknown';
      roster: AcceptedRoster;
      rosterDigest: string;
      hand: PrivateRosterHand | undefined;
      requestLifecycleVerified: boolean;
    };
export interface AcceptedSourceRequest {
  records: readonly HorseJournalRecord[];
  handKey: string;
  acceptedHandRecordDigest: string;
  rows: readonly unknown[];
}
export interface AcceptedRosterCommitment {
  version: 2;
  source: 'accepted_transaction_roster_v1';
  committedHandId: string;
  rosterDigest: string;
  acceptedHandRecordDigest: string;
  actionsDigest: string;
  bigBlind: number;
  horseActorIds: string[];
  payloadText: string;
  payloadDigest: string;
}
export interface MonetaryActor {
  actorRef: string;
  grossCommittedBb: number;
  eligibility: 'over_10bb' | 'not_over_10bb';
}
export interface SettlementActorCoverage {
  basis: 'all_roster_written' | 'captured_delta_request';
  requestReconciled: boolean;
  writtenActors: number;
  departedCashActors: number;
  unwrittenZeroDeltaActors: number;
}
export interface AcceptedExportSource {
  rawRowDigest: string;
  historyId: string;
  tableId: string;
  handNumber: number;
  settlementId: string;
  payloadDigest: string;
  corePayloadDigest: string;
  postCommitRequestDigest: string;
  fullActionsDigest: string;
  gameVariant: string;
  tournamentId: string | null;
  committedAt: string;
  capturedReadAt: string;
  snapshotId: string;
  postCommitCompletedAt: string | null;
  postCommitObligations: 'pending' | 'reported_complete';
  wholeCoreHashRecomputed: false;
  settlementActorCoverage: SettlementActorCoverage;
  acceptedRoster: AcceptedRoster;
  rosterDigest: string;
  requestLifecycleVerified: boolean;
}
export interface AcceptedExportMetadata {
  version: 1;
  status: 'unavailable' | 'unsigned_export';
  inputClass: 'untrusted_raw_row_capture';
  sourceReadVerified: false;
  authorityQualified: false;
  completePopulation: false;
  replayVerified: false;
  gtoVerified: false;
  activationAllowed: false;
  historicalHorsePopulation: 'not_established';
  rosterBasis: 'proposed_private_accepted_actor_roster_v1';
  acceptedActorClassification: 'unknown' | 'all_present_untrusted' | 'partial_unknown';
  producerImplementation: 'pending';
  reasons: string[];
  journal: HorseJournalHandReview | null;
  source: AcceptedExportSource | null;
  actors: MonetaryActor[];
}
export interface UnavailableAcceptedExport {
  version: 2;
  references: never[];
  sourceExport: AcceptedExportMetadata;
}
export interface UnsignedAcceptedExport extends UnavailableAcceptedExport {
  commitments: AcceptedRosterCommitment;
  sourceExport: AcceptedExportMetadata & {
    status: 'unsigned_export';
    source: AcceptedExportSource;
  };
}
export type AcceptedSourceExport = UnavailableAcceptedExport | UnsignedAcceptedExport;
export interface RosterSourceTrust {
  readonly publicKeyDigest?: string;
  readonly producerSourceDigest?: string;
  readonly allowSynthetic?: boolean;
}
export interface RosterSourceAuthority {
  version: 1;
  role: 'accepted_roster_source';
  handKey: string;
  qualificationId: string;
  evidenceClass: 'synthetic_fixture' | 'reviewed_source';
  producerSourceDigest: string;
  exportDigest: string;
}
export interface RosterEligibleActor extends MonetaryActor {
  activity:
    | 'retained_horse_action_present'
    | 'silent_actor_decision_coverage_unknown'
    | 'forced_only_observed_decision_coverage_unknown'
    | 'unattributed_action_decision_coverage_unknown';
  decisionReview: 'pending_original_decision_and_qualified_reference';
  candidate: null;
}
export interface RosterEligibility {
  version: 1;
  status: 'pending' | 'partial_unknown' | 'qualified_monetary_eligibility';
  reasons: string[];
  actors: RosterEligibleActor[];
  unknownActorRefs: string[];
  acceptedActorClassificationVerified: boolean;
  sourcePopulationVerified: false;
  completePopulation: false;
  replayVerified: false;
  gtoVerified: false;
  activationAllowed: false;
  evidenceClass: RosterSourceAuthority['evidenceClass'] | null;
  qualifiedExportDigest: string | null;
}
export interface CliResult {
  code: number;
  output: string;
}
