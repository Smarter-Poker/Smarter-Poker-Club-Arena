import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { harness, request, run } from './phase14Worker.test-support.js';
import { fastRandom } from '../HorseEval.js';
import { makeHorseJournalRecord, journalHash } from '../../services/horseDecisionJournal/record.js';
import { exactReplayHorseDecisionRecord } from './replay/exactReplay.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  retireHorseExecutionWitness,
} from '../HorseExecutionWitness.js';
import { buildHorseDecisionKey } from './protocol.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { reconcileHorseJournalHand } from '../../services/horseDecisionJournal/review.js';
import { readHorseJournalFleet } from '../../services/horseDecisionJournal/fleet.js';
import { HorseDecisionJournalStore } from '../../services/horseDecisionJournal/store.js';
import { runtimeHorseJournalArchiveOptions } from '../../services/horseDecisionJournal/config.js';
import type { HorseJournalRecord } from '../../services/horseDecisionJournal/record.js';
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
  it('counts the actual serialized accepted DEEP producer capture once through SQLite fleet phase proof after FAST retirement', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const table = '10000000-0000-4000-8000-000000000001',
      hand = randomUUID();
    const horseIds = Array.from(
      { length: 1000 },
      (_, i) => `20000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`
    );
    const source = request();
    const id = (value: string) =>
      value === 'hero' ? horseIds[0]! : value === 'opponent' ? horseIds[1]! : value;
    source.player = { ...source.player, user_id: id(source.player.user_id) };
    source.gameState = {
      ...source.gameState,
      players: source.gameState.players.map((p) => ({ ...p, user_id: id(p.user_id) })),
      pots: source.gameState.pots?.map((pot) => ({
        ...pot,
        eligiblePlayers: pot.eligiblePlayers.map(id),
      })),
    };
    source.fence = `${table}:12:1:9:${source.generation}`;
    const priorActions = source.gameState.actionHistory;
    if (!priorActions) throw Error('actual worker fixture requires its original action history');
    source.handJournalContext = captureHorseHandJournalContext(priorActions);
    source.decisionKey = buildHorseDecisionKey(source);
    const producerId = randomUUID(),
      sourceRelease = '5'.repeat(40),
      handKey = journalHash(`${table}:12:9`);
    const rows: HorseJournalRecord[] = [];
    const turn = (r: {
      generation: number;
      fence: string;
      requestId: number;
      decisionKey: string;
      decisionTimeMs: number;
    }) =>
      journalHash(
        JSON.stringify([r.generation, r.fence, r.requestId, r.decisionKey, r.decisionTimeMs])
      );
    const append = (kind: HorseJournalRecord['kind'], body: unknown, turnKey: string) =>
      rows.push(
        makeHorseJournalRecord(
          {
            producerId,
            sequence: rows.length + 1,
            atMs: now,
            sourceRelease,
            kind,
            handKey,
            turnKey,
          },
          body
        )
      );
    const h = harness(false),
      journalDecision = h.deps.journalDecision;
    h.deps.journalLifecycle = (snapshot, payload) => {
      if (snapshot.type === 'DECIDE_DISCARD') throw Error('unexpected discard in FAST/DEEP test');
      append('request_lifecycle', payload, turn(snapshot));
    };
    h.deps.journalDecision = (snapshot, payload) => {
      journalDecision?.(snapshot, payload);
      append('decision', payload, turn(snapshot));
    };
    const fast = await run(h, source);
    const fastWitness = createHorseExecutionWitness(source, fast.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: fast.computeMs,
      governorScale: fast.governorScale,
    });
    retireHorseExecutionWitness(fastWitness, 'second_look_replaced');
    append('execution', fastWitness, turn(source));
    const deepRequest = {
      ...source,
      type: 'DECIDE_DEEP' as const,
      requestId: 2,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    };
    h.runtime.receive(deepRequest);
    await h.runtime.drain();
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    if (deep?.type !== 'DEEP_RESULT') throw Error('actual DEEP producer did not return');
    const witness = createHorseExecutionWitness(deepRequest, deep.decision, {
      requestId: 2,
      lane: 'deep',
      computeMs: deep.computeMs,
      governorScale: deep.governorScale,
    });
    const acceptedAction = {
      seat: source.player.seat,
      userId: source.player.user_id,
      action: deep.decision.action,
      amount: deep.decision.amount ?? 0,
      stage: 'river' as const,
      timestamp: now,
    };
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [{ record: acceptedAction, intended: true }],
    });
    append('execution', witness, turn(deepRequest));
    const ordinal = priorActions.length;
    append(
      'accepted_hand',
      {
        type: 'OBSERVE_COMPLETED_HAND',
        requestId: 3,
        generation: 12,
        fence: `${table}:12:9:observe`,
        handKey: `${table}:12`,
        committedHandId: hand,
        bigBlind: source.gameState.bigBlind,
        actions: [
          ...priorActions,
          {
            ...acceptedAction,
            origin: 'horse_policy',
            publicNode: {
              version: 1,
              status: 'captured',
              actorSeat: source.player.seat,
              street: 'river',
            },
            observationIdentity: {
              version: 1,
              status: 'bound',
              handId: hand,
              actionOrdinal: ordinal,
              observationId: `${hand}:${ordinal}`,
              sessionKey: 'a'.repeat(64),
            },
          },
        ],
      },
      handKey
    );
    // These are the actual production callback bytes, serialized before any
    // consumer reads them. No original binding, replay flags or effects added.
    const deepRecord = rows.find(
      (r) => r.kind === 'decision' && JSON.parse(r.body).snapshot.type === 'DECIDE_DEEP'
    )!;
    const serializedDeep = JSON.parse(deepRecord.body);
    expect(serializedDeep.originalFastBinding).toEqual(
      JSON.parse(JSON.stringify(h.records[1])).originalFastBinding
    );
    const reconciliation = reconcileHorseJournalHand(rows, handKey);
    expect(reconciliation, JSON.stringify(reconciliation)).toMatchObject({
      status: 'reconciled',
      matchedActions: 1,
      retiredDecisions: 1,
      requestLifecycleVerified: true,
    });
    // os.tmpdir honors the task's TMPDIR instead of assuming worktree depth.
    const temporaryRoot = resolve(tmpdir());
    if (
      process.platform === 'darwin' &&
      !temporaryRoot.startsWith('/Volumes/SmarterWork/agent-work/')
    )
      throw new Error('Phase14 fleet test requires a task-owned external SSD TMPDIR on macOS');
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, 'phase14-native-fleet-'));
    try {
      const store = new HorseDecisionJournalStore(directory, {
        archive: runtimeHorseJournalArchiveOptions(directory, {}, { index: 0 }),
      });
      try {
        store.appendBatch(rows);
      } finally {
        store.close();
      }
      const result = readHorseJournalFleet(directory, {
        version: 1,
        sourceSha: sourceRelease,
        window: {
          startUtc: new Date(now - 1000).toISOString(),
          endUtc: new Date(now + 1000).toISOString(),
        },
        horseIds,
        handKeys: [handKey],
      });
      expect(result.gaps).toEqual({});
      expect(result).toMatchObject({
        acceptedDecisions: 1,
        observedHorses: 1,
        unobservedHorses: 999,
        reconciledHands: 1,
        allPhasesVerified: false,
        completePopulation: false,
      });
      expect(result.horses.find((horse) => horse.horseId === horseIds[0])?.acceptedDecisions).toBe(
        1
      );
      expect(result.phaseEvidence.phase3).toMatchObject({
        application: { accepted: 1 },
        reasons: { original_accepted_hand_reconciled: 1 },
      });
      expect(result.phaseEvidence.phase5).toMatchObject({
        application: { accepted: 1 },
        reasons: { controller_accepted_action_bound: 1 },
      });
      for (const proof of Object.values(result.phaseEvidence))
        for (const reason of Object.keys(proof.reasons))
          expect(reason).not.toMatch(/^deep_(original_metadata|record_envelope|original_binding)/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
      // The default release admits the owner order's authority (Dan
      // 2026-10-26), never the recorded one: refused by identity.
      const unselected = qualifiedReplayAuthorityHolders(original, 'nlh');
      expect(() => unselected('phase14', 'nlh-cash', version, 'another-epoch')).toThrow(
        /identity_authorityKey/
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
