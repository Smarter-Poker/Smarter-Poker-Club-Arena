import { buildOriginalRiverDecision } from '../../services/horseCorrectiveReview/riverDecisionModel.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
  type HorseDecisionWorkerDependencies,
} from './workerRuntime.js';
import type {
  FastHorseDecisionRequest,
  FastHorseDecisionResult,
  HorseDecisionWorkerResponse,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import { HorseLogic } from '../HorseLogic.js';
import { HorseQualifiedAuthorityHolder } from '../HorseQualifiedAuthority.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import {
  riverReferenceFixture,
  bind,
  cards,
} from '../../services/horseCorrectiveReview/riverReference.test-support.js';
import { kernelAdmissionFixture } from '../../services/horseCorrectiveReview/kernelAdmission.test-support.js';
import { admitCorrectiveKernelAttachment } from '../../services/horseCorrectiveReview/kernelAdmission.js';
import { now } from '../../services/horseCorrectiveReview/kernelApproval.test-support.js';
import { correctiveKernelReceiptIsValid } from '../../services/horseCorrectiveReview/kernelReceipt.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from '../HorseEval.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';
export function request(holes = '4s 4h'): FastHorseDecisionRequest {
  const i = riverReferenceFixture();
  i.hero = cards(holes);
  i.stack = 200;
  i.board = cards('Ac Kd 7h 8d 9c');
  bind(i);
  const j = jointPolicyFixture('nlh');
  const r = i.original.snapshot;
  r.gameState = {
    ...j.state,
    ...r.gameState,
    heroSeat: 1,
    currentPlayerSeat: 1,
    minRaiseTo: null,
    maxRaiseTo: null,
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    communityCards2: [],
    communityCards3: [],
    bettingStructure: 'no_limit',
    actionHistory: [],
    pots: [
      { amount: 50, eligiblePlayers: ['hero', 'opponent'] },
      { amount: 50, eligiblePlayers: ['opponent'] },
    ],
  };
  r.opts = {
    phase8Postflop: 'off',
    phase10Plo4: 'off',
    phase11Omaha: 'off',
    phase12Remaining: 'off',
    phase13Joint: 'off',
  };
  r.style = 'balanced';
  r.mods = {};
  r.decisionTimeMs = now;
  r.decisionKey = buildHorseDecisionKey(r);
  return r;
}
export function harness(selected = true, draw = 0) {
  const f = kernelAdmissionFixture(),
    attachment = admitCorrectiveKernelAttachment('nlh-cash', f.selection, f.reader, now, f.context);
  if (attachment.admission.status !== 'admitted') throw Error('test attachment');
  const messages: HorseDecisionWorkerResponse[] = [],
    holders = new Map<string, HorseQualifiedAuthorityHolder>(),
    records: unknown[] = [];
  const deps: HorseDecisionWorkerDependencies = {
    ...defaultHorseDecisionWorkerDependencies,
    startServices: async () => defaultHorseDecisionWorkerDependencies.workerReadiness(),
    stopServices: async () => {},
    journalEnabled: () => true,
    journalDecision: (_request, body) => {
      records.push(body);
    },
    journalLifecycle: undefined,
    journalExecution: undefined,
    journalPlanReceipt: undefined,
    admitPhase8Authority: undefined,
    admitPhase10Authority: undefined,
    admitPhase11Authority: undefined,
    admitPhase12Authority: undefined,
    admitPhase13Authority: undefined,
    admitPhase14Attachment: (domain) =>
      selected && domain === 'nlh-cash'
        ? attachment
        : {
            admission: { status: 'refused', reason: 'unselected', transient: false },
            catalog: null,
          },
    correctiveDraw: vi.fn(() => draw),
    noteFeature: () => {},
    noteDecision: () => {},
    observeCompletedHand: () => {},
  };
  const runtime = new HorseDecisionWorkerRuntime(
    (m) => messages.push(m),
    deps,
    undefined,
    (owner, domain, version, epoch) => {
      const h = new HorseQualifiedAuthorityHolder(epoch, version);
      if (owner === 'phase14' && domain) holders.set(domain, h);
      return h;
    }
  );
  return { runtime, messages, holders, deps, records, attachment };
}
export async function run(h: ReturnType<typeof harness>, r = request()) {
  await h.runtime.start();
  h.runtime.receive(r);
  await h.runtime.drain();
  const result = h.messages.find((m): m is FastHorseDecisionResult => m.type === 'FAST_RESULT');
  if (!result) throw Error(JSON.stringify(h.messages.filter((m) => m.type === 'ERROR')));
  return result;
}
