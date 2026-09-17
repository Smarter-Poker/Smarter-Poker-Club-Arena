/** PREPARED, UNEXECUTED. Synthetic retained rows and keys only.
 * This composed job always selects the composed R2 consumer. Frozen R1
 * reproduction remains a separate packet/job; no fixture is production proof. */
import { describe, it, expect } from 'vitest';
import { rosterFixture, sync, syntheticAuthority, HAND_KEY } from './fixture.test-support.mjs';
import { createUnsignedAcceptedCommitmentExport } from '../../../services/horseAcceptedRoster/exporter.js';
import type {
  AcceptedSourceRequest,
  UnsignedAcceptedExport,
} from '../../../services/horseAcceptedRoster/contract.js';
import { reviewHorseCorrectiveHand as r2 } from '../../../services/horseCorrectiveReview/review.js';
import { authorize } from '../../../services/horseCorrectiveReview/fixture.test-support.js';
import { journalHash } from '../../../services/horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../../../services/horseDecisionJournal/review.js';
const candidate = r2;
function unsigned(input: AcceptedSourceRequest): UnsignedAcceptedExport {
  const exported = createUnsignedAcceptedCommitmentExport(input);
  expect(exported.sourceExport.status).toBe('unsigned_export');
  if (!('commitments' in exported)) throw new Error('synthetic export unavailable');
  return exported;
}
function prepare(change: (x: ReturnType<typeof rosterFixture>) => void = () => {}) {
  const x = rosterFixture();
  for (const a of x.roster.actors) {
    a.classification = 'human';
    a.status = 'canonical_boolean';
  }
  x.hand.actions = x.hand.actions.map((a) => ({ ...a, origin: 'player' }));
  change(x);
  sync(x);
  const exported = unsigned(x.input);
  expect(exported.sourceExport.status).toBe('unsigned_export');
  const signed = syntheticAuthority(exported);
  return {
    x,
    exported,
    input: {
      records: x.input.records,
      handKey: HAND_KEY,
      commitments: exported.commitments,
      references: [],
      rosterSource: { version: 1 as const, rows: x.input.rows, authorityEnvelope: signed.envelope },
    },
    options: { rosterTrust: signed.trust },
  };
}
function noClaims(r: ReturnType<typeof r2>) {
  for (const key of [
    'completePopulation',
    'replayVerified',
    'gtoVerified',
    'activationAllowed',
  ] as const)
    expect(r[key]).toBe(false);
  expect(r.actors.flatMap((a) => a.decisions).every((d) => d.candidate === null)).toBe(true);
}
function pending(r: ReturnType<typeof r2>) {
  expect(r.status).toBe('incomplete');
  expect(r.status).not.toBe('known_empty_census');
  noClaims(r);
}
describe('prepared known-empty monetary census distinction', () => {
  it('complete signed all-human roster is a known empty census without reference authority', () => {
    const x = prepare(),
      r = candidate(x.input, x.options);
    expect(r.status).toBe('known_empty_census');
    expect(r.scope).toBe('single_retained_hand_monetary_census');
    expect(r.actors).toEqual([]);
    expect(r.reasons).toContain('known_empty_horse_census');
    expect(r.reasons).not.toContain('horse_population_unavailable');
    expect(r.reasons).not.toContain('trusted_source_authority_missing');
    expect(r.evidenceClass).toBe('synthetic_fixture');
    expect(r.rosterAudit?.acceptedActorClassificationVerified).toBe(true);
    noClaims(r);
  });
  it('no retained Horse decision or lifecycle remains distinct from monetary completeness', () => {
    const x = prepare((v) => {
        v.hand.actions = [];
      }),
      join = reconcileHorseJournalHand(x.input.records, HAND_KEY),
      r = candidate(x.input, x.options);
    expect(join.status).toBe('reconciled');
    expect(join.requestedRequests).toBe(0);
    expect(join.requestLifecycleVerified).toBe(false);
    expect(r.status).toBe('known_empty_census');
    expect(r.requestLifecycleVerified).toBe(false);
    expect(r.reasons).toContain('request_lifecycle_unverified');
    expect(r.reasons).toContain('no_horse_decision_or_lifecycle_records_retained');
    expect(r.reasons).toContain('discretionary_horse_review_not_applicable');
    noClaims(r);
  });
  it('qualified human census keeps legacy action-origin gaps separate', () => {
    const x = prepare((v) => {
      v.hand.actions = v.hand.actions.map((a) => ({ ...a, origin: 'unknown' }));
    });
    const join = reconcileHorseJournalHand(x.input.records, HAND_KEY),
      r = candidate(x.input, x.options);
    expect(join.status).toBe('incomplete');
    expect(join.gaps).toEqual(['action_origin_unavailable']);
    expect(r.status).toBe('known_empty_census');
    expect(r.reasons).toContain('journal_action_origin_unavailable');
    expect(r.requestLifecycleVerified).toBe(false);
    noClaims(r);
  });
  it('qualified human census keeps unmatched legacy discard lineage separate', () => {
    const x = prepare((v) => {
      v.row.game_variant = 'pineapple';
      v.hand.actions = [
        {
          seat: v.f.hero.seat,
          userId: v.f.hero.user_id,
          action: 'discard',
          amount: 0,
          stage: 'pineapple_discard',
          timestamp: 1,
          origin: 'unknown',
        },
      ];
    });
    const join = reconcileHorseJournalHand(x.input.records, HAND_KEY),
      r = candidate(x.input, x.options);
    expect(join.status).toBe('incomplete');
    expect(join.gaps).toEqual(['unmatched_discard_action']);
    expect(r.status).toBe('known_empty_census');
    expect(r.reasons).toContain('journal_unmatched_discard_action');
    expect(r.requestLifecycleVerified).toBe(false);
    noClaims(r);
  });
  it('exact replayed accepted observation retains known-empty identity', () => {
    const x = prepare(),
      first = candidate(x.input, x.options);
    x.input.records = [...x.input.records, x.input.records[0]!];
    const r = candidate(x.input, x.options);
    expect(r.status).toBe('known_empty_census');
    expect(r.reviewId).toBe(first.reviewId);
    noClaims(r);
  });
  for (const flaw of ['source_missing', 'signature_invalid', 'key_wrong', 'producer_wrong'])
    it(`never infers emptiness when ${flaw}`, () => {
      const x = prepare();
      if (flaw === 'source_missing') x.input.rosterSource = undefined as never;
      if (flaw === 'signature_invalid')
        x.input.rosterSource.authorityEnvelope.signature = 'A'.repeat(88);
      if (flaw === 'key_wrong') x.options.rosterTrust.publicKeyDigest = '0'.repeat(64);
      if (flaw === 'producer_wrong') x.options.rosterTrust.producerSourceDigest = '0'.repeat(64);
      const r = candidate(x.input, x.options);
      pending(r);
      expect(r.rosterAudit?.status).toBe('pending');
    });
  it('legacy v1 source with no Horse action origins remains unavailable', () => {
    const x = prepare();
    const commitments = {
      ...x.input.commitments,
      version: 1,
      source: 'accepted_transaction',
      horseActorIds: [],
    };
    const r = candidate({ ...x.input, commitments });
    pending(r);
    expect(r.version).toBe('horse-corrective-review-v1');
    expect(r.reasons).toContain('horse_population_unavailable');
  });
  it('missing private roster transport is not an empty classification', () => {
    const x = prepare();
    delete x.x.hand.acceptedActorRoster;
    x.input.records = [x.x.f.make('accepted_hand', 3, x.x.hand)];
    x.input.commitments = {
      ...x.input.commitments,
      acceptedHandRecordDigest: x.input.records[0]!.sha256,
    };
    const r = candidate(x.input, x.options);
    pending(r);
    expect(r.reasons).not.toContain('known_empty_horse_census');
  });
  it('no known Horses plus an unknown actor is partial rather than empty', () => {
    const x = prepare((v) => {
      v.roster.actors[0]!.classification = 'unknown';
      v.roster.actors[0]!.status = 'profile_missing';
    });
    const r = candidate(x.input, x.options);
    pending(r);
    expect(r.rosterAudit?.status).toBe('partial_unknown');
    expect(r.rosterAudit?.unknownActorRefs).toHaveLength(1);
    expect(r.rosterAudit?.acceptedActorClassificationVerified).toBe(false);
  });
  it('a zero-commitment Horse remains a known census actor', () => {
    const x = prepare((v) => {
      const hero = v.roster.actors.find((a) => a.userId === v.f.hero.user_id)!;
      hero.classification = 'horse';
      v.hand.actions = [];
      for (const id of Object.keys(v.payload.accepted_hand_facts.contributions))
        v.payload.accepted_hand_facts.contributions[id] = 0;
      v.payload.accepted_hand_facts.returned_uncalled = {};
      for (const row of v.stacks) {
        row.stack = row.stack_before;
        v.receipt.written[row.user_id] = row.stack;
      }
    });
    const r = candidate(x.input, x.options);
    expect(r.status).not.toBe('known_empty_census');
    expect(r.actors).toHaveLength(1);
    expect(r.actors[0]!.actorRef).toBe(journalHash(x.x.f.hero.user_id));
    expect(r.actors[0]!.eligibility).toBe('not_over_10bb');
    expect(r.actors[0]!.grossCommittedBb).toBe(0);
    expect(r.actors[0]!.decisions).toEqual([]);
    noClaims(r);
  });
  it('a silent >10BB Horse remains eligible but its missing decisions remain pending', () => {
    const x = prepare((v) => {
      v.roster.actors.find((a) => a.userId === v.f.hero.user_id)!.classification = 'horse';
      v.hand.actions = [];
    });
    const r = candidate(x.input, x.options);
    pending(r);
    expect(r.actors).toHaveLength(1);
    expect(r.actors[0]!.eligibility).toBe('over_10bb');
    expect(r.reasons).toContain('eligible_actor_decisions_missing');
  });
  it('retained Horse decision cannot be relabelled as an empty all-human hand', () => {
    const x = prepare();
    x.input.records = [x.x.f.records[0]!, ...x.input.records];
    const exported = unsigned({ ...x.x.input, records: x.input.records });
    expect(exported.sourceExport.status).toBe('unsigned_export');
    x.input.commitments = exported.commitments;
    const signed = syntheticAuthority(exported);
    x.input.rosterSource.authorityEnvelope = signed.envelope;
    x.options.rosterTrust = signed.trust;
    const r = candidate(x.input, x.options);
    pending(r);
    expect(r.reasons).toContain('known_empty_roster_conflicts_with_retained_horse_work');
  });
  it('accepted Horse origin contradicting a human classification is refused', () => {
    const x = prepare();
    x.x.hand.actions[0]!.origin = 'horse_policy';
    sync(x.x);
    x.input.records = x.x.input.records;
    const refused = createUnsignedAcceptedCommitmentExport(x.x.input);
    expect(refused.sourceExport.status).toBe('unavailable');
    expect(refused.sourceExport.reasons).toContain('roster_action_classification_conflict');
    x.input.commitments = {
      ...x.input.commitments,
      acceptedHandRecordDigest: x.input.records[0]!.sha256,
    };
    const r = candidate(x.input, x.options);
    pending(r);
    expect(r.reasons).not.toContain('known_empty_horse_census');
  });
  it('corrupt accepted bytes never enter the known-empty result', () => {
    const x = prepare();
    x.input.records = [{ ...x.input.records[0]!, body: '{}' }];
    const r = candidate(x.input, x.options);
    pending(r);
    expect(r.reasons).toContain('journal_invalid_records');
  });
  it('a real-labelled source mixed with synthetic reference authority is not a real-history census', () => {
    const x = prepare();
    const signed = syntheticAuthority(x.exported, (a) => {
      a.evidenceClass = 'reviewed_source';
    });
    x.input.rosterSource.authorityEnvelope = signed.envelope;
    x.options.rosterTrust = signed.trust;
    const authority = authorize(x.exported.commitments, []).authority;
    const r = candidate({ ...x.input, authority }, x.options);
    pending(r);
    expect(r.evidenceClass).toBe('synthetic_fixture');
    expect(r.reasons).toContain('roster_reference_evidence_class_mismatch');
  });
});
