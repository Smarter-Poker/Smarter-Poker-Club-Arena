import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, request, run } from './phase14Worker.test-support.js';
import { fastRandom } from '../HorseEval.js';
import { makeHorseJournalRecord, journalHash } from '../../services/horseDecisionJournal/record.js';
import { exactReplayHorseDecisionRecord } from './replay/exactReplay.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../HorseExecutionWitness.js';
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
afterEach(() => vi.restoreAllMocks());
describe('qualified Phase14 replay authority and versioned state', () => {
  it.each([false, true])(
    'exactly replays the bound accepted DEEP decision with original FAST selected=%s',
    async (selected) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const h = harness(selected);
      h.deps.correctiveDraw = fastRandom;
      const source = request(),
        fast = await run(h, source);
      const deepRequest = {
        ...source,
        type: 'DECIDE_DEEP' as const,
        requestId: 2,
        rngBefore: fast.rngBefore,
        deepEquity: 2,
      };
      h.runtime.receive(deepRequest);
      await h.runtime.drain();
      const deep = h.messages.find((message) => message.type === 'DEEP_RESULT');
      if (deep?.type !== 'DEEP_RESULT') throw Error('missing real DEEP result');
      expect(h.records).toHaveLength(2);
      const producerId = randomUUID(),
        sourceRelease = '5'.repeat(40),
        handKey = journalHash('actual-deep-replay');
      const metadata = (sequence: number, requestId: number) => ({
        producerId,
        sequence,
        atMs: now + sequence,
        sourceRelease,
        kind: 'decision' as const,
        handKey,
        turnKey: journalHash('deep-turn:' + requestId),
      });
      const originalFast = makeHorseJournalRecord(metadata(1, 1), h.records[0]);
      const originalDeep = makeHorseJournalRecord(metadata(2, 2), h.records[1]);
      const capture = JSON.parse(originalDeep.body);
      expect(capture).toMatchObject({
        effects: [],
        planBinding: null,
        replayState: { version: 'horse-decision-replay-state-v3' },
        originalFastBinding: {
          inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          readFrameDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      const witness = createHorseExecutionWitness(deepRequest, deep.decision, {
        requestId: 2,
        lane: 'deep',
        computeMs: deep.computeMs,
        governorScale: deep.governorScale,
      });
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: [
          {
            intended: true,
            record: {
              seat: source.player.seat,
              userId: source.player.user_id,
              action: deep.decision.action,
              amount: deep.decision.amount ?? 0,
              stage: 'river',
              timestamp: now,
            },
          },
        ],
      });
      const execution = makeHorseJournalRecord({ ...metadata(3, 2), kind: 'execution' }, witness);
      vi.spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment').mockImplementation((domain) =>
        selected && domain === 'nlh-cash'
          ? h.attachment
          : {
              admission: { status: 'refused', reason: 'unselected', transient: false },
              catalog: null,
            }
      );
      const verdict = await exactReplayHorseDecisionRecord(originalDeep, {
        runningSource: sourceRelease,
        execution,
        planReceipt: null,
        originalFastRecords: [originalFast],
      });
      expect(verdict, JSON.stringify(verdict)).toMatchObject({
        outcome: 'replayed_exact',
        replayVerified: true,
        acceptance: {
          status: 'joined',
          executionStatus: 'intended',
          selectedEqualsDecision: true,
          durableEffectReceipt: 'no_effects',
        },
      });
      expect(verdict.replayed?.rngAfter).toBe(verdict.original?.rngAfter);
      const missing = await exactReplayHorseDecisionRecord(originalDeep, {
        runningSource: sourceRelease,
        originalFastRecords: [],
      });
      expect(missing.outcome).toMatch(/original_fast_binding/);
      const duplicated = await exactReplayHorseDecisionRecord(originalDeep, {
        runningSource: sourceRelease,
        originalFastRecords: [originalFast, originalFast],
      });
      expect(duplicated.outcome).toMatch(/original_fast_binding/);
      delete capture.originalFastBinding;
      const legacy = makeHorseJournalRecord(metadata(2, 2), capture);
      expect(
        (
          await exactReplayHorseDecisionRecord(legacy, {
            runningSource: sourceRelease,
            originalFastRecords: [originalFast],
          })
        ).outcome
      ).toBe('non_replayable:retained_fast_read_view');
    }
  );
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
