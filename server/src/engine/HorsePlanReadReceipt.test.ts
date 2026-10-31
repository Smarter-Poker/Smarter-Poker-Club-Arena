import { afterEach, expect, it, vi } from 'vitest';
import {
  HorsePlanReadCapture,
  horsePlanReadsAreValid,
  HORSE_PLAN_READ_RECEIPT_MAX_BYTES,
} from './HorsePlanReadReceipt.js';
import { HorseMind } from './HorseMind.js';
import { HorseLogic } from './HorseLogic.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from './HorseEval.js';
import { horsePlanContextFromDecision, horsePlanContextKey } from './HorsePlanHandIdentity.js';
import { encodeHorseDecisionReads } from './HorseDecisionReadFrame.js';
import { buildHorseDecisionKey } from './horseDecision/protocol.js';
import { horseVariantRulesFor } from './VariantRules.js';
import { bettingStructureFor } from './BettingStructure.js';
import { HandController } from './HandController.js';
import { horsePlanAcceptanceFromController } from './HorsePlanEffectReceipt.js';
import { captureHorseHandJournalContext } from './HorseDecisionHandBinding.js';
import {
  decisionRequest,
  workerHarness,
  commitOf,
} from '../testing/horseRegression/plan/fixture.js';
import type { ActionRecord, GameState } from '../types.js';

afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
function original(variant = 'nlh') {
  const r = decisionRequest();
  r.gameState.gameVariant = variant;
  r.gameState.variantRules = horseVariantRulesFor(variant);
  r.gameState.bettingStructure = bettingStructureFor(variant);
  r.gameState.maxRaiseTo = variant === 'nlh' ? 94 : 12;
  r.player.cards = [
    { rank: 'A', suit: 'hearts' },
    { rank: 'K', suit: 'hearts' },
    { rank: 'J', suit: 'clubs' },
    { rank: 'T', suit: 'clubs' },
    { rank: '8', suit: 'diamonds' },
    { rank: '7', suit: 'diamonds' },
  ].slice(0, r.gameState.variantRules.holeCardsDealt) as typeof r.player.cards;
  r.decisionKey = buildHorseDecisionKey(r);
  return r;
}
function frameOf(r = original(), value?: boolean) {
  const context = horsePlanContextFromDecision(r),
    key = horsePlanContextKey(context)!;
  const view = HorseMind.createSandbox();
  if (value !== undefined) view.plans.set(`${key}|${r.player.user_id}`, value);
  return {
    context,
    key,
    view,
    frame: encodeHorseDecisionReads(view, r.gameState.players, key, context),
  };
}
function choose(
  r: ReturnType<typeof original>,
  view: ReturnType<typeof frameOf>['view'],
  capture?: HorsePlanReadCapture
) {
  return HorseMind.runInSandbox(view, () =>
    HorseMind.captureDecisionEffects(() =>
      HorseLogic.decide(
        r.player,
        r.gameState,
        r.style,
        r.mods,
        {
          ...r.opts,
          observeMind: false,
          telemetry: false,
          mindPlanContext: horsePlanContextFromDecision(r),
        },
        undefined,
        capture
      )
    )
  );
}

it('records the actual getter return: false, undefined and not consulted remain distinct', () => {
  const saved = saveFastRandom();
  try {
    for (const [value, code] of [
      [undefined, 0],
      [false, 1],
      [true, 2],
    ] as const) {
      const r = original(),
        f = frameOf(r, value),
        c = new HorsePlanReadCapture(r);
      seedFastRandom(7001);
      choose(r, f.view, c);
      const receipt = c.finish(f.frame.sha256)!;
      expect(receipt.status).toBe('observed');
      expect(receipt.lookups[0]).toBe(code);
      expect(horsePlanReadsAreValid(receipt, r, f.frame)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(
        HORSE_PLAN_READ_RECEIPT_MAX_BYTES
      );
    }
    const r = original();
    r.opts = { mind: false };
    r.decisionKey = buildHorseDecisionKey(r);
    const f = frameOf(r, true),
      c = new HorsePlanReadCapture(r);
    choose(r, f.view, c);
    expect(c.finish(f.frame.sha256)).toMatchObject({
      status: 'not_reached',
      lookups: [-1, -1, -1],
    });
  } finally {
    restoreFastRandom(saved);
  }
});

it.each(['nlh', 'plo4', 'plo5', 'plo6', 'plo8'])(
  'does not change %s action, RNG or captured effects',
  (variant) => {
    const saved = saveFastRandom();
    try {
      const r = original(variant),
        a = frameOf(r, false),
        b = frameOf(r, false),
        c = new HorsePlanReadCapture(r);
      seedFastRandom(6101);
      const without = choose(r, a.view);
      const rng = saveFastRandom();
      seedFastRandom(6101);
      const withReceipt = choose(r, b.view, c);
      const semantic = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value, (key, v) =>
            ['elapsedMs', 'latencyMs'].includes(key) ? undefined : v
          )
        );
      expect(semantic(withReceipt)).toEqual(semantic(without));
      expect(saveFastRandom()).toEqual(rng);
      expect(horsePlanReadsAreValid(c.finish(b.frame.sha256), r, b.frame)).toBe(true);
    } finally {
      restoreFastRandom(saved);
    }
  }
);

it('records the actual original outlook classification without exporting its cards or sets', () => {
  const saved = saveFastRandom();
  try {
    for (const [kind, code] of [
      ['good', 1],
      ['scare', 2],
      ['blank', 3],
    ] as const) {
      const r = original();
      r.gameState.stage = 'turn';
      r.gameState.communityCards.push({ rank: '2', suit: 'clubs' });
      r.decisionKey = buildHorseDecisionKey(r);
      const f = frameOf(r),
        capture = new HorsePlanReadCapture(r);
      f.view.outlooks.set(`${f.key}|${r.player.user_id}|flop`, {
        good: new Set(kind === 'good' ? ['2c'] : []),
        scare: new Set(kind === 'scare' ? ['2c'] : []),
      });
      const frame = encodeHorseDecisionReads(f.view, r.gameState.players, f.key, f.context);
      seedFastRandom(7001);
      choose(r, f.view, capture);
      const receipt = capture.finish(frame.sha256)!;
      expect(receipt.lookups[1]).toBe(code);
      expect(horsePlanReadsAreValid(receipt, r, frame)).toBe(true);
      expect(Object.keys(receipt)).toEqual([
        'version',
        'status',
        'inputSha256',
        'readFrameSha256',
        'lookups',
      ]);
    }
  } finally {
    restoreFastRandom(saved);
  }
});

it('keeps DEEP getter evidence bound to its retained original FAST frame without issuing effects', async () => {
  const h = workerHarness({ decide: (...args) => HorseLogic.decide(...args) });
  try {
    const request = decisionRequest(),
      fast = await h.fast(request);
    h.runtime.receive({
      ...request,
      type: 'DECIDE_DEEP',
      requestId: 202,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({ type: 'DEEP_RESULT', requestId: 202 });
    const capture = h.captures.at(-1)! as any;
    expect(capture.effects).toEqual([]);
    expect(capture.planReads).toMatchObject({ status: 'observed', lookups: [0, -1, -1] });
    expect(capture.planReads.readFrameSha256).toBe(
      h.captures[0]!.readFrame && (h.captures[0]!.readFrame as any).sha256
    );
    expect(horsePlanReadsAreValid(capture.planReads, capture.snapshot, capture.readFrame)).toBe(
      true
    );
  } finally {
    await h.close();
  }
});

it('refuses forged input, original observer/frame/value, extra fields and missing original evidence', () => {
  const r = original(),
    f = frameOf(r, false),
    c = new HorsePlanReadCapture(r);
  c.note('barrel', f.key, r.player.user_id, 'flop', false);
  const receipt = c.finish(f.frame.sha256)!;
  expect(horsePlanReadsAreValid(receipt, r, f.frame)).toBe(true);
  for (const changed of [
    { ...receipt, inputSha256: 'a'.repeat(64) },
    { ...receipt, readFrameSha256: 'b'.repeat(64) },
    { ...receipt, lookups: [2, -1, -1] },
    { ...receipt, lookups: [1, 0, -1] },
    { ...receipt, privatePlan: {} },
  ])
    expect(horsePlanReadsAreValid(changed, r, f.frame)).toBe(false);
  expect(horsePlanReadsAreValid(undefined, r, f.frame)).toBe(false);
  expect(horsePlanReadsAreValid(receipt, r, null)).toBe(false);
  const other = structuredClone(r);
  other.player.user_id = '55555555-5555-4555-8555-555555555555';
  expect(horsePlanReadsAreValid(receipt, other, f.frame)).toBe(false);
  const wrong = new HorsePlanReadCapture(r);
  wrong.note('barrel', f.key, other.player.user_id, 'flop', false);
  expect(wrong.finish(f.frame.sha256)).toMatchObject({ status: 'refused', lookups: [-1, -1, -1] });
});

it('keeps unsupported boards outside the domain and marks an actual getter exception refused', () => {
  const r = original();
  r.gameState.boardCount = 2;
  r.decisionKey = buildHorseDecisionKey(r);
  const f = frameOf(r),
    c = new HorsePlanReadCapture(r);
  c.note('barrel', f.key, r.player.user_id, 'flop', undefined);
  expect(c.finish(f.frame.sha256)).toMatchObject({
    status: 'outside_domain',
    lookups: [-1, -1, -1],
  });
  expect(horsePlanReadsAreValid(c.finish(f.frame.sha256), r, f.frame)).toBe(true);
  const normal = original(),
    g = frameOf(normal),
    failed = new HorsePlanReadCapture(normal);
  vi.spyOn(HorseMind, 'getPlan').mockImplementationOnce(() => {
    throw Error('isolated getter failure');
  });
  expect(choose(normal, g.view, failed).value.policyFallback).toBe('brain_exception');
  expect(failed.finish(g.frame.sha256)).toMatchObject({ status: 'refused', lookups: [-1, -1, -1] });
});

it('journals a real later getter hit after exact controller acceptance and actual worker effect commit', async () => {
  const h = workerHarness();
  try {
    const first = decisionRequest();
    first.decisionTimeMs = Date.now() + 1000;
    first.decisionKey = buildHorseDecisionKey(first);
    const issued = await h.fast(first);
    const controller = new HandController(
      {
        tableId: first.fence.split(':')[0]!,
        handNumber: 1000100,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      },
      structuredClone(first.gameState.players),
      2
    );
    // Isolated original public action node; the actual controller owns acceptance.
    Object.assign(
      (controller as unknown as { state: GameState }).state,
      structuredClone(first.gameState)
    );
    let accepted: Readonly<ActionRecord> | undefined;
    expect(
      controller.performAction(
        first.player.seat,
        issued.decision.action,
        issued.decision.amount,
        'horse_policy',
        (record) => {
          accepted = record;
        }
      )
    ).toBe(true);
    expect(accepted).toMatchObject({ action: 'bet', amount: 6 });
    const commit = commitOf(issued, 200);
    commit.acceptance = horsePlanAcceptanceFromController(
      accepted,
      { action: 'bet', amount: 6 },
      { requestId: issued.requestId, decisionKey: issued.planBinding.decisionKey }
    );
    h.runtime.receive(commit);
    await h.runtime.drain();
    expect(h.applied()).toBe(1);
    h.deps.decide = (...args) => HorseLogic.decide(...args);
    const next = decisionRequest();
    next.requestId = 201;
    next.generation = 101;
    next.fence = next.fence.replace(/:100$/, ':101');
    next.decisionTimeMs = first.decisionTimeMs + 1;
    next.player.bet = 6;
    next.player.stack = 88;
    next.player.totalInvested = 12;
    Object.assign(next.gameState, {
      pot: 38,
      contestablePot: 38,
      pots: [{ amount: 38, eligiblePlayers: next.gameState.players.map((p) => p.user_id) }],
      currentBet: 20,
      toCall: 14,
      minRaise: 14,
      lastRaise: 14,
      minRaiseTo: 34,
      maxRaiseTo: 94,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
    });
    next.gameState.players[0] = { ...next.player, cards: [] };
    Object.assign(next.gameState.players[1]!, { bet: 20, stack: 74, totalInvested: 26 });
    next.gameState.actionHistory!.push(
      { ...accepted!, timestamp: 1700009900001 },
      {
        seat: 2,
        userId: next.gameState.players[1]!.user_id,
        stage: 'flop',
        action: 'raise',
        amount: 20,
        isFullRaise: true,
        timestamp: 1700009900002,
      }
    );
    next.handJournalContext = captureHorseHandJournalContext(next.gameState.actionHistory!);
    next.decisionKey = buildHorseDecisionKey(next);
    await h.fast(next);
    const retained = h.captures.at(-1)! as any;
    expect(retained.planReads).toMatchObject({ status: 'observed', lookups: [2, -1, 3] });
    expect(horsePlanReadsAreValid(retained.planReads, retained.snapshot, retained.readFrame)).toBe(
      true
    );
    const serialized = JSON.parse(JSON.stringify(retained));
    expect(
      horsePlanReadsAreValid(serialized.planReads, serialized.snapshot, serialized.readFrame)
    ).toBe(true);
  } finally {
    await h.close();
  }
});
