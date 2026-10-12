import { describe, expect, it, vi } from 'vitest';
import { sign } from 'node:crypto';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import * as journalRecord from '../horseDecisionJournal/record.js';
import { reviewHorseCorrectiveHand } from './review.js';
import { authoritySigningBytes, evidenceDigest, verifyCorrectiveAuthority } from './authority.js';
import {
  correctiveFixture,
  authorize,
  HAND_KEY,
  TRUSTED_KEY_DIGEST,
} from './fixture.test-support.js';
import type { CorrectiveReviewInput, CorrectiveReviewAuthority } from './contract.js';
import { CORRECTIVE_DOMAINS, correctiveDecisionDomain } from './domain.js';

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

  describe('Phase 14.4 domain, generation, expiry and evidence-class binding', () => {
    const NOW = Date.parse('2026-10-07T12:00:00.000Z');
    const signed = (
      f: ReturnType<typeof correctiveFixture>,
      overrides: Partial<CorrectiveReviewAuthority>,
      references: readonly unknown[] = [f.reference]
    ) => {
      const a = authorize(f.commitments, references, overrides);
      return { ...input(f), references: [...references], authority: a.authority };
    };

    it('binds the candidate to the decision domain, its menu and the reference provenance', () => {
      const f = correctiveFixture('plo4', 'mtt');
      const result = reviewHorseCorrectiveHand(input(f), { nowMs: NOW });
      const candidate = decision(result)!.candidate!;
      expect(candidate).toMatchObject({
        status: 'proposed_inactive',
        activationAllowed: false,
        domain: { variant: 'plo4', format: 'mtt', mode: 'tournament' },
        samplingContractDigest: f.reference.samplingContractDigest,
        producerDigest: f.reference.producerDigest,
        evidenceClass: 'synthetic_fixture',
      });
      expect(candidate.binding).toEqual(f.reference.binding);
      expect(candidate.menu).toEqual(f.reference.alternatives.map((a) => a.choice));
      expect(result.handKey).toBe(HAND_KEY);
    });

    it.each([
      ['variant', { variant: 'plo5' }],
      ['format', { format: 'sng', mode: 'tournament' }],
      ['mode', { mode: 'tournament' }],
    ] as const)('refuses a reference whose %s does not match the decision', (_label, change) => {
      const f = correctiveFixture();
      Object.assign(f.reference.domain, change);
      const d = decision(reviewHorseCorrectiveHand(input(f), { nowMs: NOW }));
      expect(d).toMatchObject({ candidate: null, disposition: 'reference_unavailable' });
      // An inconsistent mode is not a domain at all; a consistent other one is a mismatch.
      expect(['reference_domain_mismatch', 'reference_domain_invalid']).toContain(d!.reason);
      if (_label !== 'mode') expect(d!.reason).toBe('reference_domain_mismatch');
    });

    it('refuses a reference whose matching domain the signed authority does not cover', () => {
      const f = correctiveFixture('nlh', 'cash');
      const result = reviewHorseCorrectiveHand(
        signed(f, { domains: [{ variant: 'nlh', format: 'mtt', mode: 'tournament' }] }),
        { nowMs: NOW }
      );
      expect(decision(result)).toMatchObject({
        disposition: 'reference_unavailable',
        reason: 'reference_domain_not_authorized',
        candidate: null,
      });
      expect(result.status).toBe('incomplete');
    });

    it.each([
      ['no variant', { format: 'cash', gameMode: 'cash' }],
      ['no format', { gameVariant: 'nlh', gameMode: 'cash' }],
      ['no game mode', { gameVariant: 'nlh', format: 'cash' }],
      [
        'a cash format in tournament mode',
        { gameVariant: 'nlh', format: 'cash', gameMode: 'tournament' },
      ],
      ['a tournament format in cash mode', { gameVariant: 'nlh', format: 'mtt', gameMode: 'cash' }],
      ['an unknown variant', { gameVariant: 'razz', format: 'cash', gameMode: 'cash' }],
      ['an upper-case variant', { gameVariant: 'NLH', format: 'cash', gameMode: 'cash' }],
    ] as const)('reads no domain from an original decision with %s (never a default)', (_l, gs) => {
      expect(correctiveDecisionDomain(gs)).toBeNull();
    });

    it('reads every known variant and format as its own domain', () => {
      expect(CORRECTIVE_DOMAINS).toHaveLength(45);
      for (const d of CORRECTIVE_DOMAINS)
        expect(
          correctiveDecisionDomain({ gameVariant: d.variant, format: d.format, gameMode: d.mode })
        ).toEqual(d);
    });

    it.each([
      ['an expired authority', { expiresAt: '2026-10-07T12:00:00.000Z' }, 'authority_expired'],
      ['an inexact expiry', { expiresAt: '2026-10-08' }, 'authority_expiry_invalid'],
      ['generation zero', { approvalGeneration: 0 }, 'authority_generation_invalid'],
      ['a negative generation', { approvalGeneration: -3 }, 'authority_generation_invalid'],
      ['a fractional generation', { approvalGeneration: 1.5 }, 'authority_generation_invalid'],
      ['no signed domains', { domains: [] }, 'authority_domains_invalid'],
      [
        'a malformed signed domain',
        { domains: [{ variant: 'nlh', format: 'cash', mode: 'tournament' }] },
        'authority_domains_invalid',
      ],
      [
        'a duplicated signed domain',
        {
          domains: [
            { variant: 'nlh', format: 'cash', mode: 'cash' },
            { variant: 'nlh', format: 'cash', mode: 'cash' },
          ],
        },
        'authority_domains_invalid',
      ],
    ] as const)('refuses %s by name even with a valid signature', (_label, overrides, reason) => {
      const f = correctiveFixture();
      const i = signed(f, overrides as Partial<CorrectiveReviewAuthority>);
      expect(i.authority).not.toBeUndefined();
      const result = reviewHorseCorrectiveHand(i, { nowMs: NOW });
      expect(result.status).toBe('incomplete');
      expect(result.reasons).toContain(reason);
      expect(result.actors[0]?.eligibility).toBe('unknown');
      expect(result.actors.flatMap((a) => a.decisions).every((d) => d.candidate === null)).toBe(
        true
      );
    });

    it('admits an authority one millisecond before its expiry', () => {
      const f = correctiveFixture();
      const i = signed(f, { expiresAt: '2026-10-07T12:00:00.001Z' });
      expect(decision(reviewHorseCorrectiveHand(i, { nowMs: NOW }))?.disposition).toBe('finding');
    });

    it('refuses mixed synthetic and reviewed evidence between a reference and its authority', () => {
      const f = correctiveFixture();
      f.reference.evidenceClass = 'reviewed_reference';
      const result = reviewHorseCorrectiveHand(input(f), { nowMs: NOW });
      expect(result.reasons).toContain('mixed_synthetic_and_reviewed_evidence');
      expect(result.evidenceClass).toBe('synthetic_fixture');
      expect(result.status).toBe('incomplete');
      expect(decision(result)?.candidate ?? null).toBeNull();
    });

    it('refuses mixed evidence across references, even an unmatched one', () => {
      const f = correctiveFixture();
      const stray = structuredClone(f.reference) as typeof f.reference;
      stray.evidenceClass = 'reviewed_reference';
      stray.binding.decisionEventId = 'unrelated-decision';
      const result = reviewHorseCorrectiveHand(signed(f, {}, [f.reference, stray]), {
        nowMs: NOW,
      });
      expect(result.reasons).toContain('mixed_synthetic_and_reviewed_evidence');
      expect(result.status).toBe('incomplete');
      expect(decision(result)?.candidate ?? null).toBeNull();
    });

    it('a reviewed-labelled authority with a synthetic reference is mixed, never a real-history claim', () => {
      const f = correctiveFixture();
      const result = reviewHorseCorrectiveHand(signed(f, { evidenceClass: 'reviewed_reference' }), {
        nowMs: NOW,
      });
      expect(result.reasons).toContain('mixed_synthetic_and_reviewed_evidence');
      expect(result.evidenceClass).toBe('synthetic_fixture');
      expect(decision(result)?.candidate ?? null).toBeNull();
    });

    it.each([
      ['v1', (r: any): void => void (r.version = 1), 'reference_version_unsupported'],
      ['missing domain', (r: any): void => void delete r.domain, 'reference_domain_invalid'],
      [
        'unknown variant',
        (r: any): void => void (r.domain.variant = 'razz'),
        'reference_domain_invalid',
      ],
      [
        'extra domain key',
        (r: any): void => void (r.domain.stakes = 'any'),
        'reference_domain_invalid',
      ],
      [
        'missing sampling contract',
        (r: any): void => void delete r.samplingContractDigest,
        'reference_provenance_missing',
      ],
      [
        'malformed producer',
        (r: any): void => void (r.producerDigest = 'abc'),
        'reference_provenance_missing',
      ],
      [
        'unknown evidence class',
        (r: any): void => void (r.evidenceClass = 'approximate'),
        'reference_evidence_class_invalid',
      ],
    ] as const)('refuses a reference with %s by name', (_label, mutate, reason) => {
      const f = correctiveFixture();
      mutate(f.reference);
      const result = reviewHorseCorrectiveHand(input(f), { nowMs: NOW });
      expect(decision(result)).toMatchObject({
        disposition: 'reference_unavailable',
        reason,
        candidate: null,
      });
      expect(result.rejectedReferences[0]?.referenceId).toBe(evidenceDigest(f.reference));
    });

    it('never verifies a v1 envelope or a v2 authority signed under the v1 message', () => {
      const f = correctiveFixture();
      const a = authorize(f.commitments, [f.reference]);
      const v1 = {
        version: 1,
        role: a.authority.role,
        handKey: a.authority.handKey,
        qualificationId: a.authority.qualificationId,
        evidenceClass: a.authority.evidenceClass,
        commitmentDigest: a.authority.commitmentDigest,
        referenceDigests: [...a.authority.referenceDigests],
      };
      const v1Signature = sign(
        null,
        Buffer.from(horseJournalJson(['horse-corrective-review-authority-v1', v1])),
        a.privateKey
      ).toString('base64');
      expect(
        verifyCorrectiveAuthority(
          { authority: v1, publicKeyPem: a.envelope.publicKeyPem, signature: v1Signature },
          TRUSTED_KEY_DIGEST
        )
      ).toBeNull();
      const v2UnderOldMessage = JSON.parse(JSON.stringify(a.envelope.authority));
      const oldMessage = sign(
        null,
        Buffer.from(horseJournalJson(['horse-corrective-review-authority-v1', v2UnderOldMessage])),
        a.privateKey
      ).toString('base64');
      expect(
        verifyCorrectiveAuthority(
          { ...a.envelope, authority: v2UnderOldMessage, signature: oldMessage },
          TRUSTED_KEY_DIGEST
        )
      ).toBeNull();
      // The current envelope verifies; the signed bytes name the v2 message.
      expect(verifyCorrectiveAuthority(a.envelope, TRUSTED_KEY_DIGEST)).not.toBeNull();
      expect(authoritySigningBytes(a.envelope.authority).toString()).toContain(
        'horse-corrective-review-authority-v2'
      );
    });

    it.each([
      ['approvalGeneration', (x: any): void => void (x.approvalGeneration = 2)],
      ['expiresAt', (x: any): void => void (x.expiresAt = '2100-01-01T00:00:00.000Z')],
      ['domains', (x: any): void => void x.domains.pop()],
      ['a domain field', (x: any): void => void (x.domains[0].format = 'mtt')],
    ] as const)('the signature covers %s', (_label, mutate) => {
      const f = correctiveFixture();
      const a = authorize(f.commitments, [f.reference]);
      mutate(a.envelope.authority);
      expect(verifyCorrectiveAuthority(a.envelope, TRUSTED_KEY_DIGEST)).toBeNull();
    });

    it('trust stays out of the envelope: no trust key, generation or approval is read from it', () => {
      const f = correctiveFixture();
      const a = authorize(f.commitments, [f.reference]);
      const withTrust = {
        ...a.envelope,
        trustedPublicKeyDigest: TRUSTED_KEY_DIGEST,
        activationAllowed: true,
      };
      expect(verifyCorrectiveAuthority(withTrust, undefined)).toBeNull();
      const verified = verifyCorrectiveAuthority(withTrust, TRUSTED_KEY_DIGEST)!;
      expect(Object.keys(verified)).not.toContain('trustedPublicKeyDigest');
      expect(Object.keys(verified)).not.toContain('activationAllowed');
      expect(Object.isFrozen(verified.domains)).toBe(true);
    });
  });
});
