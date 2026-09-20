import { describe, expect, it } from 'vitest';
import { completedHandActionsForMind } from '../../../engine/horseDecision/completedHandActions.js';

const controller = () => ({
  seat: 2,
  userId: 'opponent',
  action: 'raise',
  amount: 6,
  stage: 'preflop',
  timestamp: 1700000000123,
  isFullRaise: true,
});

describe('accepted list to controller-compatible opponent action stream', () => {
  it('preserves ordered controller scalars without changing the full-list ordinals or owned input', () => {
    const input = [
      {
        seat: 1,
        userId: 'poster',
        action: 'sb',
        amount: 1,
        timestamp: 1700000000000,
        stage: 'preflop',
        origin: 'forced',
      },
      { ...controller(), observationIdentity: { version: 1, actionOrdinal: 1 } },
      {
        ...controller(),
        seat: 3,
        userId: 'caller',
        action: 'call',
        amount: 6,
        timestamp: 1700000000456,
        isFullRaise: undefined,
      },
      {
        seat: 2,
        userId: 'opponent',
        action: 'return',
        amount: 2,
        timestamp: 1700000000500,
        stage: 'river',
        historyEvent: 'uncalled_bet_returned',
      },
      { seat: 0, userId: 'system', action: 'rit_board_2:As,Ks,Qs,Js,Ts', stage: 'river' },
    ];
    const before = structuredClone(input);
    input.forEach(Object.freeze);
    Object.freeze(input);
    const result = completedHandActionsForMind(input, 'omaha:short');
    expect(result?.actions).toEqual([
      controller(),
      {
        seat: 3,
        userId: 'caller',
        action: 'call',
        amount: 6,
        stage: 'preflop',
        timestamp: 1700000000456,
      },
    ]);
    expect(result?.scope).toBe('omaha:short');
    expect(input).toEqual(before);
    expect(result?.actions[0]).not.toBe(input[1]);
    expect(input[1]).toHaveProperty('observationIdentity.actionOrdinal', 1);
    expect(result?.actions[0]).not.toHaveProperty('observationIdentity');
  });

  it.each([
    'sb',
    'bb',
    'ante',
    'straddle',
    'return',
    'insurance_buy',
    'insurance_payout',
    'rit_board_3:As,Ks,Qs,Js,Ts',
  ])('keeps %s outside the controller-keyed stream', (action) => {
    expect(completedHandActionsForMind([{ action }, controller()], null)?.actions).toEqual([
      controller(),
    ]);
  });

  it('retains discard and the exact short-all-in flag without classifying strategy', () => {
    const actions = [
      {
        ...controller(),
        action: 'discard',
        amount: 0,
        stage: 'pineapple_discard',
        isFullRaise: undefined,
      },
      {
        ...controller(),
        action: 'all_in',
        amount: 9,
        timestamp: 1700000000999,
        isFullRaise: false,
      },
    ];
    expect(completedHandActionsForMind(actions, 'holdem:hu')?.actions).toEqual([
      {
        seat: 2,
        userId: 'opponent',
        action: 'discard',
        amount: 0,
        stage: 'pineapple_discard',
        timestamp: 1700000000123,
      },
      actions[1],
    ]);
  });

  const malformed = [
    ['missing actor', { userId: undefined }],
    ['empty actor', { userId: '' }],
    ['coerced actor', { userId: ['opponent'] }],
    ['oversize actor', { userId: 'x'.repeat(257) }],
    ['zero seat', { seat: 0 }],
    ['unsupported seat', { seat: 11 }],
    ['coerced seat', { seat: '2' }],
    ['missing clock', { timestamp: undefined }],
    ['coerced clock', { timestamp: '1700000000123' }],
    ['nonfinite clock', { timestamp: NaN }],
    ['negative clock', { timestamp: -1 }],
    ['missing amount', { amount: undefined }],
    ['coerced amount', { amount: '6' }],
    ['infinite amount', { amount: Infinity }],
    ['negative amount', { amount: -1 }],
    ['coerced stage', { stage: ['preflop'] }],
    ['coerced raise flag', { isFullRaise: [true] }],
  ] as const;
  it.each(malformed)(
    'refuses the whole new stream for %s, including a valid earlier record',
    (_label, patch) => {
      expect(
        completedHandActionsForMind([controller(), { ...controller(), ...patch }], 'holdem:hu')
      ).toBeNull();
    }
  );
  it.each(
    [[], ['holdem:hu'], 'omaha:cash', 'unknown:full', 'HOLDEM:hu', false].map((scope) => ({
      scope,
    }))
  )('refuses an invalid scope without coercion: $scope', ({ scope }) => {
    expect(completedHandActionsForMind([controller()], scope)).toBeNull();
  });
  it.each(
    [undefined, [], Array(4097).fill(controller()), [null], [{ action: ['call'] }]].map(
      (actions) => ({ actions })
    )
  )('refuses incomplete or oversized input %#', ({ actions }) => {
    expect(completedHandActionsForMind(actions, null)).toBeNull();
  });
  it('accepts the existing 4096-record ceiling and absent scope as explicitly pooled', () => {
    const result = completedHandActionsForMind(Array(4096).fill(controller()), undefined);
    expect(result?.actions).toHaveLength(4096);
    expect(result?.scope).toBeNull();
  });
});
