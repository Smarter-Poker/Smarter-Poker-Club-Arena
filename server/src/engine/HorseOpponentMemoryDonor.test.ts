/**
 * A NEW TABLE IS NOT A NEW PLAYER (2026-10-24, Dan: "USE ANY AND ALL PLAYER
 * DATA ON THE VERY FIRST HAND"). A thin or missing exact context borrows the
 * same player's other multiway bucket (same variant, same mode) at reduced
 * weight; heads-up and the cash/tournament split stay isolated; a rich exact
 * bucket is never diluted; and the second look sees what the first saw.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HorseMind, readScopeOf } from './HorseMind.js';
import {
  decayAndAdd,
  exploitHandIncrements,
  freshExploitCounters,
  type ExploitCounters,
} from './HorseOpponentExploit.js';
import {
  blendOpponentMemory,
  opponentMemoryDonors,
  opponentMemoryKey,
  OPPONENT_MEMORY_DONOR_WEIGHT,
  OPPONENT_MEMORY_THIN_HANDS,
  type MemoryMode,
  type MemorySize,
} from './HorseOpponentMemory.js';
import { decodeHorseDecisionReads, encodeHorseDecisionReads } from './HorseDecisionReadFrame.js';

const uid = '40000000-0000-4000-8000-0000000000d1';
function raiser(hands: number): ExploitCounters {
  const counters = freshExploitCounters();
  const inc = exploitHandIncrements([{ userId: uid, action: 'raise', stage: 'preflop' }]).get(uid)!;
  for (let n = 0; n < hands; n++) decayAndAdd(counters, inc);
  return counters;
}
function folder(hands: number): ExploitCounters {
  const counters = freshExploitCounters();
  const inc = exploitHandIncrements([
    { userId: 'opener', action: 'raise', stage: 'preflop' },
    { userId: uid, action: 'fold', stage: 'preflop' },
  ]).get(uid)!;
  for (let n = 0; n < hands; n++) decayAndAdd(counters, inc);
  return counters;
}
function remember(size: MemorySize, counters: ExploitCounters, mode: MemoryMode = 'cash') {
  HorseMind.importDurableOpponentProfiles([
    {
      user_id: uid,
      variant: 'nlh',
      mode,
      size,
      observed_hands: Math.round(counters.hands),
      initialized: true,
      counters,
    },
  ]);
}
afterEach(() => {
  HorseMind.setDecisionScope(null);
  HorseMind.reset();
});

describe('donor policy', () => {
  it('multiway borrows the other multiway size in the same mode; heads-up borrows nothing', () => {
    expect(opponentMemoryDonors('cash', 'full')).toEqual([['cash', 'short']]);
    expect(opponentMemoryDonors('cash', 'short')).toEqual([['cash', 'full']]);
    expect(opponentMemoryDonors('tournament', 'full')).toEqual([['tournament', 'short']]);
    expect(opponentMemoryDonors('cash', 'hu')).toEqual([]);
  });
  it('a rich exact bucket is used untouched; a thin one is topped up at the donor weight', () => {
    const rich = raiser(40);
    expect(rich.hands).toBeGreaterThanOrEqual(OPPONENT_MEMORY_THIN_HANDS);
    expect(blendOpponentMemory(rich, [raiser(80)])).toBe(rich);
    const thin = raiser(3);
    const donor = raiser(60);
    const blended = blendOpponentMemory(thin, [donor])!;
    expect(blended.hands).toBeCloseTo(thin.hands + OPPONENT_MEMORY_DONOR_WEIGHT * donor.hands, 9);
    expect(blended.pfr).toBeCloseTo(thin.pfr + OPPONENT_MEMORY_DONOR_WEIGHT * donor.pfr, 9);
    expect(blendOpponentMemory(undefined, [undefined])).toBeUndefined();
    expect(blendOpponentMemory(undefined, [donor])!.hands).toBeCloseTo(
      OPPONENT_MEMORY_DONOR_WEIGHT * donor.hands,
      9
    );
  });
});

describe('the first hand at a new-size table is not a cold read', () => {
  it('a raiser known only short-handed is read on their first six-max hand', () => {
    remember('short', raiser(60));
    HorseMind.setDecisionScope(readScopeOf('nlh', 6), 'nlh', 'cash');
    expect(HorseMind.opponentRead(uid)?.stats.pfr.engaged).toBe('high');
    // Before this fix the exact bucket alone answered: nothing known, no read.
    expect(HorseMind.hasDurableOpponentProfile(uid, 'nlh', 'cash', 'full')).toBe(false);
  });
  it('the exact context still wins once it has its own evidence', () => {
    remember('short', raiser(60));
    remember('full', folder(60));
    HorseMind.setDecisionScope(readScopeOf('nlh', 6), 'nlh', 'cash');
    expect(HorseMind.opponentRead(uid)?.stats.pfr.engaged ?? null).not.toBe('high');
  });
  it('heads-up and tournament play stay isolated', () => {
    remember('short', raiser(60));
    HorseMind.setDecisionScope(readScopeOf('nlh', 2), 'nlh', 'cash');
    expect(HorseMind.opponentRead(uid)).toBeNull();
    HorseMind.setDecisionScope(readScopeOf('nlh', 6), 'nlh', 'tournament');
    expect(HorseMind.opponentRead(uid)).toBeNull();
  });
  it('the second look carries the donor and reads exactly what the first did', () => {
    remember('short', raiser(60));
    HorseMind.setDecisionScope(readScopeOf('nlh', 6), 'nlh', 'cash');
    const first = HorseMind.opponentRead(uid);
    expect(first).not.toBeNull();
    HorseMind.setDecisionScope(null);
    const players = [{ user_id: uid }];
    const view = HorseMind.snapshotDecisionReads(players as never, null, {
      variant: 'nlh',
      mode: 'cash',
      size: 'full',
    });
    expect(view.exploit.has(opponentMemoryKey(uid, 'nlh', 'cash', 'short'))).toBe(true);
    const restored = decodeHorseDecisionReads(
      encodeHorseDecisionReads(view, players as never, null),
      players as never,
      null
    );
    HorseMind.runInSandbox(restored, () => {
      HorseMind.setDecisionScope(readScopeOf('nlh', 6), 'nlh', 'cash');
      expect(HorseMind.opponentRead(uid)).toEqual(first);
      HorseMind.setDecisionScope(null);
    });
  });
});
