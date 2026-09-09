import { describe, expect, it } from 'vitest';
import { launchStacksMeetFundingFloor } from './tournamentLaunchStackProof.js';

describe('tournament launch stack conservation', () => {
  it.each([
    [[1_500, 1_500], 1_500],
    [[1_600, 1_500], 1_500],
  ])('accepts an ordinary field at or above its funded floor', (stacks, starting) => {
    expect(launchStacksMeetFundingFloor(stacks, starting)).toBe(true);
  });

  it('accepts redistributed stacks only under an exact-total recovery contract', () => {
    expect(launchStacksMeetFundingFloor([0, 1_000, 2_000], 1_000, 3, true)).toBe(true);
    expect(launchStacksMeetFundingFloor([0, 3_000], 1_500, 2, true)).toBe(true);
    expect(launchStacksMeetFundingFloor([0, 3_001], 1_500, 2, true)).toBe(false);
  });

  it('keeps the busted and vacated third Spin stack in the funding floor', () => {
    expect(launchStacksMeetFundingFloor([1_000, 2_000], 1_000, 3, true)).toBe(true);
    expect(launchStacksMeetFundingFloor([999, 2_000], 1_000, 3, true)).toBe(false);
    expect(launchStacksMeetFundingFloor([1_001, 2_000], 1_000, 3, true)).toBe(false);
  });

  it.each([
    [[0, 999, 2_000], 1_000],
    [[0, 2_999], 1_500],
    [[-1, 1_001], 500],
    [[Number.NaN, 3_000], 1_500],
  ])('refuses an underfunded or impossible field', (stacks, starting) => {
    expect(launchStacksMeetFundingFloor(stacks, starting)).toBe(false);
  });

  it('refuses a funded-seat count smaller than the roster being proved', () => {
    expect(launchStacksMeetFundingFloor([1_000, 1_000], 1_000, 1)).toBe(false);
  });
});
