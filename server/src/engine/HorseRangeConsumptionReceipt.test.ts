import { beforeEach, describe, expect, it } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom, saveFastRandom, simulateEquity, variantInfo } from './HorseEval.js';
import { horseVariantRulesFor } from './VariantRules.js';
import { calculatePots } from './PokerEngine.js';
import { buildHorseDecisionKey, type FastHorseDecisionRequest } from './horseDecision/protocol.js';
import { captureHorseHandJournalContext } from './HorseDecisionHandBinding.js';
import { decisionRequest } from '../testing/horseRegression/plan/fixture.js';
import {
  HorseRangeConsumptionCapture,
  horseRangeConsumptionIsValid,
  HORSE_RANGE_RECEIPT_MAX_BYTES,
} from './HorseRangeConsumptionReceipt.js';
import type { ActionRecord, Card } from '../types.js';
const variants = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'] as const;
const frame = 'a'.repeat(64);
const cards = (text: string): Card[] =>
  text.split(' ').map(
    (c) =>
      ({
        rank: c[0],
        suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[c[1] as 'c'],
      }) as Card
  );
export function rangeRequest(
  variant: (typeof variants)[number] = 'nlh',
  raise = false
): FastHorseDecisionRequest {
  const r = decisionRequest(),
    g = r.gameState;
  const thirdId = '33333333-3333-4333-8333-333333333333';
  r.player.cards = cards(
    variant === 'nlh'
      ? 'Ah Kh'
      : variant === 'plo6'
        ? 'Ah Kh 5c 6d Tc Js'
        : variant === 'plo5'
          ? 'Ah Kh 5c 6d Tc'
          : 'Ah Kh 5c 6d'
  );
  Object.assign(r.player, { stack: 200, totalInvested: 16 });
  g.players = [
    { ...r.player, cards: [] },
    { ...g.players[1]!, stack: 0, bet: 40, totalInvested: 56, is_all_in: true },
    {
      ...g.players[1]!,
      seat: 3,
      user_id: thirdId,
      stack: 300,
      bet: raise ? 20 : 60,
      totalInvested: raise ? 36 : 76,
    },
  ];
  Object.assign(g, {
    gameVariant: variant,
    variantRules: horseVariantRulesFor(variant),
    bettingStructure: variant === 'nlh' ? 'no_limit' : 'pot_limit',
    stage: 'turn',
    communityCards: cards('Qc 9s 4d 2h'),
    dealtSeatIds: [1, 2, 3],
    currentBet: raise ? 40 : 60,
    toCall: raise ? 40 : 60,
    minRaiseTo: raise ? 60 : 120,
    maxRaiseTo: 200,
    pot: raise ? 108 : 148,
    contestablePot: raise ? 108 : 148,
  });
  g.pots = calculatePots(g.players);
  const a = (
    seat: number,
    action: ActionRecord['action'],
    amount: number,
    stage: ActionRecord['stage']
  ): ActionRecord => ({
    seat,
    userId: g.players[seat - 1]!.user_id,
    action,
    amount,
    stage,
    timestamp: 1700009000000 + g.actionHistory!.length,
  });
  g.actionHistory = [
    a(1, 'raise', 6, 'preflop'),
    a(2, 'call', 6, 'preflop'),
    a(3, 'call', 6, 'preflop'),
    a(2, 'bet', 10, 'flop'),
    a(3, 'call', 10, 'flop'),
    a(1, 'call', 10, 'flop'),
    a(3, 'bet', raise ? 20 : 60, 'turn'),
    a(2, 'all_in', 40, 'turn'),
  ];
  r.opts = {
    phase7Utility: false,
    phase8Postflop: 'off',
    phase10Plo4: 'off',
    phase11Omaha: 'off',
    phase12Remaining: 'off',
    phase13Joint: 'off',
    v31GtoSuitAware: false,
  };
  r.handJournalContext = captureHorseHandJournalContext(g.actionHistory);
  r.decisionKey = buildHorseDecisionKey(r);
  return r;
}
function choose(r: FastHorseDecisionRequest, capture?: HorseRangeConsumptionCapture) {
  HorseMind.reset();
  seedFastRandom(17);
  const result = HorseMind.captureDecisionEffects(() =>
    HorseLogic.decide(r.player, r.gameState, r.style, r.mods, r.opts, capture)
  );
  return {
    action: result.value.action,
    amount: result.value.amount,
    thinkTime: result.value.thinkTime,
    fallback: result.value.policyFallback,
    effects: result.effects,
    rng: saveFastRandom(),
  };
}
beforeEach(() => HorseMind.reset());

describe.each(variants)('%s producer-time public range consumption', (variant) => {
  it.each([false, true])(
    'retains exact action/effects/RNG and observes actual all-in raise=%s conditioning',
    (raise) => {
      const r = rangeRequest(variant, raise),
        capture = new HorseRangeConsumptionCapture(r);
      const control = choose(r),
        observed = choose(r, capture);
      expect(observed).toEqual(control);
      expect(observed.fallback).not.toBe('brain_exception');
      const receipt = capture.finish(frame)!;
      expect(horseRangeConsumptionIsValid(receipt, r, frame)).toBe(true);
      expect(receipt.status).toBe('observed');
      const call = receipt.calls[0]!,
        opponent = call.opponents[0]!;
      expect(call.samples).toBeGreaterThan(0);
      expect(opponent[0]).toBe(1);
      expect(opponent[5] === 1).toBe(raise);
      expect(opponent[11] & 1).toBe(1);
      expect(opponent[11] & 4).toBe(4);
      if (variant === 'nlh') expect(opponent[10]).toBeNull();
      else expect(opponent[10]).toBe(raise ? 3 : 1);
      expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(
        HORSE_RANGE_RECEIPT_MAX_BYTES
      );
      expect(JSON.stringify(receipt)).not.toContain(r.player.user_id);
    }
  );
});

it('captures the values actually supplied after V16/V40 stripping', () => {
  const r = rangeRequest('plo5', true);
  Object.assign(r.opts!, { v16SizeCond: false, v40Omaha: false });
  const capture = new HorseRangeConsumptionCapture(r);
  choose(r, capture);
  const row = capture.finish(frame)!.calls[0]!.opponents[0]!;
  expect(row[5]).toBe(0);
  expect(row[6]).toBeNull();
  expect(row[10]).toBeNull();
  expect(row[11] & 8).toBe(0);
});

it('captures per-board demotion rather than advertising the single-board Omaha tier', () => {
  const r = rangeRequest('plo4', true);
  r.gameState.communityCards2 = cards('8c 7d 3h 2s');
  r.decisionKey = buildHorseDecisionKey(r);
  const capture = new HorseRangeConsumptionCapture(r);
  expect(choose(r, capture)).toEqual(choose(r));
  const receipt = capture.finish(frame)!;
  expect(receipt.calls.map((c) => c.board)).toEqual([0, 1]);
  for (const c of receipt.calls) {
    expect(c.opponents[0]![5]).toBe(1);
    expect(c.opponents[0]![6]).toBeNull();
    expect(c.opponents[0]![10]).toBeNull();
    expect(c.opponents[0]![11] & 8).toBe(0);
  }
});

it('keeps unavailable and malformed binding evidence unknown', () => {
  const r = rangeRequest(),
    capture = new HorseRangeConsumptionCapture(r);
  choose(r, capture);
  const receipt = capture.finish(frame)!;
  expect(horseRangeConsumptionIsValid(undefined, r, frame)).toBe(false);
  for (const changed of [
    { ...r, decisionTimeMs: r.decisionTimeMs + 1 },
    { ...r, player: { ...r.player, user_id: r.gameState.players[1]!.user_id } },
    { ...r, gameState: { ...r.gameState, stage: 'river' as const } },
    { ...r, gameState: { ...r.gameState, gameVariant: 'plo8' } },
    { ...r, gameState: { ...r.gameState, players: [...r.gameState.players].reverse() } },
  ])
    expect(horseRangeConsumptionIsValid(receipt, changed, frame)).toBe(false);
  expect(horseRangeConsumptionIsValid(receipt, r, 'b'.repeat(64))).toBe(false);
  expect(horseRangeConsumptionIsValid({ ...receipt, extra: true }, r, frame)).toBe(false);
});

it('distinguishes actual sampler reach from inputs delivered to an early-terminated opponent loop', () => {
  const r = rangeRequest();
  r.player.cards = cards('2c 3d');
  r.gameState.communityCards = cards('Jc Jd Jh Js 2d');
  r.gameState.stage = 'river';
  // These five visible cards on the other physical board remove every
  // remaining 2/3 kicker. The first opponent must beat hero on every draw.
  r.gameState.communityCards2 = cards('2h 2s 3c 3h 3s');
  const capture = new HorseRangeConsumptionCapture(r);
  const out = capture.begin(
    0,
    r.gameState.players,
    r.gameState.players.slice(1),
    2,
    undefined,
    undefined
  )!;
  seedFastRandom(1);
  simulateEquity(
    r.player.cards,
    r.gameState.communityCards,
    2,
    variantInfo('nlh'),
    60,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    r.gameState.communityCards2,
    out
  );
  const receipt = capture.finish(frame)!;
  expect(receipt.calls[0]!.samples).toBe(60);
  expect(receipt.calls[0]!.opponents[0]![11]).toBe(1);
  expect(receipt.calls[0]!.opponents[1]![11]).toBe(0);
});

it('records an invalid physical deck as no sampled inputs', () => {
  const r = rangeRequest('plo6');
  const capture = new HorseRangeConsumptionCapture(r);
  const out = capture.begin(
    0,
    r.gameState.players,
    r.gameState.players.slice(1),
    2,
    undefined,
    undefined
  )!;
  simulateEquity(
    r.player.cards,
    r.gameState.communityCards,
    9,
    variantInfo('plo6'),
    60,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    [],
    out
  );
  const call = capture.finish(frame)!.calls[0]!;
  expect(call.status).toBe('invalid_deck');
  expect(call.samples).toBe(0);
  expect(call.opponents.every((row) => row[11] === 0 && row[10] === null)).toBe(true);
});

it('refuses a fourth call instead of retaining an unbounded trace', () => {
  const r = rangeRequest(),
    capture = new HorseRangeConsumptionCapture(r);
  for (let i = 0; i < 4; i++)
    capture.begin(i, r.gameState.players, r.gameState.players.slice(1), 2, undefined, undefined);
  expect(capture.finish(frame)).toBeUndefined(); // unsampled/malformed calls never promoted
});

it('records the actual adaptive checkpoint rather than the granted iteration budget', () => {
  const r = rangeRequest();
  r.player.cards = cards('2c 3d');
  r.gameState.communityCards = cards('Jc Jd Jh Js 2d');
  r.gameState.communityCards2 = cards('2h 2s 3c 3h 3s');
  r.gameState.stage = 'river';
  const capture = new HorseRangeConsumptionCapture(r);
  const out = capture.begin(
    0,
    r.gameState.players,
    r.gameState.players.slice(1),
    2,
    undefined,
    undefined
  )!;
  seedFastRandom(1);
  simulateEquity(
    r.player.cards,
    r.gameState.communityCards,
    2,
    variantInfo('nlh'),
    60,
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    r.gameState.communityCards2,
    out
  );
  expect(capture.finish(frame)!.calls[0]!.samples).toBe(30);
});

it('bounds the maximum three-board nine-opponent representation to four KiB', () => {
  const r = rangeRequest();
  r.gameState.players = [
    r.gameState.players[0]!,
    ...Array.from({ length: 9 }, (_, i) => ({
      ...r.gameState.players[1]!,
      seat: i + 2,
      user_id: `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`,
    })),
  ];
  r.gameState.communityCards2 = cards('8c 7d 3h 2s');
  r.gameState.communityCards3 = cards('Ac Kd Qh Js');
  const capture = new HorseRangeConsumptionCapture(r);
  const reads = Array.from({ length: 9 }, () => ({
    aggrW: 0.12345678901234567,
    checked: 3,
    bigBet: true,
    streets: 3,
    lastFrac: 1.2345678901234567e300,
    raised: true,
    strictPressureRange: true,
  }));
  const bands: Array<[number, number]> = Array.from({ length: 9 }, () => [
    0.12345678901234567, 0.9876543210987654,
  ]);
  for (let i = 0; i < 3; i++) {
    const call = capture.begin(
      i,
      r.gameState.players,
      r.gameState.players.slice(1),
      9,
      bands,
      reads
    )!;
    call.samples = 2147483647;
    call.reachedMask = call.bandMask = call.conditionedMask = call.bigBetMask = 511;
  }
  const receipt = capture.finish(frame)!;
  expect(receipt.calls).toHaveLength(3);
  expect(receipt.calls.every((c) => c.opponents.length === 9)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(4096);
  expect(
    horseRangeConsumptionIsValid(
      { ...receipt, calls: [...receipt.calls, receipt.calls[0]] },
      r,
      frame
    )
  ).toBe(false);
});
