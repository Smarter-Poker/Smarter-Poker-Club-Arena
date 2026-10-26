import { HorsePhase8AuthorityGate } from '../HorseQualifiedAuthority.js';
import {
  liveHorsePhase14Authorities,
  horsePhase14ContinuationVersion,
} from '../HorsePhase14Authority.js';
import { CORRECTIVE_KERNEL_CATALOG_VERSION } from '../../services/horseCorrectiveReview/kernelCatalog.js';
import { recheckHorsePhase14BeforeAcceptance } from '../HorsePhase14Acceptance.js';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { harness, request } from './phase14Worker.test-support.js';
import { now } from '../../services/horseCorrectiveReview/kernelApproval.test-support.js';
import { LiveHorseDecisionWorkerClient, type WorkerLike } from './client.js';
import type { HorseDecisionWorkerRequest, HorseDecisionWorkerResponse } from './protocol.js';
class RealRuntimeTransport extends EventEmitter implements WorkerLike {
  readonly h = harness();
  private read = 0;
  constructor(private readonly change: (m: HorseDecisionWorkerResponse) => void = () => {}) {
    super();
    void this.h.runtime.start().then(() => this.flush());
  }
  private flush() {
    while (this.read < this.h.messages.length) {
      const m = structuredClone(this.h.messages[this.read++]);
      this.change(m);
      this.emit('message', m);
    }
  }
  postMessage(m: HorseDecisionWorkerRequest) {
    this.h.runtime.receive(structuredClone(m));
    void this.h.runtime.drain().then(() => this.flush());
  }
  async terminate() {
    return 0;
  }
}
afterEach(() => vi.restoreAllMocks());
describe('actual Phase14 worker through the client IPC boundary', () => {
  it('binds and stamps actual FAST and DEEP outputs to the original input and reads', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const worker = new RealRuntimeTransport(),
      client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    try {
      const input = request(),
        fast = await client.decideFast(input);
      expect(fast.decision.correctivePolicy?.applied).toBe(true);
      expect(fast.decision.executionWitness?.phase14Inputs?.inputDigest).toBe(
        fast.decision.correctivePolicy?.inputDigest
      );
      expect(fast.decision.correctivePolicy?.authority?.mainGeneration).toBeTypeOf('number');
      const deep = await client.decideDeep({ ...input, rngBefore: fast.rngBefore, deepEquity: 2 });
      expect(deep.decision.correctivePolicy?.applied).toBe(true);
      expect(deep.decision.correctivePolicy?.inputDigest).toBe(
        fast.decision.correctivePolicy?.inputDigest
      );
      expect(deep.decision.correctivePolicy?.readFrameDigest).toBe(
        fast.decision.correctivePolicy?.readFrameDigest
      );
    } finally {
      await client.stop();
    }
  });
  it.each(['input', 'reads', 'missing'] as const)(
    'refuses %s original evidence before a witness can authorize an answer',
    async (fault) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const worker = new RealRuntimeTransport((m) => {
        if (m.type !== 'FAST_RESULT') return;
        if (fault === 'missing') delete m.phase14OriginalBinding;
        if (fault === 'input')
          m.phase14OriginalBinding = { ...m.phase14OriginalBinding!, inputDigest: '0'.repeat(64) };
        if (fault === 'reads') m.decision.correctivePolicy!.readFrameDigest = '0'.repeat(64);
      });
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      try {
        await expect(client.decideFast(request())).rejects.toThrow(/corrective/);
      } finally {
        await client.stop();
      }
    }
  );
  it.each(['FAST_RESULT', 'DEEP_RESULT'] as const)(
    'retires a correction withdrawn while %s is pending at the actual IPC boundary',
    async (lane) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      let gate: HorsePhase8AuthorityGate;
      let queuedCandidate = 0;
      const worker = new RealRuntimeTransport((message) => {
        if (message.type !== lane) return;
        expect(message.decision.correctivePolicy?.applied).toBe(true);
        expect(message.decision.action).toBe('call');
        queuedCandidate++;
        gate.withdraw('pending-ipc-rollback');
      });
      gate = new HorsePhase8AuthorityGate(
        () => worker.h.attachment.admission,
        undefined,
        horsePhase14ContinuationVersion('nlh-cash', CORRECTIVE_KERNEL_CATALOG_VERSION)
      );
      gate.refresh();
      const live = liveHorsePhase14Authorities['nlh-cash'];
      vi.spyOn(live, 'observeWorker').mockImplementation((receipt) => gate.observeWorker(receipt));
      vi.spyOn(live, 'stamp').mockImplementation((receipt) => gate.stamp(receipt));
      vi.spyOn(live, 'check').mockImplementation((...args) => gate.check(...args));
      vi.spyOn(live, 'mainAuthority').mockImplementation(() => gate.mainAuthority());
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      try {
        const input = request(),
          fast = await client.decideFast(input);
        const result =
          lane === 'FAST_RESULT'
            ? fast
            : await client.decideDeep({ ...input, rngBefore: fast.rngBefore, deepEquity: 2 });
        expect(queuedCandidate).toBe(1);
        const selected = recheckHorsePhase14BeforeAcceptance(result.decision);
        expect(selected).toMatchObject({
          action: 'fold',
          amount: 0,
          correctivePolicy: { applied: false, reason: 'withdrawn_before_acceptance' },
        });
        expect(selected.executionWitness).toMatchObject({
          selected: { action: 'fold', amount: 0 },
          expectedExecutionAmount: 0,
          phase14Authority: { selection: 'withdrawn_before_acceptance' },
        });
        expect(worker.h.deps.correctiveDraw).toHaveBeenCalledTimes(lane === 'FAST_RESULT' ? 1 : 2);
        expect(fast.effects).toEqual([]);
      } finally {
        await client.stop();
      }
    }
  );
});
