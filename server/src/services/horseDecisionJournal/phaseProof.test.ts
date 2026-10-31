import { admitHorsePhase13LiveAuthority } from '../../engine/HorsePhase13Authority.js';
import {
  HORSE_OWNER_FORCED_EVIDENCE_PATH,
  HORSE_OWNER_FORCED_EVIDENCE_SHA256,
} from '../../engine/HorseOwnerForcedActivation.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HorseFleetPhaseInterpreter,
  HORSE_PHASE_KEYS,
  type HorsePhaseCapture,
} from './phaseProof.js';
import { decisionRequest } from '../../testing/horseRegression/plan/fixture.js';
import { HorseMind } from '../../engine/HorseMind.js';
import { horsePlanHandKey } from '../../engine/HorseDecisionEffects.js';
import {
  horsePlanContextFromDecision,
  horsePlanBatchBindingFromRequest,
} from '../../engine/HorsePlanHandIdentity.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../../engine/HorseExecutionWitness.js';
import { qualifiedReplayAdmissions } from '../../engine/horseDecision/replay/qualifiedAuthority.js';
import { qualifiedTestAdmission } from '../../engine/HorseQualifiedAuthority.test-support.js';
import { HorseQualifiedAuthorityHolder } from '../../engine/HorseQualifiedAuthority.js';
import { PHASE8_POLICY } from '../../engine/HorseTournamentPostflop.js';
import type { HorsePlanEffectsReview } from './review.js';
import type { HorseDecision } from '../../types.js';
import { harness, request, run } from '../../engine/horseDecision/phase14Worker.test-support.js';
import { now } from '../horseCorrectiveReview/kernelApproval.test-support.js';
import { journalHash, horseJournalJson } from './record.js';
import { HorseLogic } from '../../engine/HorseLogic.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import { seedFastRandom, saveFastRandom, restoreFastRandom } from '../../engine/HorseEval.js';
import { PHASE11_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase11Authority.js';
import { PHASE12_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase12Authority.js';
import { PHASE13_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase13Authority.js';
import { CORRECTIVE_DOMAIN_KEYS } from '../horseCorrectiveReview/domain.js';
const envelope = (sequence: number) => ({
  producerId: '10000000-0000-4000-8000-000000000001',
  sourceRelease: 'a'.repeat(40),
  handKey: 'b'.repeat(64),
  sequence,
});
const originalRecord = (capture: HorsePhaseCapture, sequence = 1) => ({
  ...capture,
  recordEnvelope: envelope(sequence),
});
const pinsOf = (capture: HorsePhaseCapture) => ({
  inputDigest: journalHash(horseJournalJson(capture.snapshot)),
  readFrameDigest: journalHash(horseJournalJson(capture.readFrame)),
});
const plans: HorsePlanEffectsReview = {
  version: 1,
  scope: 'single_retained_hand',
  acceptedHandRetained: true,
  issued: 0,
  accepted: 0,
  durable: 0,
  applied: 0,
  failed: 0,
  unknown: 0,
  gaps: [],
  applicationVerified: false,
  replayVerified: false,
  completePopulation: false,
  activationAllowed: false,
};
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
function fixture(mode: 'shadow' | 'candidate' = 'candidate') {
  const snapshot = decisionRequest();
  snapshot.gameState.gameMode = 'tournament';
  snapshot.gameState.stage = 'flop';
  const admission = qualifiedTestAdmission();
  const holder = new HorseQualifiedAuthorityHolder('10000000-0000-4000-8000-000000000001');
  holder.apply(admission);
  const authority = holder.receipt();
  const decision = {
    action: 'bet',
    amount: 20,
    thinkTime: 50,
    tournamentPostflop: {
      version: PHASE8_POLICY.version,
      mode,
      eligible: true,
      fired: true,
      completed: true,
      changed: true,
      applied: mode === 'candidate',
      selection: mode === 'candidate' ? 'selected' : 'shadow_change',
      authority: mode === 'candidate' ? authority : null,
      authorityVerdict: null,
      candidateAction: 'bet',
      candidateAmount: 20,
      baselineAction: 'fold',
      baselineAmount: null,
    },
  } as unknown as HorseDecision;
  const capture: HorsePhaseCapture = {
    snapshot,
    decision,
    effects: [],
    readFrame: encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      snapshot.gameState.players,
      null
    ),
    replayState: { admission: { phase8Postflop: mode } },
  };
  const witness = createHorseExecutionWitness(snapshot, decision, {
    requestId: snapshot.requestId,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  if (mode === 'candidate') witness.phase8Authority!.verdict = 'usable';
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [
      {
        intended: true,
        record: {
          seat: snapshot.player.seat,
          action: 'bet',
          amount: 20,
          stage: 'flop',
          userId: snapshot.player.user_id,
        },
      },
    ],
  });
  return { capture, witness, admission };
}
describe('private phase interpretation requires source-qualified accepted evidence', () => {
  it('does not substitute qualified continuation evidence for a missing captured guard receipt', () => {
    const f = fixture();
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue(f.admission);
    f.capture.replayState = {
      admission: { phase8Postflop: 'candidate', phase8CatastropheGuard: 'candidate' },
    };
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8
    ).toMatchObject({ status: 'unknown', reason: 'owner_receipt_missing' });
  });

  it.each(['cash', 'omaha_tournament', 'multiple_boards'] as const)(
    'keeps a captured guard admission outside its actual static domain: %s',
    (domain) => {
      const f = fixture();
      delete f.capture.decision.tournamentPostflop;
      delete (f.witness as { phase8Authority?: unknown }).phase8Authority;
      f.capture.replayState = { admission: { phase8CatastropheGuard: 'candidate' } };
      if (domain === 'cash') f.capture.snapshot.gameState.gameMode = 'cash';
      else if (domain === 'omaha_tournament') f.capture.snapshot.gameState.gameVariant = 'plo4';
      else f.capture.snapshot.gameState.boardCount = 2;
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8
      ).toMatchObject({ status: 'outside-domain', application: 'not-applicable' });
    }
  );

  it.each([0, 0.99])(
    'joins actual corrective worker capture and accepted witness without confusing sampled application draw=%s',
    async (draw) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const h = harness(true, draw),
        r = request();
      const result = await run(h, r);
      const capture = h.records[0] as HorsePhaseCapture;
      expect(capture.decision.correctivePolicy).toBeDefined();
      const w = createHorseExecutionWitness(r, result.decision, {
        requestId: r.requestId,
        lane: 'fast',
        computeMs: result.computeMs,
        governorScale: result.governorScale,
      });
      w.phase14Authority!.verdict = 'usable';
      settleHorseExecutionWitness(w, {
        applied: true,
        acceptedActions: [
          {
            intended: true,
            record: {
              seat: r.player.seat,
              userId: r.player.user_id,
              action: result.decision.action,
              amount: result.decision.action === 'fold' ? 0 : result.decision.amount!,
              stage: 'river',
            },
          },
        ],
      });
      vi.spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment').mockReturnValue(h.attachment);
      const proof = new HorseFleetPhaseInterpreter(() => {}).interpret(capture, w, plans);
      expect(proof.phase14).toMatchObject({
        status: 'applicable-active',
        qualification: 'verified',
        application: draw === 0 ? 'accepted' : 'not-selected',
      });
      // Inner-frame SHA is NOT the corrective commitment to the whole portable frame.
      const wrong = structuredClone(w);
      (wrong.phase14Inputs as any).readFrameDigest = capture.readFrame.sha256;
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(capture, wrong, plans).phase14!.status
      ).toBe('refused');
      const foreign = structuredClone(capture);
      foreign.snapshot.decisionTimeMs++;
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(foreign, w, plans).phase14!.status
      ).toBe('refused');
      const sampling = structuredClone(w);
      (sampling.phase14Inputs as any).samplingContractDigest = 'f'.repeat(64);
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(capture, sampling, plans).phase14!.status
      ).toBe('refused');
    }
  );

  it('does not call a signed corrective composition independently qualified when its retained baseline is forced', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness(true, 0),
      r = request(),
      result = await run(h, r);
    const capture = structuredClone(h.records[0]) as HorsePhaseCapture;
    const w = createHorseExecutionWitness(r, result.decision, {
      requestId: r.requestId,
      lane: 'fast',
      computeMs: result.computeMs,
      governorScale: result.governorScale,
    });
    w.phase14Authority!.verdict = 'usable';
    settleHorseExecutionWitness(w, {
      applied: true,
      acceptedActions: [
        {
          intended: true,
          record: {
            seat: r.player.seat,
            userId: r.player.user_id,
            action: result.decision.action,
            amount: result.decision.action === 'fold' ? 0 : result.decision.amount!,
            stage: 'river',
          },
        },
      ],
    });
    // Explicit consumer input: a signed corrective owner composed with the
    // actual running NLH cash baseline's forced authority, not a P8 cash claim.
    const baseline = admitHorsePhase13LiveAuthority('nlh', now);
    if (baseline.status !== 'admitted') throw Error('baseline fixture');
    const holder = new HorseQualifiedAuthorityHolder('10000000-0000-4000-8000-000000000001');
    holder.apply(baseline);
    const receipt = holder.receipt();
    expect(receipt.evidenceSha256).toBe(HORSE_OWNER_FORCED_EVIDENCE_SHA256);
    capture.decision.correctivePolicy!.baselineAuthorities = { phase13: receipt };
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment').mockReturnValue(h.attachment);
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase13Authority').mockReturnValue(baseline);
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(capture, w, plans).phase14
    ).toMatchObject({
      status: 'applicable-active',
      application: 'accepted',
      qualification: 'owner-forced',
      reason: 'owner_forced_not_independently_qualified',
    });
  });
  it('requires request-owned DEEP admission and one exact retained FAST input, without borrowing globals', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness(),
      source = request(),
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
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    if (deep?.type !== 'DEEP_RESULT') throw Error('missing actual deep result');
    const original = h.records[0] as HorsePhaseCapture,
      capture = h.records[1] as HorsePhaseCapture;
    const w = createHorseExecutionWitness(deepRequest, deep.decision, {
      requestId: 2,
      lane: 'deep',
      computeMs: deep.computeMs,
      governorScale: deep.governorScale,
    });
    w.phase14Authority!.verdict = 'usable';
    settleHorseExecutionWitness(w, {
      applied: true,
      acceptedActions: [
        {
          intended: true,
          record: {
            seat: source.player.seat,
            userId: source.player.user_id,
            action: deep.decision.action,
            amount: deep.decision.action === 'fold' ? 0 : deep.decision.amount!,
            stage: 'river',
          },
        },
      ],
    });
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment').mockReturnValue(h.attachment);
    const missing = structuredClone(capture);
    delete missing.replayState;
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(missing, w, plans, [original]).phase14!
        .status
    ).toBe('unknown');
    // Forward metadata fixture only: the real retained DEEP capture above has
    // no replayState in 9f51. Missing metadata never gets this substitution live.
    const complete = {
      ...capture,
      effects: [],
      replayState: structuredClone(original.replayState),
      originalFastBinding: pinsOf(original),
    };
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(
        complete,
        w,
        plans,
        [originalRecord(original)],
        envelope(20)
      ).phase14!.application
    ).toBe('accepted');
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(complete, w, plans, [], envelope(20))
        .phase14!.status
    ).toBe('refused');
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(
        complete,
        w,
        plans,
        [originalRecord(original), originalRecord(original, 2)],
        envelope(20)
      ).phase14!.status
    ).toBe('refused');
    for (const field of ['producerId', 'sourceRelease', 'handKey', 'sequence'] as const) {
      const prior = originalRecord(original);
      (prior.recordEnvelope as any)[field] =
        field === 'sequence'
          ? 21
          : field === 'sourceRelease'
            ? 'c'.repeat(40)
            : field === 'handKey'
              ? 'c'.repeat(64)
              : '20000000-0000-4000-8000-000000000001';
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(
          complete,
          w,
          plans,
          [prior],
          envelope(20)
        ).phase14!.reason
      ).toBe('deep_original_binding_mismatch');
    }
    for (const field of ['decisionKey', 'rngBefore'] as const) {
      const prior = structuredClone(originalRecord(original));
      if (field === 'decisionKey') prior.snapshot.decisionKey = 'phase5-v1:' + 'f'.repeat(64);
      else prior.rngBefore = (prior.rngBefore ?? 0) + 1;
      // A matching pin is not enough: request identity and sampling lineage must agree too.
      const changed = { ...complete, originalFastBinding: pinsOf(prior) };
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(changed, w, plans, [prior], envelope(20))
          .phase14!.reason
      ).toBe('deep_original_binding_mismatch');
    }
    const foreign = structuredClone(original);
    foreign.snapshot.fence += ':foreign';
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(
        complete,
        w,
        plans,
        [originalRecord(foreign)],
        envelope(20)
      ).phase14!.status
    ).toBe('refused');
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(missing, w, plans).phase15!.application
    ).toBe('unknown');
  });
  it.each([undefined, { inputDigest: 'f'.repeat(64), readFrameDigest: 'f'.repeat(64) }])(
    'does not activate DEEP without its explicit valid original binding %s',
    async (originalFastBinding) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const h = harness(),
        source = request(),
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
      const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
      if (deep?.type !== 'DEEP_RESULT') throw Error('missing actual deep result');
      const original = h.records[0] as HorsePhaseCapture;
      const complete = {
        ...(h.records[1] as HorsePhaseCapture),
        effects: [],
        replayState: original.replayState,
        originalFastBinding,
      };
      const w = createHorseExecutionWitness(deepRequest, deep.decision, {
        requestId: 2,
        lane: 'deep',
        computeMs: deep.computeMs,
        governorScale: deep.governorScale,
      });
      w.phase14Authority!.verdict = 'usable';
      settleHorseExecutionWitness(w, {
        applied: true,
        acceptedActions: [
          {
            intended: true,
            record: {
              seat: source.player.seat,
              userId: source.player.user_id,
              action: deep.decision.action,
              amount: deep.decision.action === 'fold' ? 0 : deep.decision.amount!,
              stage: 'river',
            },
          },
        ],
      });
      vi.spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment').mockReturnValue(h.attachment);
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(
          complete,
          w,
          plans,
          [originalRecord(original)],
          envelope(20)
        ).phase14!.status
      ).toBe(originalFastBinding ? 'refused' : 'unknown');
    }
  );
  it('keeps owner-forced accepted use active without claiming independent qualification', () => {
    const f = structuredClone(fixture());
    if (f.admission.status !== 'admitted') throw Error('fixture admission');
    const evidence = {
      evidencePath: HORSE_OWNER_FORCED_EVIDENCE_PATH,
      evidenceSha256: HORSE_OWNER_FORCED_EVIDENCE_SHA256,
    };
    Object.assign(f.admission.authority, evidence);
    Object.assign(f.capture.decision.tournamentPostflop!.authority!, evidence);
    Object.assign(f.witness.phase8Authority!.authority!, evidence);
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue(f.admission);
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8
    ).toMatchObject({
      status: 'applicable-active',
      eligibility: 'eligible',
      application: 'accepted',
      qualification: 'owner-forced',
      reason: 'owner_forced_not_independently_qualified',
    });
  });
  it('verifies an optional owner through the maintained admission and original epoch restorer', () => {
    const f = fixture();
    const admit = vi
      .spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority')
      .mockReturnValue(f.admission);
    const interpreter = new HorseFleetPhaseInterpreter(() => {});
    const proof = interpreter.interpret(f.capture, f.witness, plans);
    expect(proof.phase8).toMatchObject({
      status: 'applicable-active',
      qualification: 'verified',
      application: 'accepted',
    });
    expect(admit).toHaveBeenCalledOnce();
    interpreter.interpret(f.capture, f.witness, plans);
    expect(admit).toHaveBeenCalledOnce(); // one bounded read's qualification cache
    for (const phase of ['phase1', 'phase2', 'phase4', 'phase9', 'phase15'])
      expect(proof[phase]!.qualification).toBe('unknown');
    expect(Object.keys(proof)).toEqual(HORSE_PHASE_KEYS);
  });
  it('never treats receipt presence, shadow or a self-asserted usable authority as qualification', () => {
    const shadow = fixture('shadow');
    const admit = vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority');
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(shadow.capture, shadow.witness, plans)
        .phase8
    ).toMatchObject({ status: 'shadow', application: 'shadow', qualification: 'unknown' });
    expect(admit).not.toHaveBeenCalled();
    const f = fixture();
    admit.mockReturnValue({ status: 'refused', reason: 'unselected', transient: false });
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8
    ).toMatchObject({ status: 'unknown', qualification: 'unknown', application: 'unknown' });
  });
  it('refuses equally forged decision/witness evidence against independently admitted identity', () => {
    const f = fixture();
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue(f.admission);
    const forged = {
      ...f.capture.decision.tournamentPostflop!.authority!,
      evidenceSha256: 'f'.repeat(64),
    };
    f.capture.decision.tournamentPostflop!.authority = forged;
    (f.witness.phase8Authority as any).authority = forged;
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8!
        .qualification
    ).toBe('unknown');
  });
  it.each(['sourceSha', 'authorityKey', 'approvalGeneration', 'expiresAt'])(
    'rejects a foreign qualified identity field %s',
    (field) => {
      const f = fixture();
      vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue(f.admission);
      const forged = { ...f.capture.decision.tournamentPostflop!.authority! } as any;
      forged[field] =
        field === 'approvalGeneration'
          ? 999
          : field === 'expiresAt'
            ? '2099-01-01T00:00:00.000Z'
            : field === 'sourceSha'
              ? 'f'.repeat(40)
              : 'f'.repeat(64);
      f.capture.decision.tournamentPostflop!.authority = forged;
      (f.witness.phase8Authority as any).authority = forged;
      expect(
        new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8!
          .qualification
      ).toBe('unknown');
    }
  );
  it('keeps actual acceptance distinct from a selected or withdrawn proposal', () => {
    const f = fixture();
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue(f.admission);
    f.witness.phase8Authority!.selection = 'withdrawn_before_acceptance';
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8
    ).toMatchObject({ status: 'refused', application: 'refused' });
  });
  it('separates an admitted unchanged selection from an explicit acceptance-time refusal', () => {
    const f = fixture();
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue(f.admission);
    const receipt = f.capture.decision.tournamentPostflop!;
    receipt.applied = false;
    receipt.changed = false;
    receipt.selection = 'none';
    receipt.baselineAction = 'bet';
    receipt.baselineAmount = 20;
    f.witness.phase8Authority!.selection = 'none';
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8
    ).toMatchObject({ status: 'applicable-active', application: 'not-selected' });
    f.witness.phase8Authority!.verdict = 'withdrawn';
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8
    ).toMatchObject({ status: 'refused', application: 'refused' });
  });
  it('requires the originally captured admission, not the current caller mode', () => {
    const f = fixture();
    delete f.capture.replayState;
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase8!.reason
    ).toBe('candidate_admission_not_captured');
  });
  it('does not turn a coerced execution or missing producer fields into active proof', () => {
    const f = fixture();
    f.witness.executionStatus = 'coerced';
    const proof = new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans);
    expect(Object.values(proof).every((p) => p.status === 'unknown')).toBe(true);
  });
  it('checks the original aggregate read budget even when qualification fails', () => {
    const f = fixture();
    const interpreter = new HorseFleetPhaseInterpreter(() => {
      throw Error('bound_reached');
    });
    expect(() => interpreter.interpret(f.capture, f.witness, plans)).toThrow('bound_reached');
  });
  it('reports offline phase9 as unknown independently of captured runtime activity', () => {
    const f = fixture('shadow');
    const p = new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans);
    expect(p.phase9).toMatchObject({
      status: 'unknown',
      reason: 'offline_programme_qualification_required',
    });
    expect(p.phase10!.status).toBe('outside-domain');
    expect(p.phase15).toMatchObject({ qualification: 'unknown', application: 'not-applicable' });
  });
});

function phase7Baseline(allocated = false) {
  const { hero, state } = jointPolicyFixture('nlh', 1, 'tournament', 'preflop');
  state.toCall = 0;
  state.legalActions = ['check'];
  state.minRaiseTo = null;
  state.maxRaiseTo = null;
  if (allocated) state.actionHistory = decisionRequest().gameState.actionHistory;
  const opts = {
    telemetry: false,
    mind: false,
    decisionTimeMs: 1000,
    v27GtoCharts: false,
    phase8Postflop: 'off' as const,
    phase13Joint: 'off' as const,
  };
  const old = saveFastRandom();
  let decision: HorseDecision;
  try {
    seedFastRandom(7300930);
    decision = HorseLogic.decide(hero, state, 'balanced', {}, opts);
  } finally {
    restoreFastRandom(old);
  }
  if (!decision.tournamentUtility?.evidence) throw Error('actual supported utility not emitted');
  const snapshot = { ...decisionRequest(), player: hero, gameState: state, opts };
  const context = allocated ? horsePlanContextFromDecision(snapshot) : undefined;
  const readFrame = encodeHorseDecisionReads(
    HorseMind.createSandbox(),
    state.players,
    horsePlanHandKey(state.actionHistory, context),
    context
  );
  decision.tournamentUtility.readFrameSha256 = readFrame.sha256;
  const capture: HorsePhaseCapture = { snapshot, decision, readFrame, effects: [] };
  if (context)
    Object.assign(capture, {
      planContext: context,
      planBinding: horsePlanBatchBindingFromRequest(snapshot),
    });
  const witness = createHorseExecutionWitness(snapshot, decision, {
    requestId: snapshot.requestId,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [
      {
        intended: true,
        record: {
          seat: hero.seat,
          userId: hero.user_id,
          action: decision.action,
          amount: decision.amount ?? 0,
          stage: 'preflop',
        },
      },
    ],
  });
  return { capture, witness };
}
describe('supported Phase7 baseline activation and closed qualification domains', () => {
  it('verifies the maintained uncalibrated baseline through original evidence and accepted execution', () => {
    const f = phase7Baseline();
    expect(f.capture.decision.tournamentUtility!.evidence!.responseModel.calibration).toBe(
      'uncalibrated'
    );
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase7
    ).toMatchObject({
      status: 'applicable-active',
      qualification: 'verified',
      application: 'accepted',
      reason: 'supported_uncalibrated_utility_baseline',
    });
  });
  it('verifies an allocated original frame with nonempty public action history', () => {
    const f = phase7Baseline(true);
    expect(f.capture.readFrame.json).toContain('plan-hand-v1:');
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase7
    ).toMatchObject({ qualification: 'verified', application: 'accepted' });
  });
  it('refuses allocated evidence with a malformed retained context', () => {
    const f = phase7Baseline(true);
    Object.assign(f.capture, { planContext: { version: 1, hand: { tableId: 'foreign' } } });
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase7
    ).toMatchObject({ reason: 'utility_original_evidence_mismatch', application: 'refused' });
  });
  it('still refuses an allocated frame with a forged hash repeated by its receipts', () => {
    const f = phase7Baseline(true);
    f.capture.readFrame = { ...f.capture.readFrame, sha256: 'f'.repeat(64) };
    f.capture.decision.tournamentUtility!.readFrameSha256 = 'f'.repeat(64);
    const witness = structuredClone(f.witness);
    (witness.phase7Evidence as any).readFrameSha256 = 'f'.repeat(64);
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, witness, plans).phase7
    ).toMatchObject({ reason: 'utility_original_evidence_mismatch', application: 'refused' });
  });
  it('refuses disabled or unsupported context and preserves an explicit utility refusal', () => {
    const f = phase7Baseline();
    f.capture.snapshot.opts = { ...f.capture.snapshot.opts, phase7Utility: false };
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, f.witness, plans).phase7!.status
    ).toBe('refused');
    const bad = phase7Baseline();
    bad.capture.snapshot.gameState.tournament!.contextStatus = 'incomplete';
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(bad.capture, bad.witness, plans).phase7!
        .status
    ).toBe('refused');
    const refused = phase7Baseline();
    delete refused.capture.decision.tournamentUtility;
    refused.capture.decision.tournamentUtilityRefusal = 'context_incomplete';
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(refused.capture, refused.witness, plans)
        .phase7!.status
    ).toBe('refused');
  });
  it('refuses a forged original frame even when receipt and witness repeat its claimed hash', () => {
    const f = phase7Baseline();
    f.capture.readFrame = { ...f.capture.readFrame, sha256: 'f'.repeat(64) };
    f.capture.decision.tournamentUtility!.readFrameSha256 = 'f'.repeat(64);
    const witness = structuredClone(f.witness);
    (witness.phase7Evidence as any).readFrameSha256 = 'f'.repeat(64);
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(f.capture, witness, plans).phase7!.status
    ).toBe('refused');
  });
  it('caches both Phase 8 families and all canonical baseline/corrective admissions without a false bound', () => {
    const refusal = { status: 'refused', reason: 'unselected', transient: false } as const;
    for (const name of [
      'admitPhase8Authority',
      'admitPhase8GuardAuthority',
      'admitPhase10Authority',
      'admitPhase11Authority',
      'admitPhase12Authority',
      'admitPhase13Authority',
    ] as const)
      vi.spyOn(qualifiedReplayAdmissions, name).mockReturnValue(refusal);
    const corrective = vi
      .spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment')
      .mockReturnValue({ admission: refusal, catalog: null });
    const a = (new HorseFleetPhaseInterpreter(() => {}) as any).replayAdmissions;
    expect(CORRECTIVE_DOMAIN_KEYS).toHaveLength(45);
    expect(() => {
      for (let i = 0; i < 2; i++) {
        a.admitPhase8Authority();
        a.admitPhase8GuardAuthority();
        a.admitPhase10Authority();
        for (const v of Object.keys(PHASE11_PROTECTED_RELEASE_SELECTIONS))
          a.admitPhase11Authority(v);
        for (const v of Object.keys(PHASE12_PROTECTED_RELEASE_SELECTIONS))
          a.admitPhase12Authority(v);
        for (const v of Object.keys(PHASE13_PROTECTED_RELEASE_SELECTIONS))
          a.admitPhase13Authority(v);
        for (const d of CORRECTIVE_DOMAIN_KEYS) a.admitPhase14Attachment(d);
      }
    }).not.toThrow();
    expect(corrective).toHaveBeenCalledTimes(45);
    expect(qualifiedReplayAdmissions.admitPhase8GuardAuthority).toHaveBeenCalledTimes(1);
    expect(() => a.admitPhase14Attachment('nlh-untrusted-domain')).toThrow();
    expect(corrective).toHaveBeenCalledTimes(45);
  });
});
