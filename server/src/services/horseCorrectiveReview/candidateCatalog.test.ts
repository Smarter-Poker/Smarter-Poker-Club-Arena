import { describe, expect, it } from 'vitest';
import { reviewHorseCorrectiveHand } from './review.js';
import {
  buildCorrectiveCandidateCatalog,
  correctiveCatalogCandidateId,
  correctiveCatalogDigest,
  CORRECTIVE_SELECTION_PROTOCOL_VERSION,
  type CorrectiveCatalogInput,
  type CorrectivePolicyDistribution,
  type CorrectiveSelectionProtocol,
} from './candidateCatalog.js';
import { correctiveFixture, authorize, HAND, HAND_KEY } from './fixture.test-support.js';
import { journalHash } from '../horseDecisionJournal/record.js';
import type { CorrectiveHandReview } from './contract.js';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number) => journalHash(`synthetic-hand-${n}`);
const hand = (n: number) => ({ handId: uuid(n), handKey: key(n) });

function review(format: 'cash' | 'mtt' = 'cash', change?: (f: any) => void) {
  const f = correctiveFixture('nlh', format);
  change?.(f);
  const result = reviewHorseCorrectiveHand(
    {
      records: f.records,
      handKey: HAND_KEY,
      commitments: f.commitments,
      references: [f.reference],
      authority: authorize(f.commitments, [f.reference]).authority,
    },
    { nowMs: NOW }
  );
  expect(result.status).toBe('reviewed');
  return { f, review: result, candidate: result.actors[0]!.decisions[0]!.candidate! };
}

function distributionFor(
  r: ReturnType<typeof review>,
  probabilities = [0.3, 0.7]
): CorrectivePolicyDistribution {
  return {
    domain: { ...r.candidate.domain },
    informationSetDigest: r.candidate.binding.inputDigest,
    probabilities: r.candidate.menu.map((choice, i) => ({
      choice: { ...choice },
      probability: probabilities[i]!,
    })),
  };
}

function protocol(
  overrides: Partial<CorrectiveSelectionProtocol> = {}
): CorrectiveSelectionProtocol {
  return {
    version: CORRECTIVE_SELECTION_PROTOCOL_VERSION,
    protocolId: 'synthetic-protocol-1',
    declaredAt: '2026-10-01T00:00:00.000Z',
    selectionWindow: {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-03T00:00:00.000Z',
      hands: [{ handId: HAND, handKey: HAND_KEY }, hand(2)],
    },
    holdoutWindow: {
      from: '2026-10-04T00:00:00.000Z',
      to: '2026-10-06T00:00:00.000Z',
      hands: [hand(10), hand(11)],
    },
    domains: [
      { variant: 'nlh', format: 'cash', mode: 'cash' },
      { variant: 'nlh', format: 'mtt', mode: 'tournament' },
    ],
    maxCandidates: 8,
    minimumConservativeGain: 0.01,
    validationWindow: 'holdout',
    ...overrides,
  };
}

function catalogInput(): CorrectiveCatalogInput & { cash: ReturnType<typeof review> } {
  const cash = review('cash'),
    mtt = review('mtt');
  return {
    cash,
    protocol: protocol(),
    reviews: [
      { handId: HAND, review: cash.review },
      { handId: HAND, review: mtt.review },
    ],
    distributions: [distributionFor(cash), distributionFor(mtt)],
  };
}

describe('Phase 14.4 inactive corrective candidate catalog', () => {
  it('builds a digest-bound catalog in which every entry is proposed_inactive and never activatable', () => {
    const input = catalogInput();
    const catalog = buildCorrectiveCandidateCatalog(input);
    expect(catalog).toMatchObject({
      status: 'built',
      reasons: [],
      evidenceClass: 'synthetic_fixture',
      domains: ['nlh-cash', 'nlh-mtt'],
      holdoutEvaluated: false,
      activationAllowed: false,
    });
    expect(catalog.entries).toHaveLength(2);
    for (const entry of catalog.entries) {
      expect(entry.status).toBe('proposed_inactive');
      expect(entry.activationAllowed).toBe(false);
      expect(entry.requiredBeforeActivation).toContain('independent_holdout');
      expect(entry.handKey).toBe(HAND_KEY);
      // The proposal moves at most five points from `from` to `to`, and only that.
      const before = Object.fromEntries(
        entry.baselineDistribution.map((x) => [x.choice.action, x.probability])
      );
      const after = Object.fromEntries(
        entry.proposedDistribution.map((x) => [x.choice.action, x.probability])
      );
      expect(before[entry.from.action]! - after[entry.from.action]!).toBeCloseTo(0.05, 12);
      expect(after[entry.to.action]! - before[entry.to.action]!).toBeCloseTo(0.05, 12);
      expect(entry.proposedDistribution.reduce((s, x) => s + x.probability, 0)).toBeCloseTo(1, 12);
    }
    expect(catalog.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(correctiveCatalogDigest(catalog)).toBe(catalog.catalogDigest);
    expect(catalog.holdoutDigest).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, and independent of input order.
    const reordered = buildCorrectiveCandidateCatalog({
      ...input,
      reviews: [...input.reviews].reverse(),
      distributions: [...input.distributions].reverse(),
    });
    expect(reordered).toEqual(catalog);
  });

  it('keys a candidate by its binding and move, not by its measured gain', () => {
    const a = review('cash');
    const b = review('cash', (f) => {
      f.reference.alternatives[0].lower = 0.5;
      f.reference.alternatives[0].mean = 0.5;
      f.reference.alternatives[0].upper = 0.5;
    });
    expect(b.candidate.conservativeGain).not.toBe(a.candidate.conservativeGain);
    expect(b.candidate.binding).toEqual(a.candidate.binding);
    const id = (r: typeof a) =>
      correctiveCatalogCandidateId(
        r.candidate.domain,
        r.candidate.binding,
        r.candidate.from,
        r.candidate.to
      );
    expect(id(b)).toBe(id(a));
    const catalog = buildCorrectiveCandidateCatalog({
      protocol: protocol(),
      reviews: [{ handId: HAND, review: a.review }],
      distributions: [distributionFor(a)],
    });
    expect(catalog.entries[0]!.id).toBe(id(a));
    // A different move at the same binding is a different candidate.
    expect(
      correctiveCatalogCandidateId(
        a.candidate.domain,
        a.candidate.binding,
        a.candidate.to,
        a.candidate.from
      )
    ).not.toBe(id(a));
  });

  it('changes the catalog digest when the holdout changes, even with identical entries', () => {
    const input = catalogInput();
    const first = buildCorrectiveCandidateCatalog(input);
    const second = buildCorrectiveCandidateCatalog({
      ...input,
      protocol: protocol({
        holdoutWindow: { ...protocol().holdoutWindow, hands: [hand(10), hand(12)] },
      }),
    });
    expect(second.entries).toEqual(first.entries);
    expect(second.holdoutDigest).not.toBe(first.holdoutDigest);
    expect(second.catalogDigest).not.toBe(first.catalogDigest);
  });

  describe('holdout leakage', () => {
    it.each([
      [
        'a holdout hand id in the selection window',
        () =>
          protocol({
            holdoutWindow: {
              ...protocol().holdoutWindow,
              hands: [hand(10), { handId: HAND, handKey: key(99) }],
            },
          }),
      ],
      [
        'a holdout hand key in the selection window under another id',
        () =>
          protocol({
            holdoutWindow: {
              ...protocol().holdoutWindow,
              hands: [hand(10), { handId: uuid(99), handKey: HAND_KEY }],
            },
          }),
      ],
      [
        'a holdout hand id in another case',
        () =>
          protocol({
            holdoutWindow: {
              ...protocol().holdoutWindow,
              hands: [hand(10), { handId: HAND.toUpperCase(), handKey: key(98) }],
            },
          }),
      ],
    ])('refuses %s', (_label, make) => {
      const input = catalogInput();
      const catalog = buildCorrectiveCandidateCatalog({ ...input, protocol: make() });
      expect(catalog.status).toBe('refused');
      expect(catalog.reasons).toContain('holdout_leakage');
      expect(catalog.entries).toEqual([]);
      expect(catalog.catalogDigest).toBeNull();
      expect(catalog.activationAllowed).toBe(false);
    });

    it('refuses a selection review of a holdout hand even when the selection window omits it', () => {
      const input = catalogInput();
      const leaked = { ...input.cash.review, handKey: key(10), reviewId: journalHash('leaked') };
      const catalog = buildCorrectiveCandidateCatalog({
        ...input,
        reviews: [...input.reviews, { handId: uuid(10), review: leaked as CorrectiveHandReview }],
      });
      expect(catalog.reasons).toContain('holdout_leakage');
      expect(catalog.status).toBe('refused');
    });

    it('refuses a review whose hand is not in the declared selection window', () => {
      const input = catalogInput();
      const stray = { ...input.cash.review, handKey: key(50), reviewId: journalHash('stray') };
      const catalog = buildCorrectiveCandidateCatalog({
        ...input,
        reviews: [...input.reviews, { handId: uuid(50), review: stray as CorrectiveHandReview }],
      });
      expect(catalog.status).toBe('refused');
      expect(catalog.reasons).toContain('review_outside_selection_window');
      expect(catalog.excludedReviews).toContainEqual({
        reviewId: stray.reviewId,
        reason: 'review_outside_selection_window',
      });
    });
  });

  describe('finite selection protocol', () => {
    it.each([
      ['the selection window named as validation', { validationWindow: 'selection' as never }],
      [
        'a holdout identical to the selection window',
        { holdoutWindow: protocol().selectionWindow },
      ],
      [
        'a holdout window overlapping the selection window in time',
        {
          holdoutWindow: {
            from: '2026-10-02T00:00:00.000Z',
            to: '2026-10-05T00:00:00.000Z',
            hands: [hand(10)],
          },
        },
      ],
    ])('refuses %s as selection_window_reused_as_validation', (_label, overrides) => {
      const catalog = buildCorrectiveCandidateCatalog({
        ...catalogInput(),
        protocol: protocol(overrides),
      });
      expect(catalog.status).toBe('refused');
      expect(catalog.reasons).toContain('selection_window_reused_as_validation');
    });

    it('refuses a protocol declared after the holdout window opened', () => {
      const catalog = buildCorrectiveCandidateCatalog({
        ...catalogInput(),
        protocol: protocol({ declaredAt: '2026-10-04T00:00:00.001Z' }),
      });
      expect(catalog.reasons).toEqual(['selection_protocol_declared_after_validation']);
      expect(catalog.status).toBe('refused');
    });

    it.each([
      ['an unbounded candidate cap', { maxCandidates: Number.POSITIVE_INFINITY }],
      ['a zero candidate cap', { maxCandidates: 0 }],
      ['a cap above the module bound', { maxCandidates: 1025 }],
      ['a minimum gain below 0.01', { minimumConservativeGain: 0 }],
      ['no domains', { domains: [] }],
      ['an empty holdout', { holdoutWindow: { ...protocol().holdoutWindow, hands: [] } }],
      [
        'an inexact window bound',
        { holdoutWindow: { ...protocol().holdoutWindow, from: '2026-10-04' } },
      ],
      [
        'a reversed window',
        { holdoutWindow: { ...protocol().holdoutWindow, from: '2026-10-07T00:00:00.000Z' } },
      ],
      [
        'a malformed hand key',
        {
          holdoutWindow: {
            ...protocol().holdoutWindow,
            hands: [{ handId: uuid(10), handKey: 'x' }],
          },
        },
      ],
      ['another version', { version: 'horse-corrective-selection-protocol-v0' as never }],
    ])('refuses %s as an invalid protocol', (_label, overrides) => {
      const catalog = buildCorrectiveCandidateCatalog({
        ...catalogInput(),
        protocol: protocol(overrides),
      });
      expect(catalog).toMatchObject({
        status: 'refused',
        reasons: ['selection_protocol_invalid'],
        entries: [],
        catalogDigest: null,
      });
    });

    it('refuses more eligible candidates than declared rather than choosing by order', () => {
      const catalog = buildCorrectiveCandidateCatalog({
        ...catalogInput(),
        protocol: protocol({ maxCandidates: 1 }),
      });
      expect(catalog.status).toBe('refused');
      expect(catalog.reasons).toContain('selection_protocol_exceeded');
    });

    it('lists, never drops, a candidate outside the protocol domains or below its minimum gain', () => {
      const input = catalogInput();
      const narrow = buildCorrectiveCandidateCatalog({
        ...input,
        protocol: protocol({ domains: [{ variant: 'nlh', format: 'cash', mode: 'cash' }] }),
      });
      expect(narrow.status).toBe('built');
      expect(narrow.entries.map((e) => e.domainKey)).toEqual(['nlh-cash']);
      expect(narrow.unselectedCandidates).toEqual([
        { candidateId: expect.stringMatching(/^[0-9a-f]{64}$/), reason: 'domain_outside_protocol' },
      ]);
      const strict = buildCorrectiveCandidateCatalog({
        ...input,
        protocol: protocol({ minimumConservativeGain: 5 }),
      });
      expect(strict.entries).toEqual([]);
      expect(strict.unselectedCandidates.map((u) => u.reason)).toEqual([
        'below_protocol_minimum_gain',
        'below_protocol_minimum_gain',
      ]);
    });
  });

  describe('policy distribution completeness', () => {
    it.each([
      ['a missing distribution', (d: CorrectivePolicyDistribution[]) => d.splice(0, 1)],
      [
        'a legal action without a probability',
        (d: CorrectivePolicyDistribution[]) => d[0]!.probabilities.pop(),
      ],
      [
        'an action outside the legal menu',
        (d: CorrectivePolicyDistribution[]) =>
          d[0]!.probabilities.push({ choice: { action: 'raise', amount: 5 }, probability: 0 }),
      ],
      [
        'a sum below 1',
        (d: CorrectivePolicyDistribution[]) => (d[0]!.probabilities[0]!.probability = 0.2),
      ],
      [
        'a sum above 1',
        (d: CorrectivePolicyDistribution[]) => (d[0]!.probabilities[0]!.probability = 0.31),
      ],
      [
        'a negative probability',
        (d: CorrectivePolicyDistribution[]) => {
          d[0]!.probabilities[0]!.probability = -0.1;
          d[0]!.probabilities[1]!.probability = 1.1;
        },
      ],
      [
        'a duplicated action',
        (d: CorrectivePolicyDistribution[]) => {
          d[0]!.probabilities[1]!.choice = { ...d[0]!.probabilities[0]!.choice };
        },
      ],
      [
        'a non-finite probability',
        (d: CorrectivePolicyDistribution[]) => (d[0]!.probabilities[0]!.probability = NaN),
      ],
      [
        'another information set',
        (d: CorrectivePolicyDistribution[]) => (d[0]!.informationSetDigest = 'f'.repeat(64)),
      ],
      [
        'another domain',
        (d: CorrectivePolicyDistribution[]) =>
          (d[0]!.domain = { variant: 'plo4', format: 'cash', mode: 'cash' }),
      ],
    ])('refuses %s as incomplete_policy_distribution', (_label, mutate) => {
      const input = catalogInput();
      const distributions = structuredClone(input.distributions) as CorrectivePolicyDistribution[];
      mutate(distributions);
      const catalog = buildCorrectiveCandidateCatalog({ ...input, distributions });
      expect(catalog.status).toBe('refused');
      expect(catalog.reasons).toContain('incomplete_policy_distribution');
      expect(catalog.entries).toEqual([]);
    });

    it('accepts a sum within the stated tolerance', () => {
      const input = catalogInput();
      const distributions = structuredClone(input.distributions) as CorrectivePolicyDistribution[];
      distributions[0]!.probabilities[0]!.probability = 0.3 + 5e-10;
      expect(buildCorrectiveCandidateCatalog({ ...input, distributions }).status).toBe('built');
    });
  });

  it('refuses mixed synthetic and reviewed evidence across reviews', () => {
    const input = catalogInput();
    const relabelled = structuredClone(input.reviews[1]!.review);
    relabelled.evidenceClass = 'reviewed_reference';
    const catalog = buildCorrectiveCandidateCatalog({
      ...input,
      reviews: [input.reviews[0]!, { handId: HAND, review: relabelled }],
    });
    expect(catalog.status).toBe('refused');
    expect(catalog.reasons).toContain('mixed_synthetic_and_reviewed_evidence');
    expect(catalog.evidenceClass).toBe('synthetic_fixture');
  });

  it('refuses mixed evidence between a review and its own candidate', () => {
    const input = catalogInput();
    const relabelled = structuredClone(input.reviews[0]!.review);
    relabelled.actors[0]!.decisions[0]!.candidate!.evidenceClass = 'reviewed_reference';
    const catalog = buildCorrectiveCandidateCatalog({
      ...input,
      reviews: [{ handId: HAND, review: relabelled }],
      distributions: [input.distributions[0]!],
    });
    expect(catalog.reasons).toContain('mixed_synthetic_and_reviewed_evidence');
  });

  it.each([
    ['activationAllowed true', (c: any) => (c.activationAllowed = true)],
    ['an active status', (c: any) => (c.status = 'active')],
    ['a larger probability move', (c: any) => (c.maximumProbabilityDelta = 0.5)],
    ['a target outside its menu', (c: any) => (c.to = { action: 'raise', amount: 9 })],
    ['a missing producer', (c: any) => delete c.producerDigest],
  ])('refuses a candidate with %s', (_label, mutate) => {
    const input = catalogInput();
    const tampered = structuredClone(input.reviews[0]!.review);
    mutate(tampered.actors[0]!.decisions[0]!.candidate);
    const catalog = buildCorrectiveCandidateCatalog({
      ...input,
      reviews: [{ handId: HAND, review: tampered }],
    });
    expect(catalog.status).toBe('refused');
    expect(catalog.reasons).toContain('candidate_invalid');
  });

  it('lists an incomplete review as excluded with its reason and keeps building', () => {
    const input = catalogInput();
    const incomplete = {
      ...structuredClone(input.reviews[1]!.review),
      status: 'incomplete' as const,
    };
    const catalog = buildCorrectiveCandidateCatalog({
      ...input,
      reviews: [input.reviews[0]!, { handId: HAND, review: incomplete }],
      distributions: [input.distributions[0]!],
    });
    expect(catalog.status).toBe('built');
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.excludedReviews).toEqual([
      { reviewId: incomplete.reviewId, reason: 'review_incomplete' },
    ]);
  });

  it('refuses a duplicated review and a duplicated candidate binding', () => {
    const input = catalogInput();
    const twice = buildCorrectiveCandidateCatalog({
      ...input,
      reviews: [input.reviews[0]!, input.reviews[0]!],
    });
    expect(twice.reasons).toContain('duplicate_selection_review');
    const copy = { ...structuredClone(input.reviews[0]!.review), reviewId: journalHash('copy') };
    const sameBinding = buildCorrectiveCandidateCatalog({
      ...input,
      reviews: [input.reviews[0]!, { handId: HAND, review: copy }],
    });
    expect(sameBinding.reasons).toContain('duplicate_candidate_binding');
  });

  it('carries no private cards or actor ids into the catalog', () => {
    const input = catalogInput();
    const json = JSON.stringify(buildCorrectiveCandidateCatalog(input));
    for (const secret of ['holeCards', 'spades', 'clubs', input.cash.f.hero.user_id])
      expect(json).not.toContain(secret);
  });
});
