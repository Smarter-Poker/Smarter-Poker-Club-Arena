import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseMind } from '../../../engine/HorseMind.js';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { seedFastRandom } from '../../../engine/HorseEval.js';
import { horsePlanContextFromDecision } from '../../../engine/HorsePlanHandIdentity.js';
import { horsePlanHandKey } from '../../../engine/HorseDecisionEffects.js';
import { buildHorseDecisionKey } from '../../../engine/horseDecision/protocol.js';
import { workerHarness, requestAt, commitOf, otherTableId, heroId, wager } from './fixture.js';

beforeEach(() => {
  HorseMind.reset();
  seedFastRandom(7001);
});
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('actual worker issue ownership and volatile plan application', () => {
  it('applies the detached actual issued batch once, then acknowledges its exact duplicate', async () => {
    const h = workerHarness();
    try {
      const result = await h.fast(),
        key = horsePlanHandKey(
          requestAt().gameState.actionHistory,
          result.planBinding.planContext
        )!;
      expect(result.effects).toHaveLength(3);
      expect(HorseMind.getPlan(key, heroId)).toBeUndefined();
      h.runtime.receive(commitOf(result, 2));
      await h.runtime.drain();
      expect(HorseMind.getPlan(key, heroId)).toBe(true);
      expect(HorseMind.getRaisePlan(key, heroId, 'flop')).toBe('foldToRaise');
      expect(HorseMind.outlookOf(key, heroId, 'flop', 'Ah')).toBe('good');
      expect(h.applied()).toBe(1);
      h.runtime.receive(commitOf(result, 3));
      await h.runtime.drain();
      expect(h.applied()).toBe(1);
      expect(h.messages.at(-1)).toMatchObject({
        type: 'ACK',
        requestId: 3,
        operation: 'COMMIT_DECISION_EFFECTS',
      });
    } finally {
      await h.close();
    }
  });
  it.each([
    'unknown',
    'other_table',
    'other_actor',
    'other_amountless_plan',
    'original_id',
    'commit_id',
  ] as const)('refuses %s without a successful application ACK', async (fault) => {
    const h = workerHarness();
    try {
      const result = await h.fast(),
        commit = commitOf(result, 2);
      if (fault === 'unknown') {
        commit.fence = requestAt(2, otherTableId).fence;
        (commit.planBinding as any).fence = commit.fence;
      }
      if (fault === 'other_table')
        (commit.planBinding.planContext.hand as any).tableId = otherTableId;
      if (fault === 'other_actor') (commit.planBinding as any).actorId = 'unissued';
      if (fault === 'other_amountless_plan') (commit.effects[0] as any).barrelIntent = false;
      if (fault === 'original_id') (commit.planBinding as any).fastRequestId = 999;
      if (fault === 'commit_id') commit.requestId = result.requestId;
      h.runtime.receive(commit);
      await h.runtime.drain();
      expect(h.applied()).toBe(0);
      expect(h.messages.at(-1)).toMatchObject({ type: 'ERROR' });
    } finally {
      await h.close();
    }
  });
  it.each([60000, 60001])(
    'retains pending ownership across the former %dms compute lifetime',
    async (age) => {
      const h = workerHarness();
      try {
        const result = await h.fast();
        h.advance(age);
        h.runtime.receive(commitOf(result, 2));
        await h.runtime.drain();
        expect(h.messages.at(-1)).toMatchObject({
          type: 'ACK',
          planDisposition: 'applied_volatile',
        });
        expect(h.applied()).toBe(1);
      } finally {
        await h.close();
      }
    }
  );
  it('refuses new issuance at128 without evicting any pending issue', async () => {
    const h = workerHarness();
    try {
      const first = await h.fast();
      let last = first;
      for (let n = 2; n <= 129; n++) last = await h.fast(requestAt(n, undefined, 1000100 + n));
      expect(first.planIssueDisposition).toBe('issued');
      expect(last.planIssueDisposition).toBe('capacity_unavailable');
      h.runtime.receive(commitOf(first, 130));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ACK');
      h.runtime.receive(commitOf(last, 131));
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({ type: 'ERROR', planRefusal: 'issue_absent' });
      expect(h.applied()).toBe(1);
    } finally {
      await h.close();
    }
  });
  it.each(['empty', 'applied', 'retired'] as const)(
    'reclaims a %s entry before pending ownership at128',
    async (terminal) => {
      const h = workerHarness();
      try {
        const pending = await h.fast();
        const decide = h.deps.decide;
        if (terminal === 'empty') h.deps.decide = () => wager();
        const reclaimable = await h.fast(requestAt(2, undefined, 1000102));
        h.deps.decide = decide;
        if (terminal === 'applied') h.runtime.receive(commitOf(reclaimable, 3));
        if (terminal === 'retired')
          h.runtime.receive({
            type: 'RETIRE_DECISION_EFFECTS',
            requestId: 3,
            generation: reclaimable.generation,
            fence: reclaimable.fence,
            planBinding: reclaimable.planBinding,
            reason: 'decision_finalized',
          });
        await h.runtime.drain();
        for (let n = 4; n <= 130; n++)
          expect((await h.fast(requestAt(n, undefined, 1000100 + n))).planIssueDisposition).toBe(
            'issued'
          );
        h.runtime.receive(commitOf(pending, 131));
        await h.runtime.drain();
        expect(h.messages.at(-1)).toMatchObject({
          type: 'ACK',
          planDisposition: 'applied_volatile',
        });
        h.runtime.receive(commitOf(reclaimable, 132));
        await h.runtime.drain();
        expect(h.messages.at(-1)).toMatchObject({ type: 'ERROR', planRefusal: 'issue_absent' });
      } finally {
        await h.close();
      }
    }
  );
  it.each(['wrong_binding', 'exact', 'applied'] as const)(
    'keeps exact retirement ownership for %s',
    async (mode) => {
      const h = workerHarness();
      try {
        const fast = await h.fast();
        if (mode === 'applied') {
          h.runtime.receive(commitOf(fast, 2));
          await h.runtime.drain();
        }
        const binding = structuredClone(fast.planBinding);
        if (mode === 'wrong_binding') (binding as any).actorId = 'other';
        const retirement = {
          type: 'RETIRE_DECISION_EFFECTS' as const,
          requestId: 3,
          generation: fast.generation,
          fence: fast.fence,
          planBinding: binding,
          reason: 'decision_finalized' as const,
        };
        h.runtime.receive(retirement);
        await h.runtime.drain();
        expect(h.messages.at(-1)).toMatchObject(
          mode === 'wrong_binding'
            ? { type: 'ERROR', planRefusal: 'binding_mismatch' }
            : {
                type: 'ACK',
                planDisposition: mode === 'applied' ? 'already_applied_volatile' : 'retired',
              }
        );
        h.runtime.receive({ ...retirement, requestId: 4 });
        await h.runtime.drain();
        if (mode === 'exact')
          expect(h.messages.at(-1)).toMatchObject({
            type: 'ACK',
            planDisposition: 'already_retired',
          });
        h.runtime.receive(commitOf(fast, 5));
        await h.runtime.drain();
        expect(h.messages.at(-1)).toMatchObject(
          mode === 'exact' ? { type: 'ERROR', planRefusal: 'issue_retired' } : { type: 'ACK' }
        );
        expect(h.applied()).toBe(mode === 'exact' ? 0 : 1);
      } finally {
        await h.close();
      }
    }
  );
  it.each(['empty_first', 'empty_second'] as const)(
    'does not bypass reissue ambiguity with %s',
    async (mode) => {
      const h = workerHarness();
      try {
        const decide = h.deps.decide;
        if (mode === 'empty_first') h.deps.decide = () => wager();
        const first = await h.fast();
        h.deps.decide = mode === 'empty_second' ? () => wager() : decide;
        const next = await h.fast(requestAt(2));
        expect(next.planIssueDisposition).toBe('reissue_unavailable');
        for (const [fast, requestId] of [
          [first, 3],
          [next, 4],
        ] as const) {
          h.runtime.receive(commitOf(fast, requestId));
          await h.runtime.drain();
          expect(h.messages.at(-1)?.type).toBe('ERROR');
        }
        expect(h.applied()).toBe(0);
      } finally {
        await h.close();
      }
    }
  );
  it.each([false, true])('retains unapplied reissue ambiguity when changed=%s', async (changed) => {
    const h = workerHarness();
    try {
      const first = await h.fast(),
        next = requestAt(2);
      if (changed) {
        next.mods = { aggression: 1.1 } as any;
        next.decisionKey = buildHorseDecisionKey(next);
      }
      const second = await h.fast(next);
      for (const [result, id] of [
        [first, 3],
        [second, 4],
      ] as const) {
        h.runtime.receive(commitOf(result, id));
        await h.runtime.drain();
        expect(h.messages.at(-1)?.type).toBe('ERROR');
      }
      expect(h.applied()).toBe(0);
    } finally {
      await h.close();
    }
  });
  it('keeps only the exact applied original after a later FAST reissue', async () => {
    const h = workerHarness();
    try {
      const first = await h.fast();
      h.runtime.receive(commitOf(first, 2));
      await h.runtime.drain();
      const next = await h.fast(requestAt(3));
      h.runtime.receive(commitOf(next, 4));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ERROR');
      h.runtime.receive(commitOf(first, 5));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ACK');
      expect(h.applied()).toBe(1);
    } finally {
      await h.close();
    }
  });
  it('does not label a partial application throw as applied, or retry it', async () => {
    let calls = 0;
    const h = workerHarness({
      applyDecisionEffects: (effects) => {
        calls++;
        HorseMind.applyDecisionEffects(effects.slice(0, 1));
        throw Error('injected after first write');
      },
    });
    try {
      const result = await h.fast(),
        key = result.effects[0]!.handKey;
      h.runtime.receive(commitOf(result, 2));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ERROR');
      expect(HorseMind.getPlan(key, heroId)).toBe(true); // Partial volatile write is explicitly retained as a limitation.
      h.runtime.receive(commitOf(result, 3));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ERROR');
      expect(calls).toBe(1);
    } finally {
      await h.close();
    }
  });
  it('cancels a queued commit by its own ID without retiring its issued FAST', async () => {
    const h = workerHarness();
    try {
      const result = await h.fast();
      h.runtime.receive(commitOf(result, 2));
      h.runtime.receive({ type: 'CANCEL', requestId: 2 });
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({ type: 'CANCELLED', requestId: 2 });
      expect(h.applied()).toBe(0);
      h.runtime.receive(commitOf(result, 3));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ACK');
    } finally {
      await h.close();
    }
  });
  it('preserves an emitted FAST issue when Turns cancels the completed compute request', async () => {
    const h = workerHarness();
    try {
      const result = await h.fast();
      h.runtime.receive({ type: 'CANCEL', requestId: result.requestId });
      h.runtime.receive(commitOf(result, 2));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ACK');
      expect(h.applied()).toBe(1);
    } finally {
      await h.close();
    }
  });
  it('does not issue application permission when the local FAST send throws', async () => {
    const h = workerHarness({}, (m) => {
      if (m.type === 'FAST_RESULT') throw Error('injected send failure');
    });
    try {
      const result = await h.fast();
      h.runtime.receive(commitOf(result, 2));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ERROR');
      expect(h.applied()).toBe(0);
    } finally {
      await h.close();
    }
  });
  it('does not erase an applied original when its repeated FAST send throws', async () => {
    let throwFast = false;
    const h = workerHarness({}, (m) => {
      if (throwFast && m.type === 'FAST_RESULT') throw Error('repeat send failed');
    });
    try {
      const original = await h.fast();
      h.runtime.receive(commitOf(original, 2));
      await h.runtime.drain();
      throwFast = true;
      await h.fast(requestAt());
      h.runtime.receive(commitOf(original, 3));
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({
        type: 'ACK',
        planDisposition: 'already_applied_volatile',
      });
      expect(h.applied()).toBe(1);
    } finally {
      await h.close();
    }
  });
  it('does not let caller options choose a plan identity', async () => {
    const h = workerHarness();
    try {
      const request = requestAt();
      (request.opts as any) = {
        mindPlanContext: horsePlanContextFromDecision(requestAt(2, otherTableId)),
      };
      request.decisionKey = buildHorseDecisionKey(request);
      h.runtime.receive(request);
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({ type: 'ERROR', recoverable: true });
      expect(h.applied()).toBe(0);
    } finally {
      await h.close();
    }
  });
  it('restores the original v2 FAST read frame for a different DEEP job ID and discards its writes', async () => {
    const h = workerHarness();
    try {
      const request = requestAt(),
        fast = await h.fast(request);
      h.runtime.receive(commitOf(fast, 2));
      await h.runtime.drain();
      h.runtime.receive({
        ...request,
        type: 'DECIDE_DEEP',
        requestId: 3,
        rngBefore: fast.rngBefore,
        deepEquity: 2,
      });
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({
        type: 'DEEP_RESULT',
        requestId: 3,
        planContext: fast.planBinding.planContext,
      });
      expect(h.applied()).toBe(1);
      expect(h.captures).toHaveLength(2);
      expect(h.captures[1]).not.toHaveProperty('effects');
      expect((h.captures[1]!.readFrame as any).sha256).toBe(
        (h.captures[0]!.readFrame as any).sha256
      );
    } finally {
      await h.close();
    }
  });
  it('makes an applied plan available to the next actual HorseLogic read only at the same table', async () => {
    const h = workerHarness();
    try {
      const first = await h.fast();
      h.runtime.receive(commitOf(first, 2));
      await h.runtime.drain();
      const reads = vi.spyOn(HorseMind, 'getPlan'),
        writes = vi.spyOn(HorseMind, 'notePlan'),
        request = requestAt(3);
      request.gameState.stage = 'turn';
      request.gameState.communityCards.push({ rank: '3', suit: 'clubs' });
      request.decisionKey = buildHorseDecisionKey(request);
      const key = first.effects[0]!.handKey;
      const otherKey = horsePlanHandKey(
        request.gameState.actionHistory,
        horsePlanContextFromDecision(requestAt(4, otherTableId))
      );
      expect(otherKey).not.toBeNull();
      expect(otherKey).not.toBe(key);
      expect(HorseMind.getPlan(key, heroId)).toBe(true);
      expect(HorseMind.getPlan(otherKey, heroId)).toBeUndefined();
      for (const table of [undefined, otherTableId]) {
        const next = table ? { ...request, fence: requestAt(4, table).fence } : request;
        const context = horsePlanContextFromDecision(next);
        const nextKey = horsePlanHandKey(next.gameState.actionHistory, context);
        expect(nextKey).toBe(table ? otherKey : key);
        reads.mockClear();
        writes.mockClear();
        HorseLogic.decide(
          next.player,
          next.gameState,
          'balanced',
          {},
          { mindPlanContext: context, observeMind: false, telemetry: false }
        );
        const readIndex = reads.mock.calls.findIndex(
          (row) => row[0] === nextKey && row[1] === heroId
        );
        expect(readIndex).toBeGreaterThanOrEqual(0);
        expect(reads.mock.results[readIndex]).toEqual({
          type: 'return',
          value: table ? undefined : true,
        });
        if (table) {
          // The actual decision may create its own plan after reading. The
          // seeded local false is distinct from inheriting the other table's true.
          const writeIndex = writes.mock.calls.findIndex(
            (row) => row[0] === otherKey && row[1] === heroId && row[2] === false
          );
          expect(writeIndex).toBeGreaterThanOrEqual(0);
          expect(writes.mock.invocationCallOrder[writeIndex]!).toBeGreaterThan(
            reads.mock.invocationCallOrder[readIndex]!
          );
          expect(writes.mock.calls.every((row) => row[0] === otherKey)).toBe(true);
        }
      }
      expect(HorseMind.getPlan(key, heroId)).toBe(true);
      expect(HorseMind.getPlan(otherKey, heroId)).toBe(false);
    } finally {
      await h.close();
    }
  });
});
