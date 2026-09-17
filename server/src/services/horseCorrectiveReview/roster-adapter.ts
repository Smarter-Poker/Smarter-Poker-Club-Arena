/** PREPARED/UNEXECUTED adapter to frozen roster R1. No producer, signer or policy. */
import { createUnsignedAcceptedCommitmentExport } from '../horseAcceptedRoster/exporter.js';
import { acceptedRosterEligibility } from '../horseAcceptedRoster/eligibility.js';
import { evidenceDigest } from './authority.js';
import { actorIdValid, type CommitmentEligibility } from './eligibility.js';
import { journalHash, type HorseJournalRecord } from '../horseDecisionJournal/record.js';
import type {
  CorrectiveReviewInput,
  CorrectiveRosterAudit,
  CorrectiveRosterTrust,
} from './contract.js';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function resolveRosterCommitment(
  input: CorrectiveReviewInput,
  accepted: HorseJournalRecord,
  trust?: CorrectiveRosterTrust
): {
  commitment: CommitmentEligibility;
  audit: CorrectiveRosterAudit;
  activities: Map<string, string>;
} {
  const audit: CorrectiveRosterAudit = {
    version: 1,
    status: 'pending',
    evidenceClass: null,
    qualifiedExportDigest: null,
    acceptedActorClassificationVerified: false,
    unknownActorRefs: [],
    reasons: [],
    sourcePopulationVerified: false,
    completePopulation: false,
    replayVerified: false,
    gtoVerified: false,
    activationAllowed: false,
  };
  const no = (reason: string) => ({
    commitment: { status: 'unavailable' as const, reason },
    audit: { ...audit, reasons: [reason] },
    activities: new Map<string, string>(),
  });
  try {
    if (
      !object(input.commitments) ||
      input.commitments.version !== 2 ||
      input.commitments.source !== 'accepted_transaction_roster_v1' ||
      input.commitments.acceptedHandRecordDigest !== accepted.sha256 ||
      input.rosterSource?.version !== 1 ||
      !Array.isArray(input.rosterSource.rows)
    )
      return no('accepted_roster_source_pending');
    const request = {
      records: input.records,
      handKey: input.handKey,
      acceptedHandRecordDigest: accepted.sha256,
      rows: input.rosterSource.rows,
    };
    // Export is reconstructed from immutable retained records and exact raw
    // source text. A caller's v2 commitment cannot choose a different actor set.
    const exported: unknown = createUnsignedAcceptedCommitmentExport(request);
    if (
      !object(exported) ||
      !object(exported.sourceExport) ||
      exported.sourceExport.status !== 'unsigned_export' ||
      evidenceDigest(exported.commitments) !== evidenceDigest(input.commitments)
    )
      return no('accepted_roster_export_mismatch');
    const result: unknown = acceptedRosterEligibility(
      request,
      input.rosterSource.authorityEnvelope,
      trust
    );
    if (
      !object(result) ||
      !['qualified_monetary_eligibility', 'partial_unknown'].includes(String(result.status)) ||
      !Array.isArray(result.actors) ||
      result.actors.length > 10 ||
      !Array.isArray(result.unknownActorRefs) ||
      result.unknownActorRefs.length > 10 ||
      result.unknownActorRefs.some((v) => !sha(v)) ||
      new Set(result.unknownActorRefs).size !== result.unknownActorRefs.length ||
      !['synthetic_fixture', 'reviewed_source'].includes(String(result.evidenceClass)) ||
      !sha(result.qualifiedExportDigest) ||
      result.qualifiedExportDigest !== evidenceDigest(exported) ||
      !Array.isArray(result.reasons) ||
      result.reasons.length > 32 ||
      result.reasons.some((v) => typeof v !== 'string' || v.length > 160) ||
      typeof result.acceptedActorClassificationVerified !== 'boolean' ||
      [
        'sourcePopulationVerified',
        'completePopulation',
        'replayVerified',
        'gtoVerified',
        'activationAllowed',
      ].some((k) => result[k] !== false)
    )
      return no('trusted_roster_source_pending');
    const ids = input.commitments.horseActorIds;
    if (
      !Array.isArray(ids) ||
      ids.length !== result.actors.length ||
      ids.some((id) => !actorIdValid(id)) ||
      new Set(ids).size !== ids.length
    )
      return no('accepted_roster_actor_mismatch');
    const actors: Array<{ id: string; grossBb: number; over: boolean }> = [],
      activities = new Map<string, string>();
    const seen = new Set<string>();
    for (const raw of result.actors) {
      if (
        !object(raw) ||
        !sha(raw.actorRef) ||
        seen.has(raw.actorRef) ||
        typeof raw.grossCommittedBb !== 'number' ||
        !Number.isFinite(raw.grossCommittedBb) ||
        raw.grossCommittedBb < 0 ||
        !['over_10bb', 'not_over_10bb'].includes(String(raw.eligibility)) ||
        typeof raw.activity !== 'string' ||
        raw.activity.length > 100 ||
        raw.candidate !== null ||
        raw.decisionReview !== 'pending_original_decision_and_qualified_reference'
      )
        return no('accepted_roster_actor_mismatch');
      const id = ids.find((id) => typeof id === 'string' && journalHash(id) === raw.actorRef);
      if (typeof id !== 'string') return no('accepted_roster_actor_mismatch');
      seen.add(raw.actorRef);
      actors.push({ id, grossBb: raw.grossCommittedBb, over: raw.eligibility === 'over_10bb' });
      activities.set(id, raw.activity);
    }
    if (
      (result.status === 'qualified_monetary_eligibility') !==
      (result.acceptedActorClassificationVerified === true && result.unknownActorRefs.length === 0)
    )
      return no('accepted_roster_classification_inconsistent');
    return {
      commitment: { status: 'available', actors },
      activities,
      audit: {
        ...audit,
        status: result.status as CorrectiveRosterAudit['status'],
        evidenceClass: result.evidenceClass as CorrectiveRosterAudit['evidenceClass'],
        qualifiedExportDigest: result.qualifiedExportDigest,
        acceptedActorClassificationVerified: result.acceptedActorClassificationVerified,
        unknownActorRefs: [...result.unknownActorRefs] as string[],
        reasons: [...result.reasons] as string[],
      },
    };
  } catch {
    return no('accepted_roster_source_invalid');
  }
}
