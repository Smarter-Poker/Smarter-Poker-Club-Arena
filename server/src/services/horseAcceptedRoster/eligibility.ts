/** PREPARED, UNEXECUTED monetary eligibility only. Never a GTO review or action
 * reference. The adapter admits v2 separately; the v1 path stays unchanged. */
import { createUnsignedAcceptedCommitmentExport } from './exporter.js';
import { verifyRosterSourceAuthority } from './authority.js';
import { freeze, digest } from './schema.js';
import { journalHash } from '../horseDecisionJournal/record.js';
import { chipCents } from '../horseCorrectiveReview/eligibility.js';
import type {
  AcceptedSourceRequest,
  RosterSourceTrust,
  RosterEligibility,
  RosterEligibleActor,
  PrivateRosterHand,
  UnknownObject,
} from './contract.js';
const forced = new Set(['sb', 'bb', 'post', 'ante', 'straddle', 'bomb_ante']);
/** Rebuild the export from actual retained/source input at qualification time.
 * Caller-invented output objects or signed v1 authority cannot bypass the read. */
export function acceptedRosterEligibility(
  input: AcceptedSourceRequest,
  envelope: unknown,
  independentTrust?: RosterSourceTrust
): RosterEligibility {
  const out: RosterEligibility = {
    version: 1,
    status: 'pending',
    reasons: [],
    actors: [],
    unknownActorRefs: [],
    acceptedActorClassificationVerified: false,
    sourcePopulationVerified: false,
    completePopulation: false,
    replayVerified: false,
    gtoVerified: false,
    activationAllowed: false,
    evidenceClass: null,
    qualifiedExportDigest: null,
  };
  try {
    const exported = createUnsignedAcceptedCommitmentExport(input);
    if (exported.sourceExport.status !== 'unsigned_export' || !('commitments' in exported)) {
      out.reasons = [...exported.sourceExport.reasons];
      return freeze(out);
    }
    const authority = verifyRosterSourceAuthority(
      envelope,
      independentTrust,
      exported,
      input.handKey
    );
    if (!authority) {
      out.reasons = ['trusted_roster_producer_authority_missing'];
      return freeze(out);
    }
    const roster = exported.sourceExport.source.acceptedRoster;
    const retained = input.records.find((r) => r.sha256 === input.acceptedHandRecordDigest);
    if (!retained) throw Error('invalid');
    const hand = JSON.parse(retained.body) as PrivateRosterHand;
    const facts = (
      JSON.parse(exported.commitments.payloadText) as {
        accepted_hand_facts: { contributions: UnknownObject; returned_uncalled: UnknownObject };
      }
    ).accepted_hand_facts;
    const bb = chipCents(exported.commitments.bigBlind);
    if (bb === null || bb <= 0) throw Error('invalid');
    const actors: RosterEligibleActor[] = [],
      unknownActorRefs: string[] = [];
    for (const actor of roster.actors) {
      if (actor.classification === 'unknown') {
        unknownActorRefs.push(journalHash(actor.userId));
        continue;
      }
      if (actor.classification !== 'horse') continue;
      const net = chipCents(facts.contributions[actor.userId]);
      const refund = Object.hasOwn(facts.returned_uncalled, actor.userId)
        ? chipCents(facts.returned_uncalled[actor.userId])
        : 0;
      if (net === null || refund === null || !Number.isSafeInteger(net + refund))
        throw Error('invalid');
      const actions = (hand.actions as NonNullable<PrivateRosterHand['actions']>).filter(
        (a) => a.userId === actor.userId
      );
      const policy = actions.some(
        (a) => a.origin === 'horse_policy' || a.origin === 'horse_fallback'
      );
      // Source-only forced classification is descriptive. It cannot establish
      // that no lifecycle/decision record was ever lost for this actor.
      const activity = policy
        ? 'retained_horse_action_present'
        : actions.length === 0
          ? 'silent_actor_decision_coverage_unknown'
          : actions.every((a) => forced.has(a.action))
            ? 'forced_only_observed_decision_coverage_unknown'
            : 'unattributed_action_decision_coverage_unknown';
      const gross = BigInt(net) + BigInt(refund);
      actors.push({
        actorRef: journalHash(actor.userId),
        grossCommittedBb: Number(gross) / bb,
        eligibility: gross > 10n * BigInt(bb) ? 'over_10bb' : 'not_over_10bb',
        activity,
        decisionReview: 'pending_original_decision_and_qualified_reference',
        candidate: null,
      });
    }
    return freeze<RosterEligibility>({
      ...out,
      status: unknownActorRefs.length ? 'partial_unknown' : 'qualified_monetary_eligibility',
      reasons: [
        'full_source_population_not_established',
        'producer_installation_not_verified_by_this_consumer',
        ...(authority.evidenceClass === 'synthetic_fixture'
          ? ['synthetic_fixture_not_real_history']
          : []),
        ...(unknownActorRefs.length ? ['accepted_actor_classification_partial'] : []),
      ],
      actors,
      unknownActorRefs,
      acceptedActorClassificationVerified: unknownActorRefs.length === 0,
      evidenceClass: authority.evidenceClass,
      qualifiedExportDigest: digest(exported),
    });
  } catch {
    out.reasons = ['roster_eligibility_invalid'];
    return freeze(out);
  }
}
