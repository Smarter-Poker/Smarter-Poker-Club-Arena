import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  admitHorseQualifiedAuthority,
  admitHorsePhase8ReleaseAuthority,
  HorsePhase8AuthorityGate,
  HorseQualifiedAuthorityHolder,
  HORSE_PHASE8_EVIDENCE_DIRECTORY,
  PHASE8_PROTECTED_RELEASE_SELECTION,
  repositoryEvidenceReader,
} from './HorseQualifiedAuthority.js';
import { PHASE8_POLICY } from './HorseTournamentPostflop.js';
import {
  memoryReader,
  qualifiedTestAdmission,
  testQualificationEvidence,
  testSelection,
  TEST_EVIDENCE_PATH,
} from './HorseQualifiedAuthority.test-support.js';

const NOW = Date.parse('2026-10-01T01:00:00.000Z');

describe('protected-release authority admission', () => {
  const evidence = testQualificationEvidence();
  const reader = memoryReader({ [TEST_EVIDENCE_PATH]: evidence });

  it('admits an exact qualified selection as an immutable record bound to the continuation', () => {
    const admission = admitHorseQualifiedAuthority(testSelection(evidence), reader, NOW);
    expect(admission.status).toBe('admitted');
    if (admission.status !== 'admitted') return;
    const a = admission.authority;
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.continuationVersion).toBe('horse-tournament-postflop-round2-v1');
    expect(a.continuationVersion).toBe(PHASE8_POLICY.version);
    expect(a.evidenceSha256).toBe(createHash('sha256').update(evidence).digest('hex'));
    expect(a.authorityKey).toMatch(/^[0-9a-f]{64}$/);
    // Same inputs, same identity; a new approval generation is a new identity.
    const again = admitHorseQualifiedAuthority(testSelection(evidence), reader, NOW);
    const renewed = admitHorseQualifiedAuthority(
      testSelection(evidence, { approvalGeneration: 2 }),
      reader,
      NOW
    );
    expect(again.status === 'admitted' && again.authority.authorityKey).toBe(a.authorityKey);
    expect(renewed.status === 'admitted' && renewed.authority.authorityKey).not.toBe(
      a.authorityKey
    );
  });

  it.each([
    ['no selection', null, 'unselected', false],
    [
      'a path outside docs/evidence/phase8',
      testSelection(evidence, { evidencePath: 'docs/evidence/phase7/x.json' }),
      'invalid_selection',
      false,
    ],
    [
      'a traversing path',
      testSelection(evidence, { evidencePath: 'docs/evidence/phase8/../phase7/x.json' }),
      'invalid_selection',
      false,
    ],
    [
      'a malformed digest',
      testSelection(evidence, { evidenceSha256: 'abc' }),
      'invalid_selection',
      false,
    ],
    [
      'a non-positive approval generation',
      testSelection(evidence, { approvalGeneration: 0 }),
      'invalid_selection',
      false,
    ],
    [
      'a missing evidence file',
      testSelection(evidence, { evidencePath: 'docs/evidence/phase8/absent.json' }),
      'missing_evidence',
      false,
    ],
    [
      'a differently hashed file',
      testSelection(evidence, { evidenceSha256: 'f'.repeat(64) }),
      'hash_mismatch',
      false,
    ],
    [
      'another continuation version',
      testSelection(evidence, { continuationVersion: 'horse-tournament-postflop-round1-v3' }),
      'continuation_mismatch',
      false,
    ],
    [
      'another domain',
      testSelection(evidence, { domain: 'plo4-tournament' }),
      'continuation_mismatch',
      false,
    ],
    [
      'an expired selection',
      testSelection(evidence, { expiresAt: '2026-10-01T00:30:00.000Z' }),
      'expired',
      false,
    ],
  ] as const)('refuses %s', (_label, selection, reason, transient) => {
    expect(admitHorseQualifiedAuthority(selection, reader, NOW)).toEqual({
      status: 'refused',
      reason,
      transient,
    });
  });

  it.each([
    ['unqualified evidence', { qualified: false }, 'evidence_mismatch'],
    ['evidence from another source', { sourceSha: 'b'.repeat(40) }, 'evidence_mismatch'],
    ['evidence for another pack', { packId: 'other-pack' }, 'evidence_mismatch'],
    [
      'evidence for changed policy boundaries',
      { policyDigest: '0'.repeat(64) },
      'continuation_mismatch',
    ],
  ] as const)('refuses %s even when the declared hash matches', (_label, overrides, reason) => {
    const bytes = testQualificationEvidence(overrides);
    expect(
      admitHorseQualifiedAuthority(
        testSelection(bytes),
        memoryReader({ [TEST_EVIDENCE_PATH]: bytes }),
        NOW
      )
    ).toMatchObject({ status: 'refused', reason });
  });

  it('separates an unreadable file (transient) from a missing one', () => {
    const eio = Object.assign(new Error('EIO'), { code: 'EIO' });
    expect(
      admitHorseQualifiedAuthority(
        testSelection(evidence),
        memoryReader({ [TEST_EVIDENCE_PATH]: eio }),
        NOW
      )
    ).toEqual({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  });

  it('treats a withdrawal committed at release as an explicit withdrawal', () => {
    expect(
      admitHorseQualifiedAuthority(
        testSelection(evidence, {
          withdrawn: { at: '2026-10-01T00:10:00.000Z', reason: 'owner_withdrawal' },
        }),
        reader,
        NOW
      )
    ).toEqual({ status: 'withdrawn', approvalGeneration: 1, reason: 'release_owner_withdrawal' });
  });

  it('the committed release selection is shadow today, or admits from its committed file', () => {
    const selection = PHASE8_PROTECTED_RELEASE_SELECTION as Parameters<
      typeof admitHorseQualifiedAuthority
    >[0];
    if (selection === null) {
      // Activation stays off until P8.2 qualification is committed and selected.
      expect(admitHorsePhase8ReleaseAuthority(NOW)).toEqual({
        status: 'refused',
        reason: 'unselected',
        transient: false,
      });
      return;
    }
    expect(selection.evidencePath.startsWith(HORSE_PHASE8_EVIDENCE_DIRECTORY)).toBe(true);
    const bytes = readFileSync(new URL(`../../../${selection.evidencePath}`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(selection.evidenceSha256);
    expect(
      admitHorseQualifiedAuthority(selection, repositoryEvidenceReader, Date.now())
    ).toMatchObject({ status: selection.withdrawn ? 'withdrawn' : 'admitted' });
  });
});

describe('local authority states', () => {
  it('distinguishes refresh failure, restoration, withdrawal and renewed approval', () => {
    const holder = new HorseQualifiedAuthorityHolder('worker-a');
    expect(holder.currentState()).toBe('unselected');
    holder.apply(qualifiedTestAdmission(1));
    const first = holder.receipt();
    expect(first).toMatchObject({ state: 'usable', generation: 1, approvalGeneration: 1 });
    expect(holder.verdict(first, NOW)).toBe('usable');

    // An identical refresh changes nothing.
    holder.apply(qualifiedTestAdmission(1));
    expect(holder.verdict(first, NOW)).toBe('usable');

    // A transient refresh failure is unusable but not a withdrawal.
    holder.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
    expect(holder.currentState()).toBe('refresh_failed');
    expect(holder.verdict(first, NOW)).toBe('refresh_failed');

    // Restoration is not renewal: same approval, new generation, old work stale.
    holder.apply(qualifiedTestAdmission(1));
    expect(holder.receipt()).toMatchObject({ state: 'usable', reason: 'refresh_restored' });
    expect(holder.verdict(first, NOW)).toBe('stale_generation');

    // Explicit withdrawal is sticky against the same approval.
    holder.withdraw('safety_eligible_but_silent');
    expect(holder.verdict(holder.receipt(), NOW)).toBe('withdrawn');
    holder.apply(qualifiedTestAdmission(1));
    expect(holder.currentState()).toBe('withdrawn');
    holder.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
    expect(holder.currentState()).toBe('withdrawn');

    // Only a greater approval generation renews it.
    holder.apply(qualifiedTestAdmission(2));
    expect(holder.receipt()).toMatchObject({
      state: 'usable',
      reason: 'renewed',
      approvalGeneration: 2,
    });
    expect(holder.verdict(first, NOW)).toBe('stale_generation');
  });

  it('refuses a receipt from another process lifetime and an expired authority', () => {
    const before = new HorseQualifiedAuthorityHolder('process-1');
    before.apply(qualifiedTestAdmission(1));
    const after = new HorseQualifiedAuthorityHolder('process-2');
    after.apply(qualifiedTestAdmission(1));
    expect(after.verdict(before.receipt(), NOW)).toBe('restarted');

    const evidence = testQualificationEvidence();
    const expiring = new HorseQualifiedAuthorityHolder('process-3');
    expiring.apply(
      admitHorseQualifiedAuthority(
        testSelection(evidence, { expiresAt: '2026-10-01T02:00:00.000Z' }),
        memoryReader({ [TEST_EVIDENCE_PATH]: evidence }),
        NOW
      )
    );
    expect(expiring.verdict(expiring.receipt(), NOW)).toBe('usable');
    expect(expiring.verdict(expiring.receipt(), Date.parse('2026-10-01T02:00:00.000Z'))).toBe(
      'expired'
    );
  });

  it('a non-transient refusal of a usable authority removes it', () => {
    const holder = new HorseQualifiedAuthorityHolder('worker-b');
    holder.apply(qualifiedTestAdmission(1));
    holder.apply({ status: 'refused', reason: 'hash_mismatch', transient: false });
    expect(holder.receipt()).toMatchObject({
      state: 'refused',
      reason: 'hash_mismatch',
      authorityKey: null,
    });
  });
});

describe('main scheduler gate', () => {
  function pair(admission = qualifiedTestAdmission(1)) {
    let next = admission;
    const gate = new HorsePhase8AuthorityGate(() => next, 'main');
    gate.refresh();
    const worker = new HorseQualifiedAuthorityHolder('worker');
    worker.apply(admission);
    gate.observeWorker(worker.receipt());
    return {
      gate,
      worker,
      setAdmission: (a: typeof admission) => {
        next = a;
      },
      ledgerReceipt: () => gate.stamp(worker.receipt()),
    };
  }

  it('accepts only the exact worker generation and main generation that admitted the work', () => {
    const { gate, worker, ledgerReceipt } = pair();
    const receipt = ledgerReceipt();
    expect(gate.check(receipt, NOW)).toBe('usable');
    expect(gate.check(undefined, NOW)).toBe('missing_receipt');
    expect(gate.check({ ...receipt, epoch: 'other' }, NOW)).toBe('restarted');
    expect(gate.check({ ...receipt, state: 'unselected' }, NOW)).toBe('mismatched');
    expect(gate.check({ ...receipt, authorityKey: 'x' }, NOW)).toBe('mismatched');
    expect(gate.check({ ...receipt, continuationVersion: 'v3' }, NOW)).toBe('mismatched');
    // The worker moved on (a refresh failure and restoration): stale.
    worker.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
    worker.apply(qualifiedTestAdmission(1));
    gate.observeWorker(worker.receipt());
    expect(gate.check(receipt, NOW)).toBe('stale_generation');
  });

  it('mirrors a worker withdrawal so a replacement worker cannot re-promote it', () => {
    const { gate, worker, ledgerReceipt } = pair();
    const receipt = ledgerReceipt();
    worker.withdraw('safety_critical_commitment_increase');
    gate.observeWorker(worker.receipt());
    expect(gate.mainState()).toBe('withdrawn');
    expect(gate.check(receipt, NOW)).toBe('withdrawn');
    const replacement = new HorseQualifiedAuthorityHolder('worker-2');
    replacement.apply(qualifiedTestAdmission(1));
    gate.observeWorker(replacement.receipt());
    gate.refresh();
    expect(gate.check(gate.stamp(replacement.receipt()), NOW)).toBe('withdrawn');
  });

  it('a forgotten worker is restarted authority and an older receipt never overwrites a newer one', () => {
    const { gate, worker, ledgerReceipt } = pair();
    const receipt = ledgerReceipt();
    const older = worker.receipt();
    worker.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
    gate.observeWorker(worker.receipt());
    gate.observeWorker(older);
    expect(gate.check(receipt, NOW)).toBe('refresh_failed');
    gate.forgetWorker('worker');
    expect(gate.check(receipt, NOW)).toBe('restarted');
  });

  it('main refresh failure, restoration and withdrawal retire already returned work', () => {
    const { gate, setAdmission, ledgerReceipt } = pair();
    const receipt = ledgerReceipt();
    setAdmission({ status: 'refused', reason: 'unreadable_evidence', transient: true });
    gate.refresh();
    expect(gate.check(receipt, NOW)).toBe('refresh_failed');
    setAdmission(qualifiedTestAdmission(1));
    gate.refresh();
    expect(gate.check(receipt, NOW)).toBe('stale_generation');
    expect(gate.check(ledgerReceipt(), NOW)).toBe('usable');
    gate.withdraw('controller_fallback_candidate');
    expect(gate.check(ledgerReceipt(), NOW)).toBe('withdrawn');
  });

  it('an unselected process never has usable authority', () => {
    const gate = new HorsePhase8AuthorityGate(
      () => ({ status: 'refused', reason: 'unselected', transient: false }),
      'main'
    );
    gate.refresh();
    const worker = new HorseQualifiedAuthorityHolder('worker');
    worker.apply(qualifiedTestAdmission(1));
    gate.observeWorker(worker.receipt());
    expect(gate.check(gate.stamp(worker.receipt()), NOW)).toBe('unselected');
  });
});
