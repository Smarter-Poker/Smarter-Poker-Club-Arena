import { describe, expect, it, vi } from 'vitest';
import { journalHash } from '../horseDecisionJournal/record.js';
import * as journalRecord from '../horseDecisionJournal/record.js';
import { reviewHorseCorrectiveHand } from './review.js';
import { evidenceDigest, verifyCorrectiveAuthority } from './authority.js';
import {
  correctiveFixture,
  authorize,
  HAND_KEY,
  TRUSTED_KEY_DIGEST,
} from './fixture.test-support.js';
import type { CorrectiveReviewInput } from './contract.js';

function input(f = correctiveFixture()): CorrectiveReviewInput {
  return {
    records: f.records,
    handKey: HAND_KEY,
    commitments: f.commitments,
    references: [f.reference],
    authority: authorize(f.commitments, [f.reference]).authority,
  };
}
const decision = (r: ReturnType<typeof reviewHorseCorrectiveHand>) => r.actors[0]?.decisions[0];

describe('source-bound private corrective review', () => {
  it('produces a bounded inactive candidate only from signed exact-input counterfactual evidence', () => {
    const i = input(),
      result = reviewHorseCorrectiveHand(i);
    expect(result).toMatchObject({
      status: 'reviewed',
      evidenceClass: 'synthetic_fixture',
      completePopulation: false,
      replayVerified: false,
      gtoVerified: false,
      activationAllowed: false,
    });
    expect(result.actors[0]).toMatchObject({ eligibility: 'over_10bb', grossCommittedBb: 21 });
    expect(decision(result)).toMatchObject({
      disposition: 'finding',
      candidate: {
        status: 'proposed_inactive',
        from: { action: 'call', amount: 1 },
        to: { action: 'fold', amount: 0 },
        conservativeGain: 1,
        maximumProbabilityDelta: 0.05,
        activationAllowed: false,
      },
    });
    expect(decision(result)?.candidate?.requiredBeforeActivation).toContain('independent_holdout');
    expect(reviewHorseCorrectiveHand(i)).toEqual(result);
    const json = JSON.stringify(result);
    for (const secret of [
      'holeCards',
      'spades',
      'clubs',
      'player',
      '20000000-0000-4000-8000-000000000001',
    ])
      expect(json).not.toContain(secret);
  });
  it('records a non-finding when no menu alternative materially improves the chosen action', () => {
    const f = correctiveFixture();
    f.reference.alternatives[1]!.mean = 2;
    f.reference.alternatives[1]!.lower = 2;
    f.reference.alternatives[1]!.upper = 2;
    const result = reviewHorseCorrectiveHand(input(f));
    expect(decision(result)).toMatchObject({ disposition: 'non_finding', candidate: null });
  });
  it('keeps overlap as insufficient evidence rather than declaring a mistake', () => {
    const f = correctiveFixture();
    f.reference.alternatives[1]!.upper = 2;
    expect(decision(reviewHorseCorrectiveHand(input(f)))).toMatchObject({
      disposition: 'insufficient_evidence',
      reason: 'alternative_uncertainty_overlaps',
      candidate: null,
    });
  });
  it.each(['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'pineapple'] as const)(
    'never outcome-filters >10BB eligibility for %s',
    (variant) => {
      const f = correctiveFixture(variant);
      const result = reviewHorseCorrectiveHand(input(f));
      expect(result.actors[0]?.eligibility).toBe('over_10bb');
      expect(result.gtoVerified).toBe(false);
    }
  );
  it.each(['cash', 'mtt', 'sng', 'spin', 'hu_sng'] as const)(
    'retains gross eligibility and original utility units for %s',
    (format) => {
      const f = correctiveFixture('nlh', format),
        result = reviewHorseCorrectiveHand(input(f));
      expect(result.actors[0]?.eligibility).toBe('over_10bb');
      expect(decision(result)).toMatchObject({
        disposition: 'finding',
        candidate: { utilityUnit: format === 'cash' ? 'net_chip_bb' : 'net_tournament_utility' },
      });
    }
  );
  it.each([
    [10, 0, 'not_over_10bb'],
    [10, 0.01, 'over_10bb'],
    [4, 7, 'over_10bb'],
    [0, 11, 'over_10bb'],
  ] as const)(
    'uses strict gross commitment boundary net=%s returned=%s',
    (net, returned, expected) => {
      const f = correctiveFixture();
      f.commitments.payloadText = JSON.stringify({
        accepted_hand_facts: {
          contributions: { [f.hero.user_id]: net },
          returned_uncalled: { [f.hero.user_id]: returned },
        },
      });
      f.commitments.payloadDigest = journalHash(f.commitments.payloadText);
      expect(reviewHorseCorrectiveHand(input(f)).actors[0]?.eligibility).toBe(expected);
    }
  );
  it.each([
    'missing_authority',
    'forged_authority',
    'unsigned_changed_facts',
    'missing_refunds',
    'bad_digest',
    'wrong_hand',
    'wrong_actions',
    'wrong_bb',
  ])('refuses untrusted or mismatched accepted commitment facts: %s', (fault) => {
    const f = correctiveFixture(),
      i = input(f);
    if (fault === 'missing_authority') i.authority = undefined;
    if (fault === 'forged_authority') i.authority = JSON.parse(JSON.stringify(i.authority));
    if (fault === 'unsigned_changed_facts') f.commitments.bigBlind = 2;
    if (fault === 'missing_refunds') {
      f.commitments.payloadText = JSON.stringify({
        accepted_hand_facts: { contributions: { [f.hero.user_id]: 21 } },
      });
      f.commitments.payloadDigest = journalHash(f.commitments.payloadText);
    }
    if (fault === 'bad_digest') f.commitments.payloadDigest = 'b'.repeat(64);
    if (fault === 'wrong_hand') f.commitments.committedHandId = 'different';
    if (fault === 'wrong_actions') f.commitments.actionsDigest = 'b'.repeat(64);
    if (fault === 'wrong_bb') f.commitments.bigBlind = 2;
    if (!['missing_authority', 'forged_authority', 'unsigned_changed_facts'].includes(fault))
      i.authority = authorize(f.commitments, [f.reference]).authority;
    const result = reviewHorseCorrectiveHand(i);
    expect(result.status).toBe('incomplete');
    expect(result.actors[0]?.eligibility).toBe('unknown');
    expect(decision(result)?.candidate).toBeNull();
  });
  it.each([
    'missing',
    'unapproved',
    'observational',
    'noncausal',
    'future_information',
    'incomplete',
    'input',
    'read_frame',
    'execution',
    'source',
    'source_identity',
    'legal_amount',
    'missing_action',
    'duplicate_action',
    'costs',
    'utility_context',
    'confidence',
    'non_simultaneous',
    'invalid_interval',
  ])('preserves explicit rejection for a bad alternative reference: %s', (fault) => {
    const f = correctiveFixture();
    const r = f.reference as any;
    if (fault === 'observational') r.basis = 'observational';
    if (fault === 'noncausal') r.causal = false;
    if (fault === 'future_information') r.informationSet = 'actual_future_cards';
    if (fault === 'incomplete') r.complete = false;
    if (fault === 'input') r.binding.inputDigest = 'b'.repeat(64);
    if (fault === 'read_frame') r.binding.readFrameDigest = 'b'.repeat(64);
    if (fault === 'execution') r.binding.executionDigest = 'b'.repeat(64);
    if (fault === 'source') r.binding.sourceRelease = 'b'.repeat(40);
    if (fault === 'source_identity') r.sourceId = '';
    if (fault === 'legal_amount') r.alternatives[1].choice.amount = 2;
    if (fault === 'missing_action') r.alternatives.pop();
    if (fault === 'duplicate_action') r.alternatives.push(structuredClone(r.alternatives[0]));
    if (fault === 'costs') r.utility.costsIncluded = false;
    if (fault === 'utility_context') r.utility.contextDigest = 'b'.repeat(64);
    if (fault === 'confidence') r.uncertainty.familyWiseConfidence = 0.5;
    if (fault === 'non_simultaneous') r.uncertainty.simultaneous = false;
    if (fault === 'invalid_interval') r.alternatives[0].lower = 5;
    const i = input(f);
    if (fault === 'missing') i.references = [];
    if (fault === 'unapproved') i.authority = authorize(f.commitments, []).authority;
    const result = reviewHorseCorrectiveHand(i);
    expect(result.status).toBe('incomplete');
    expect(decision(result)?.candidate).toBeNull();
    expect(['reference_unavailable', 'insufficient_evidence']).toContain(
      decision(result)?.disposition
    );
    if (fault !== 'missing')
      expect(result.rejectedReferences[0]?.referenceId).toBe(evidenceDigest(f.reference));
  });
  it.each(['missing_execution', 'corrupt_record', 'mismatched_accepted_action'])(
    'keeps %s pending or unavailable',
    (fault) => {
      const f = correctiveFixture(),
        i = input(f);
      if (fault === 'missing_execution')
        i.records = f.records.filter((r) => r.kind !== 'execution');
      if (fault === 'corrupt_record')
        i.records = f.records.map((r, index) => (index ? r : { ...r, body: r.body + ' ' }));
      if (fault === 'mismatched_accepted_action') {
        f.hand.actions!.at(-1)!.amount = 2;
        i.records = [f.records[0]!, f.records[1]!, f.make('accepted_hand', 3, f.hand)];
      }
      const result = reviewHorseCorrectiveHand(i);
      expect(result.status).toBe('incomplete');
      expect(result.actors.flatMap((a) => a.decisions).every((d) => d.candidate === null)).toBe(
        true
      );
    }
  );
  it('does not trust an envelope-supplied public key or a changed signed manifest', () => {
    const f = correctiveFixture(),
      a = authorize(f.commitments, [f.reference]);
    expect(verifyCorrectiveAuthority(a.envelope, undefined)).toBeNull();
    expect(verifyCorrectiveAuthority(a.envelope, 'b'.repeat(64))).toBeNull();
    a.envelope.authority.referenceDigests = [];
    expect(verifyCorrectiveAuthority(a.envelope, TRUSTED_KEY_DIGEST)).toBeNull();
  });
  it('revokes tentative success and preserves candidate identity after final serialization fails', () => {
    const i = input(),
      candidateId = decision(reviewHorseCorrectiveHand(i))!.candidate!.id;
    const original = journalRecord.horseJournalJson;
    const serialization = vi
      .spyOn(journalRecord, 'horseJournalJson')
      .mockImplementation((value) => {
        if (
          value &&
          typeof value === 'object' &&
          'scope' in value &&
          value.scope === 'single_retained_hand_qualified_menu'
        )
          throw Error('injected_output_failure');
        return original(value);
      });
    try {
      const result = reviewHorseCorrectiveHand(i);
      expect(result.status).toBe('incomplete');
      expect(result.actors).toEqual([]);
      expect(result.rejectedCandidates).toEqual([
        { candidateId, reason: 'invalid_review_evidence' },
      ]);
      expect(result.reasons).toContain('invalid_review_evidence');
      expect(result.activationAllowed).toBe(false);
    } finally {
      serialization.mockRestore();
    }
  });
  it('rejects private extra properties in even an authority-pinned action choice', () => {
    const f = correctiveFixture();
    Object.assign(f.reference.alternatives[0]!.choice, {
      holeCards: ['As', 'Ks'],
      actorId: f.hero.user_id,
    });
    const result = reviewHorseCorrectiveHand(input(f));
    expect(decision(result)).toMatchObject({
      disposition: 'reference_unavailable',
      reason: 'reference_illegal_action_or_interval',
      candidate: null,
    });
    expect(JSON.stringify(result)).not.toContain('holeCards');
    expect(JSON.stringify(result)).not.toContain(f.hero.user_id);
  });
  it('preserves every duplicate reference identity while refusing an ambiguous match', () => {
    const i = input();
    i.references = [i.references![0], structuredClone(i.references![0])];
    const result = reviewHorseCorrectiveHand(i);
    expect(decision(result)).toMatchObject({
      disposition: 'reference_unavailable',
      reason: 'reference_identity_ambiguous',
      candidate: null,
    });
    expect(result.rejectedReferences).toHaveLength(2);
    expect(result.rejectedReferences[0]).toEqual(result.rejectedReferences[1]);
  });
  it.each(['records', 'references', 'reference_bytes', 'malformed_references'] as const)(
    'bounds %s before qualified review',
    (fault) => {
      const i = input();
      if (fault === 'records') i.records = Array.from({ length: 257 }, () => i.records[0]!);
      if (fault === 'references')
        i.references = Array.from({ length: 129 }, () => i.references![0]);
      if (fault === 'reference_bytes') i.references = [{ oversized: 'x'.repeat(2 * 1024 * 1024) }];
      if (fault === 'malformed_references') (i as any).references = { not: 'an array' };
      const result = reviewHorseCorrectiveHand(i);
      expect(result.status).toBe('incomplete');
      expect(result.actors).toEqual([]);
      expect(result.reasons).toContain(
        fault === 'records' ? 'journal_input_bounds' : 'reference_input_bounds'
      );
    }
  );
  it('keeps the original private evidence immutable and changes identity with rejected reference bytes', () => {
    const i = input(),
      before = JSON.stringify(i),
      first = reviewHorseCorrectiveHand(i);
    expect(JSON.stringify(i)).toBe(before);
    decision(first)!.candidate!.to.amount = 999;
    expect(JSON.stringify(i)).toBe(before);
    const f = correctiveFixture();
    f.reference.informationSet = 'actual_future_cards' as any;
    const second = reviewHorseCorrectiveHand(input(f));
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(second.rejectedReferences[0]?.referenceId).toBe(evidenceDigest(f.reference));
  });
  it.each(['win', 'loss', 'tie', 'uncalled_return'] as const)(
    'does not exclude the accepted %s outcome from gross audit eligibility',
    (outcome) => {
      const f = correctiveFixture();
      const payload = JSON.parse(f.commitments.payloadText);
      payload.outcome = outcome;
      f.commitments.payloadText = JSON.stringify(payload);
      f.commitments.payloadDigest = journalHash(f.commitments.payloadText);
      expect(reviewHorseCorrectiveHand(input(f)).actors[0]?.eligibility).toBe('over_10bb');
    }
  );
});
