import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HorseMind } from './HorseMind.js';
import {
  encodeHorseDecisionReads,
  decodeHorseDecisionReads,
  HORSE_DECISION_READ_FRAME_MAX_BYTES,
} from './HorseDecisionReadFrame.js';
import type { SeatPlayer } from '../types.js';
import { normalizeHorseObservationWindow } from './HorseObservationWindow.js';
import { horseRetainedPlanContext } from '../services/horseDecisionJournal/effects.js';
import {
  horsePlanContextFromDecision,
  horsePlanBatchBindingFromRequest,
} from './HorsePlanHandIdentity.js';

const players = [{ user_id: 'hero' }, { user_id: 'villain' }] as SeatPlayer[];
beforeEach(() => HorseMind.reset());
function populated() {
  HorseMind.importStats([
    { user_id: 'villain', hands: 90, folds: 80, facedAggr: 90, rHands: 12.625 },
  ]);
  HorseMind.importScoped([
    { user_id: 'villain', scope: 'omaha:hu', hands: 80, folds: 10, facedAggr: 80 },
  ]);
  HorseMind.importPairs([{ attacker_id: 'villain', victim_id: 'hero', n3: 8, opp3: 10 }]);
  HorseMind.notePlan('hand', 'hero', false);
  HorseMind.noteRaisePlan('hand', 'hero', 'flop', 'callOnce');
  HorseMind.noteOutlook('hand', 'hero', 'flop', ['Kh', 'Ah'], ['Ks', 'As']);
  return HorseMind.snapshotDecisionReads(players, 'hand');
}
describe('portable private Horse read frames', () => {
  it('retains every read container, insertion order and fractional evidence without live writes', () => {
    const view = populated(),
      frame = encodeHorseDecisionReads(view, players, 'hand');
    expect(Object.isFrozen(frame)).toBe(true);
    expect(frame.bytes).toBe(Buffer.byteLength(frame.json));
    const restored = decodeHorseDecisionReads(JSON.parse(JSON.stringify(frame)), players, 'hand');
    expect(restored).toEqual(view);
    expect([...restored.outlooks.get('hand|hero|flop')!.good]).toEqual(['Kh', 'Ah']);
    HorseMind.getStats('villain')!.hands = 900;
    HorseMind.runInSandbox(restored, () => {
      expect(HorseMind.getStats('villain')!.hands).toBe(90);
      HorseMind.setDecisionScope('omaha:hu');
      expect(HorseMind.exploit('villain', false).bluffMod).toBe(0.55);
      expect(HorseMind.getPlan('hand', 'hero')).toBe(false);
      expect(HorseMind.getRaisePlan('hand', 'hero', 'flop')).toBe('callOnce');
      expect(HorseMind.outlookOf('hand', 'hero', 'flop', 'Kh')).toBe('good');
    });
    expect(HorseMind.getStats('villain')!.hands).toBe(900);
  });

  it('refuses a valid frame belonging to another actor order or hand', () => {
    const frame = encodeHorseDecisionReads(populated(), players, 'hand');
    expect(() => decodeHorseDecisionReads(frame, [...players].reverse(), 'hand')).toThrow(
      'invalid'
    );
    expect(() => decodeHorseDecisionReads(frame, players, 'another')).toThrow('invalid');
  });

  it.each(['json', 'sha256', 'bytes', 'version'] as const)(
    'detects changed %s before restoring reads',
    (field) => {
      const frame = encodeHorseDecisionReads(populated(), players, 'hand');
      const bad = { ...frame, [field]: field === 'bytes' ? frame.bytes + 1 : 'changed' };
      expect(() => decodeHorseDecisionReads(bad as never, players, 'hand')).toThrow('invalid');
    }
  );

  it.each([
    'duplicate',
    'unknown_actor',
    'missing_stat',
    'extra_stat',
    'negative',
    'null',
    'unknown_field',
    'invalid_outlook',
    'extra_pair',
  ])('refuses a resealed malformed body: %s', (kind) => {
    const frame = encodeHorseDecisionReads(populated(), players, 'hand');
    const body = JSON.parse(frame.json);
    if (kind === 'duplicate') body.stats.push(body.stats[0]);
    if (kind === 'unknown_actor') body.stats[0][0] = 'unrelated';
    if (kind === 'missing_stat') body.stats[0][1].pop();
    if (kind === 'extra_stat') body.stats[0][1].push(0);
    if (kind === 'negative') body.stats[0][1][0] = -1;
    if (kind === 'null') body.stats[0][1][0] = null;
    if (kind === 'unknown_field') body.dirty = [];
    if (kind === 'invalid_outlook') body.outlooks[0][1].good = ['Ah', 'Ah'];
    if (kind === 'extra_pair') body.pairs[0][1].push(0);
    const json = JSON.stringify(body);
    const bad = {
      ...frame,
      json,
      bytes: Buffer.byteLength(json),
      sha256: createHash('sha256').update(json).digest('hex'),
    };
    expect(() => decodeHorseDecisionReads(bad, players, 'hand')).toThrow('invalid');
  });

  it.each(['seenActions', 'handFlags', 'dirty', 'dirtyPairs', 'dirtyScoped'] as const)(
    'never silently drops pending %s',
    (key) => {
      const view = populated();
      view[key].add('pending');
      expect(() => encodeHorseDecisionReads(view, players, 'hand')).toThrow('invalid');
    }
  );

  it('refuses over-budget or out-of-boundary captures without truncation', () => {
    const frame = encodeHorseDecisionReads(populated(), players, 'hand');
    expect(() =>
      decodeHorseDecisionReads(
        { ...frame, json: ' '.repeat(HORSE_DECISION_READ_FRAME_MAX_BYTES + 1) },
        players,
        'hand'
      )
    ).toThrow('invalid');
    const view = populated();
    view.stats.set('unrelated', { ...view.stats.get('villain')! });
    expect(() => encodeHorseDecisionReads(view, players, 'hand')).toThrow('invalid');
    expect(() => encodeHorseDecisionReads(populated(), [...players, players[0]], 'hand')).toThrow(
      'invalid'
    );
  });
});

describe('original observation windows in private read frames', () => {
  const window = { version: 1, coverage: 'complete', fromMs: 100, toMs: 200 } as const;
  const reseal = (frame: ReturnType<typeof encodeHorseDecisionReads>, body: unknown) => {
    const json = JSON.stringify(body);
    return {
      ...frame,
      json,
      bytes: Buffer.byteLength(json),
      sha256: createHash('sha256').update(json).digest('hex'),
    };
  };

  it.each([undefined, { version: 1 as const, hand: null }])(
    'preserves historical frame bytes and digests with context %j',
    (context) => {
      const view = HorseMind.createSandbox();
      const expected = JSON.stringify({
        version: context ? 'horse-decision-reads-v2' : 'horse-decision-reads-v1',
        ...(context ? { planContext: context } : {}),
        actors: ['hero', 'villain'],
        handKey: null,
        stats: [],
        scoped: [],
        pairs: [],
        plans: [],
        raisePlans: [],
        outlooks: [],
      });
      const frame = encodeHorseDecisionReads(view, players, null, context);
      expect(frame.json).toBe(expected);
      expect(frame.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
      expect(
        encodeHorseDecisionReads(
          decodeHorseDecisionReads(frame, players, null, context),
          players,
          null,
          context
        )
      ).toEqual(frame);
      const legacy = populated();
      for (const map of [legacy.stats, legacy.scoped])
        for (const row of map.values()) delete row.sourceWindow;
      const oldFrame = encodeHorseDecisionReads(legacy, players, 'hand');
      const restored = decodeHorseDecisionReads(oldFrame, players, 'hand');
      expect(
        normalizeHorseObservationWindow(restored.stats.get('villain')!.sourceWindow).coverage
      ).toBe('unknown');
      expect(encodeHorseDecisionReads(restored, players, 'hand')).toEqual(oldFrame);
    }
  );

  it('retains detached source envelopes and explicit unknown legacy rows in v3', () => {
    const view = populated();
    const source = { version: 1 as const, coverage: 'complete' as const, fromMs: 100, toMs: 200 };
    view.stats.get('villain')!.sourceWindow = source;
    delete view.scoped.get('omaha:hu|villain')!.sourceWindow;
    const frame = encodeHorseDecisionReads(view, players, 'hand');
    expect(frame.version).toBe('horse-decision-reads-v3');
    const restored = decodeHorseDecisionReads(frame, players, 'hand');
    expect(restored.stats.get('villain')!.sourceWindow).toEqual(window);
    expect(restored.scoped.get('omaha:hu|villain')!.sourceWindow).toEqual(
      normalizeHorseObservationWindow(undefined)
    );
    expect(Object.isFrozen(restored.stats.get('villain')!.sourceWindow)).toBe(true);
    source.toMs = 900;
    expect(
      decodeHorseDecisionReads(frame, players, 'hand').stats.get('villain')!.sourceWindow
    ).toEqual(window);
  });

  it.each([
    'missing_row',
    'duplicate_row',
    'wrong_actor',
    'reversed',
    'invented_unknown',
    'extra',
    'wrapper_version',
  ])('rejects resealed malformed v3 %s', (fault) => {
    const view = populated();
    view.stats.get('villain')!.sourceWindow = window;
    const frame = encodeHorseDecisionReads(view, players, 'hand');
    const body = JSON.parse(frame.json);
    if (fault === 'missing_row') body.statsWindows = [];
    if (fault === 'duplicate_row') body.statsWindows.push(body.statsWindows[0]);
    if (fault === 'wrong_actor') body.statsWindows[0][0] = 'hero';
    if (fault === 'reversed') body.statsWindows[0][1].fromMs = 300;
    if (fault === 'invented_unknown') body.statsWindows[0][1].coverage = 'unknown';
    if (fault === 'extra') body.statsWindows[0][1].fresh = true;
    const bad = reseal(frame, body);
    if (fault === 'wrapper_version') bad.version = 'horse-decision-reads-v1';
    expect(() => decodeHorseDecisionReads(bad, players, 'hand')).toThrow('invalid');
  });

  it('admits allocated v3 journal reads without permitting legacy downgrade or another plan context', () => {
    const request = {
      type: 'DECIDE_FAST',
      requestId: 1,
      generation: 1,
      fence: 'unallocated-fixture',
      decisionKey: `phase5-v1:${'a'.repeat(64)}`,
      player: { seat: 1, user_id: 'hero' },
      gameState: { stage: 'flop' },
    } as const;
    const planContext = horsePlanContextFromDecision(request);
    const view = populated();
    view.plans.clear();
    view.raisePlans.clear();
    view.outlooks.clear();
    view.stats.get('villain')!.sourceWindow = window;
    const readFrame = encodeHorseDecisionReads(view, players, null, planContext);
    const capture = {
      planContext,
      planBinding: horsePlanBatchBindingFromRequest(request),
      readFrame,
    };
    const unallocatedFrame = encodeHorseDecisionReads(view, players, null);
    expect(horseRetainedPlanContext({ readFrame: unallocatedFrame }, request as never)).toEqual({
      kind: 'legacy',
    });
    expect(
      decodeHorseDecisionReads(unallocatedFrame, players, null).stats.get('villain')!.sourceWindow
    ).toEqual(window);
    expect(
      horseRetainedPlanContext({ ...capture, readFrame: unallocatedFrame }, request as never)
    ).toEqual({ kind: 'invalid' });
    expect(horseRetainedPlanContext(capture, request as never)).toEqual({
      kind: 'current',
      context: planContext,
    });
    expect(horseRetainedPlanContext({ readFrame: capture.readFrame }, request as never)).toEqual({
      kind: 'invalid',
    });
    expect(
      horseRetainedPlanContext(
        {
          ...capture,
          planContext: {
            version: 1,
            hand: { version: 1, tableId: '00000000-0000-4000-8000-000000000000', handNumber: 1 },
          },
        },
        request as never
      )
    ).toEqual({ kind: 'invalid' });
  });
});
