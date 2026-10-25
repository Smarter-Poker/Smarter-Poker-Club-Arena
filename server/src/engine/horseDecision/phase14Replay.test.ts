import { describe, it, expect } from 'vitest';
import { kernelAdmissionFixture } from '../../services/horseCorrectiveReview/kernelAdmission.test-support.js';
import { admitCorrectiveKernelAttachment } from '../../services/horseCorrectiveReview/kernelAdmission.js';
import { now } from '../../services/horseCorrectiveReview/kernelApproval.test-support.js';
import { HorseQualifiedAuthorityHolder } from '../HorseQualifiedAuthority.js';
import { horsePhase14ContinuationVersion } from '../HorsePhase14Authority.js';
import { CORRECTIVE_KERNEL_CATALOG_VERSION } from '../../services/horseCorrectiveReview/kernelCatalog.js';
import {
  qualifiedReplayAdmissions,
  qualifiedReplayAuthorityHolders,
} from './replay/qualifiedAuthority.js';
import { horseDecisionReplayState, isHorseDecisionReplayState } from './replayState.js';
import type { HorseDecision } from '../../types.js';
describe('qualified Phase14 replay authority and versioned state', () => {
  it.each([true, false])(
    'restores the recorded epoch even for applied=%s, without taking authority from recorded flags',
    (applied) => {
      const f = kernelAdmissionFixture(),
        attachment = admitCorrectiveKernelAttachment(
          'nlh-cash',
          f.selection,
          f.reader,
          now,
          f.context
        ),
        version = horsePhase14ContinuationVersion('nlh-cash', CORRECTIVE_KERNEL_CATALOG_VERSION);
      expect(attachment.admission.status).toBe('admitted');
      const holder = new HorseQualifiedAuthorityHolder(
        '11111111-1111-4111-8111-111111111111',
        version
      );
      holder.apply(attachment.admission);
      const receipt = holder.receipt(),
        original = {
          action: 'call',
          amount: 50,
          thinkTime: 0,
          correctivePolicy: { domain: 'nlh-cash', applied, authority: receipt },
        } as HorseDecision;
      const admitted = { ...qualifiedReplayAdmissions, admitPhase14Attachment: () => attachment };
      const factory = qualifiedReplayAuthorityHolders(original, 'nlh', admitted),
        replay = factory('phase14', 'nlh-cash', version, 'must-not-substitute-epoch');
      expect(replay.receipt()).toEqual(receipt);
      const unselected = qualifiedReplayAuthorityHolders(original, 'nlh');
      expect(() => unselected('phase14', 'nlh-cash', version, 'another-epoch')).toThrow(
        /unselected/
      );
    }
  );
  it('retains v2 state readability while requiring complete corrective metadata for v3', () => {
    const admission = {
      phase8Postflop: 'shadow',
      phase10Plo4: 'shadow',
      phase11Omaha: 'shadow',
      phase12Remaining: 'shadow',
      phase13Joint: 'shadow',
    } as const;
    const state = horseDecisionReplayState(admission, null);
    expect(isHorseDecisionReplayState(state)).toBe(true);
    const legacy = { ...state, version: 'horse-decision-replay-state-v2' };
    delete legacy.corrective;
    expect(isHorseDecisionReplayState(legacy)).toBe(true);
    expect(
      isHorseDecisionReplayState({
        ...state,
        corrective: { mode: 'candidate', domain: 'nlh-cash', catalogDigest: null },
      })
    ).toBe(false);
    expect(
      isHorseDecisionReplayState({
        ...state,
        corrective: { mode: 'candidate', domain: 'nlh-cash', catalogDigest: 'a'.repeat(64) },
      })
    ).toBe(true);
    expect(isHorseDecisionReplayState({ ...state, corrective: undefined })).toBe(false);
  });
});
