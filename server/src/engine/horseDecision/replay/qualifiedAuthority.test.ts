import { describe, expect, it } from 'vitest';
import type { HorseDecision } from '../../../types.js';
import {
  HorseQualifiedAuthorityHolder,
  type HorseAuthorityReceipt,
} from '../../HorseQualifiedAuthority.js';
import { admitHorsePhase10ReleaseAuthority } from '../../HorsePhase10Authority.js';
import {
  p10QualificationBytes,
  p10Reader,
  p10Selection,
  P10_TEST_CONTRACT_DIGEST,
  P10_TEST_NOW,
  P10_TEST_QUALIFICATION_PATH,
} from '../../HorsePhase10Authority.test-support.js';
import { PLO4_POLICY_PACK } from '../../plo4/Plo4PolicyPack.js';
import {
  qualifiedReplayAdmissions,
  qualifiedReplayAuthorityHolders,
} from './qualifiedAuthority.js';

// The committed Phase 10 selection is null while the opponent-read repair
// awaits requalification, so the qualified path is proved with the in-memory
// test qualification (exact assembler shape, running contract and policy
// digests) through the same admission function production uses.
const NOW = P10_TEST_NOW;
const SELECTION = p10Selection();
const admitQualified = (
  selection = SELECTION,
  reader: { read(path: string): Buffer } = p10Reader()
) => admitHorsePhase10ReleaseAuthority(NOW, selection, reader, P10_TEST_CONTRACT_DIGEST);
const testAdmissions = {
  ...qualifiedReplayAdmissions,
  admitPhase10Authority: () => admitQualified(),
};
const EPOCH = '11111111-1111-4111-8111-111111111111';
function qualifiedReceipt() {
  // Real protected selection and its committed/shipped qualification bytes,
  // not a fake admitted record or a mode override.
  const admission = admitQualified();
  expect(admission.status).toBe('admitted');
  const holder = new HorseQualifiedAuthorityHolder(EPOCH, PLO4_POLICY_PACK.version);
  holder.apply(admission);
  holder.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  holder.apply(admission);
  expect(holder.receipt()).toMatchObject({
    state: 'usable',
    generation: 3,
    reason: 'refresh_restored',
  });
  return { admission, receipt: holder.receipt() };
}
const decision = (receipt?: HorseAuthorityReceipt) =>
  ({
    action: 'raise',
    amount: 4,
    thinkTime: 0,
    plo4Policy: { applied: true, authority: receipt },
  }) as unknown as HorseDecision;

describe('qualified replay restores recorded holder identity without granting authority', () => {
  it('preserves a real refreshed epoch/generation; duplicate admission and stale receipts retain the live laws', () => {
    const { admission, receipt } = qualifiedReceipt();
    const factory = qualifiedReplayAuthorityHolders(decision(receipt), 'plo4', testAdmissions);
    const replay = factory(
      'phase10',
      null,
      PLO4_POLICY_PACK.version,
      '22222222-2222-4222-8222-222222222222'
    );
    expect(replay.receipt()).toEqual(receipt);
    replay.apply(admission);
    expect(replay.receipt()).toEqual(receipt);
    expect(replay.verdict({ ...receipt, generation: 1 }, NOW)).toBe('stale_generation');
    expect(replay.verdict({ ...receipt, epoch: 'other-worker' }, NOW)).toBe('restarted');
    replay.withdraw('local_safety');
    expect(replay.verdict(receipt, NOW)).toBe('withdrawn');
    replay.apply(admission);
    expect(replay.currentState()).toBe('withdrawn');
  });

  it.each([
    'authorityKey',
    'evidenceSha256',
    'sourceSha',
    'continuationVersion',
    'approvalGeneration',
  ] as const)(
    'refuses a recorded %s that differs from the independently qualified release',
    (key) => {
      const { receipt } = qualifiedReceipt();
      const wrong = { ...receipt, [key]: key === 'approvalGeneration' ? 99 : 'wrong' };
      const factory = qualifiedReplayAuthorityHolders(decision(wrong), 'plo4', testAdmissions);
      expect(() => factory('phase10', null, PLO4_POLICY_PACK.version, EPOCH)).toThrow(
        `phase10:identity_${key}`
      );
    }
  );

  it('requires the applied owner receipt and refuses withdrawn or invalid holder input by name', () => {
    const { receipt } = qualifiedReceipt();
    expect(() => qualifiedReplayAuthorityHolders(decision(), 'plo4')).toThrow(
      'phase10:missing_receipt'
    );
    expect(() =>
      qualifiedReplayAuthorityHolders(decision({ ...receipt, state: 'withdrawn' }), 'plo4')
    ).toThrow('phase10:withdrawn');
    for (const wrong of [
      { ...receipt, generation: 0 },
      { ...receipt, epoch: 'missing-original-epoch' },
      { ...receipt, mainGeneration: 1 },
    ]) {
      const factory = qualifiedReplayAuthorityHolders(decision(wrong), 'plo4', testAdmissions);
      expect(() => factory('phase10', null, PLO4_POLICY_PACK.version, EPOCH)).toThrow(
        'invalid_recorded_authority'
      );
    }
  });

  it.each(['missing', 'corrupt', 'withdrawn'] as const)(
    'ordinary qualification still refuses %s evidence/selection, despite a usable recorded receipt',
    (fault) => {
      const { receipt } = qualifiedReceipt();
      const admissions = {
        ...qualifiedReplayAdmissions,
        admitPhase10Authority: () =>
          admitQualified(
            fault === 'withdrawn'
              ? {
                  ...SELECTION,
                  withdrawn: {
                    at: '2026-10-10T00:30:00.000Z',
                    reason: 'owner_withdrawal',
                  },
                }
              : SELECTION,
            {
              read(path: string) {
                if (fault === 'missing')
                  throw Object.assign(new Error('absent'), { code: 'ENOENT' });
                const bytes = p10Reader().read(path);
                return fault === 'corrupt' && path === P10_TEST_QUALIFICATION_PATH
                  ? Buffer.concat([p10QualificationBytes(), Buffer.from('\n')])
                  : bytes;
              },
            }
          ),
      };
      const factory = qualifiedReplayAuthorityHolders(decision(receipt), 'plo4', admissions);
      expect(() => factory('phase10', null, PLO4_POLICY_PACK.version, EPOCH)).toThrow(
        fault === 'missing'
          ? 'phase10:missing_evidence'
          : fault === 'corrupt'
            ? 'phase10:hash_mismatch'
            : 'phase10:withdrawn'
      );
    }
  );
  it('restores a selected baseline holder recorded by a corrective composition even when its own candidate did not apply', () => {
    const { receipt } = qualifiedReceipt();
    const original = {
      action: 'fold',
      thinkTime: 0,
      correctivePolicy: {
        domain: 'plo4-cash',
        authority: receipt,
        baselineAuthorities: { phase10: receipt },
      },
    } as unknown as HorseDecision;
    const factory = qualifiedReplayAuthorityHolders(original, 'plo4', testAdmissions);
    expect(
      factory('phase10', null, PLO4_POLICY_PACK.version, 'different-worker').receipt()
    ).toEqual(receipt);
    const conflicting = {
      ...original,
      plo4Policy: { applied: true, authority: { ...receipt, generation: receipt.generation + 1 } },
    } as unknown as HorseDecision;
    expect(() => qualifiedReplayAuthorityHolders(conflicting, 'plo4', testAdmissions)).toThrow(
      /conflicting_baseline_receipt/
    );
  });
});
