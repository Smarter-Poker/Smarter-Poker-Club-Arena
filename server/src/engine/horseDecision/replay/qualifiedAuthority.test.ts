import { describe, expect, it } from 'vitest';
import type { HorseDecision } from '../../../types.js';
import {
  HorseQualifiedAuthorityHolder,
  repositoryEvidenceReader,
  type HorseAuthorityReceipt,
} from '../../HorseQualifiedAuthority.js';
import {
  admitHorsePhase10ReleaseAuthority,
  PHASE10_PROTECTED_RELEASE_SELECTION,
} from '../../HorsePhase10Authority.js';
import { PLO4_POLICY_PACK } from '../../plo4/Plo4PolicyPack.js';
import {
  qualifiedReplayAdmissions,
  qualifiedReplayAuthorityHolders,
} from './qualifiedAuthority.js';

const NOW = Date.parse('2026-10-12T15:03:57Z');
const EPOCH = '11111111-1111-4111-8111-111111111111';
function qualifiedReceipt() {
  // Real protected selection and its committed/shipped qualification bytes,
  // not a fake admitted record or a mode override.
  const admission = admitHorsePhase10ReleaseAuthority(NOW);
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
    const factory = qualifiedReplayAuthorityHolders(decision(receipt), 'plo4');
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
      const factory = qualifiedReplayAuthorityHolders(decision(wrong), 'plo4');
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
      const factory = qualifiedReplayAuthorityHolders(decision(wrong), 'plo4');
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
          admitHorsePhase10ReleaseAuthority(
            NOW,
            fault === 'withdrawn'
              ? {
                  ...PHASE10_PROTECTED_RELEASE_SELECTION!,
                  withdrawn: {
                    at: '2026-10-12T15:03:00.000Z',
                    reason: 'owner_withdrawal',
                  },
                }
              : PHASE10_PROTECTED_RELEASE_SELECTION,
            {
              read(path) {
                if (fault === 'missing')
                  throw Object.assign(new Error('absent'), { code: 'ENOENT' });
                const bytes = repositoryEvidenceReader.read(path);
                return fault === 'corrupt' ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
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
});
