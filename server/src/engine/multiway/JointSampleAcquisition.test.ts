import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreFastRandom, saveFastRandom, seedFastRandom } from '../HorseEval.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import { jointPolicyFixture, jointFixture } from './JointRangeFixture.test-support.js';
import * as sampler from './JointRangeSampler.js';
import {
  acquireJointSamples,
  jointFullSamples,
  jointSampleAcquisitionMatches,
  JOINT_SAMPLE_WORK_BUDGET_MS,
} from './JointSampleAcquisition.js';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';

afterEach(() => vi.restoreAllMocks());
type State = ReturnType<typeof jointPolicyFixture>;

describe('decision-local shared joint acquisition', () => {
  it.each([2, 3])('acquires immutable %i-board samples independently of Phase13 mode', (boards) => {
    const { hero, state, baseline } = jointPolicyFixture('nlh', boards, 'tournament', 'river');
    seedFastRandom(71001);
    const before = saveFastRandom();
    const acquired = acquireJointSamples(hero, state, { now: () => 0 });
    expect(acquired.status, acquired.reason).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error(acquired.reason);
    expect(acquired.evidence.samples).toHaveLength(16);
    expect(acquired.evidence.samples.every((s) => s.boards.length === boards)).toBe(true);
    expect(acquired.provenance).toMatchObject({
      version: 'horse-joint-sampler-provenance-v1',
      samplerVersion: sampler.JOINT_RANGE_PACK.version,
      stateKey: sampler.jointStateKey(hero, state),
      layout: 'independent',
      sharedPrefixLength: 0,
      boardCount: boards,
      requestedSamples: 16,
      completedSamples: 16,
      sampleBudgetExhausted: false,
      rangeModel: { confidence: 'heuristic_uncalibrated' },
    });
    expect(acquired.provenance.physicalCardsPerSample).toBe(8 + boards * 5);
    expect(acquired.provenance.unknownDealtCardsPerSample).toBe(6);
    expect(saveFastRandom()).toBe(before);
    expect(jointSampleAcquisitionMatches(hero, state, acquired)).toBe(true);
    expect(Object.isFrozen(acquired)).toBe(true);
    expect(() => acquired.evidence.samples[0].boards[0].opponentHigh.push(0)).toThrow();
    expect(() => acquired.evidence.opponentIds.reverse()).toThrow();
    expect(() => {
      acquired.evidence.ranges[0].raises = 999;
    }).toThrow();
    expect(Object.isFrozen(acquired.provenance.rangeModel)).toBe(true);
    expect(Object.isFrozen(state)).toBe(false);
    expect(JSON.stringify(acquired)).not.toContain('"rank"');
    const off = evaluateJointLivePolicy(hero, state, baseline, 'off', () => 0, acquired);
    expect(off.receipt.reason).toBe('off');
    expect(off.jointEvidence).toBeNull();
  });

  it('rejects copied bridges and binds actual cards, history, commitments and rules', () => {
    const { hero, state } = jointPolicyFixture();
    const acquired = acquireJointSamples(hero, state, { now: () => 0 });
    expect(acquired.status).toBe('acquired');
    expect(jointSampleAcquisitionMatches(hero, state, { ...acquired })).toBe(false);
    expect(jointSampleAcquisitionMatches(hero, state, structuredClone(acquired))).toBe(false);
    const equal = structuredClone({ hero, state });
    expect(jointSampleAcquisitionMatches(equal.hero, equal.state, acquired)).toBe(true);
    for (const mutate of [
      (v: typeof equal) => {
        v.hero.cards[0].rank = v.hero.cards[0].rank === '2' ? '3' : '2';
      },
      (v: typeof equal) => {
        v.state.players[1].stack += 1;
      },
      (v: typeof equal) => {
        v.state.players[1].stack = Number.NaN;
      },
      (v: typeof equal) => {
        v.state.boardCount = 1;
      },
      (v: typeof equal) => {
        v.state.actionHistory!.push({
          userId: 'p1',
          seat: 2,
          stage: 'flop',
          action: 'check',
          amount: 0,
          timestamp: 1,
        });
      },
      (v: typeof equal) => {
        v.state.tournament = {
          ...v.state.tournament!,
          prizePool: 999,
        } as typeof v.state.tournament;
      },
    ]) {
      const changed = structuredClone({ hero, state });
      mutate(changed);
      expect(jointSampleAcquisitionMatches(changed.hero, changed.state, acquired)).toBe(false);
    }
  });

  // Every named refusal the acquisition owner can return is pinned here or in
  // the neighbouring tests; previously these six had no test at all.
  it.each([
    [
      'outside_betting_street',
      (s: State) => {
        s.state.stage = 'showdown' as never;
      },
    ],
    [
      'no_opponent',
      (s: State) => {
        for (const p of s.state.players) if (p.user_id !== s.hero.user_id) p.is_folded = true;
      },
    ],
    [
      'heads_up_owned_by_variant_policy',
      (s: State) => {
        Object.assign(s.state, { bombPot: false, boardCount: 1, communityCards2: undefined });
        const live = s.state.players.filter((p) => p.user_id !== s.hero.user_id && !p.is_folded);
        for (const p of live.slice(1)) p.is_folded = true;
      },
    ],
    [
      'seats_outside_launch_domain',
      (s: State) => {
        // Six-card Omaha deals at most seven tournament seats from one deck.
        const large = jointFixture('plo6', 'river', 2, 9);
        Object.assign(s.state, {
          gameVariant: 'plo6',
          bettingStructure: 'pot_limit',
          players: large.state.players,
          dealtSeatIds: large.state.dealtSeatIds,
        });
      },
    ],
    [
      'button_unavailable',
      (s: State) => {
        s.state.dealerSeat = 0;
      },
    ],
    [
      'history_budget',
      (s: State) => {
        s.state.actionHistory = Array.from({ length: 257 }, (_, timestamp) => ({
          userId: 'p1',
          seat: 2,
          stage: 'flop' as const,
          action: 'check' as const,
          amount: 0,
          timestamp,
        }));
      },
    ],
  ] as const)('refuses %s by name before sampling', (reason, mutate) => {
    const fixture = jointPolicyFixture('nlh', 2, 'tournament', 'river');
    const draw = vi.spyOn(sampler, 'sampleJointRanges');
    mutate(fixture);
    const result = acquireJointSamples(fixture.hero, fixture.state, { now: () => 0 });
    expect(result.status).toBe('refused');
    expect(result.reason).toBe(reason);
    expect(result.provenance).toBeNull();
    expect(draw).not.toHaveBeenCalled();
  });

  it('keeps the large-table minimum and returns named refusals without relaxing the domain', () => {
    const { hero, state } = jointPolicyFixture();
    const large = jointFixture('nlh', 'flop', 2, 5);
    Object.assign(state, {
      players: large.state.players,
      dealtSeatIds: large.state.dealtSeatIds,
      pot: 25,
    });
    const result = acquireJointSamples(hero, state, { now: () => 0 });
    expect(result.status, result.reason).toBe('acquired');
    expect(result.requestedSamples).toBe(8);
    expect(result.evidence?.samples).toHaveLength(8);
    state.players[1].cards = hero.cards;
    expect(acquireJointSamples(hero, state, { now: () => 0 }).reason).toBe(
      'private_state_rejected'
    );
    state.players[1].cards = [];
    state.communityCards2![0] = state.communityCards[0];
    expect(acquireJointSamples(hero, state, { now: () => 0 }).reason).toBe(
      'joint_samples_unavailable'
    );
  });

  it('draws the declared population whatever the clock or the governor says, and measures it', () => {
    // 2026-10-11: the live acquisition does the fixed work the P13.2 matrix
    // priced. No clock stops the sampler and the equity governor never scales
    // the request; the clock only measures samplingMs.
    const { hero, state } = jointPolicyFixture();
    const withoutClock = (a: ReturnType<typeof acquireJointSamples>) =>
      JSON.stringify({ ...a, samplingMs: 0, evidence: { ...a.evidence, analysisMs: 0 } });
    const rng = saveFastRandom();
    const fixed = acquireJointSamples(hero, state, { now: () => 0 });
    expect(fixed.status, fixed.reason).toBe('acquired');
    expect(fixed.requestedSamples).toBe(jointFullSamples(fixed.dealtPlayers));
    expect(fixed.evidence!.samples).toHaveLength(fixed.requestedSamples);
    restoreFastRandom(rng);
    let ticks = 0;
    // The acquisition reads the clock twice: at its start and for samplingMs.
    const late = acquireJointSamples(hero, state, { now: () => (++ticks <= 1 ? 0 : 3) });
    expect(late.samplingMs).toBe(3);
    restoreFastRandom(rng);
    let elapsed = 0;
    const slow = acquireJointSamples(hero, state, { now: () => (elapsed += 5) });
    expect(slow.samplingMs).toBeGreaterThan(JOINT_SAMPLE_WORK_BUDGET_MS);
    restoreFastRandom(rng);
    vi.spyOn(equityGovernor, 'current').mockReturnValue(0.35);
    const loaded = acquireJointSamples(hero, state, { now: () => 0 });
    for (const other of [late, slow, loaded]) {
      expect(other.status, other.reason).toBe('acquired');
      expect(other.evidence!.sampleBudgetExhausted).toBe(false);
      expect(withoutClock(other)).toBe(withoutClock(fixed));
    }
  });

  it('never promotes fewer than eight complete samples', () => {
    const { hero, state } = jointPolicyFixture();
    const draw = sampler.sampleJointRanges;
    vi.spyOn(sampler, 'sampleJointRanges').mockImplementationOnce((...args) => {
      const full = draw(...args)!;
      return { ...full, samples: full.samples.slice(0, 7), sampleBudgetExhausted: true };
    });
    const incomplete = acquireJointSamples(hero, state, { now: () => 0 });
    expect(incomplete.status).toBe('refused');
    expect(incomplete.reason).toBe('insufficient_joint_samples');
    expect(incomplete.evidence!.samples).toHaveLength(7);
    expect(incomplete.provenance).toBeNull();
  });
});

describe('Phase13 reuses the authenticated joint population', () => {
  it('performs one draw, returns the same sealed rows, and excludes intervening Phase7 time', () => {
    const { hero, state, baseline } = jointPolicyFixture();
    const draw = vi.spyOn(sampler, 'sampleJointRanges');
    const acquired = acquireJointSamples(hero, state, { now: () => 0 });
    expect(acquired.status).toBe('acquired');
    const reused = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 100, acquired);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(reused.receipt.fired, reused.receipt.reason).toBe(true);
    expect(reused.jointEvidence).toBe(acquired.evidence);
    expect(reused.receipt.latencyMs).toBe(0);
    expect(reused.decision).toBe(baseline);
  });

  it('charges fresh sampling exactly once and preserves the existing default shadow mode', () => {
    const { hero, state, baseline } = jointPolicyFixture();
    const originalDraw = sampler.sampleJointRanges;
    let clock = 0;
    const draw = vi.spyOn(sampler, 'sampleJointRanges').mockImplementation((...args) => {
      const result = originalDraw(...args);
      clock = 2;
      return result;
    });
    const result = evaluateJointLivePolicy(hero, state, baseline, undefined, () => clock);
    expect(result.receipt.fired, result.receipt.reason).toBe(true);
    expect(result.receipt.mode).toBe('shadow');
    expect(result.receipt.latencyMs).toBe(2);
    expect(result.decision).toBe(baseline);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('refuses foreign or stale acquisitions without silently drawing another population', () => {
    const { hero, state, baseline } = jointPolicyFixture();
    const draw = vi.spyOn(sampler, 'sampleJointRanges');
    const acquired = acquireJointSamples(hero, state, { now: () => 0 });
    const forged = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0, {
      ...acquired,
    });
    expect(forged.receipt.reason).toBe('joint_acquisition_state_mismatch');
    state.actionHistory!.push({
      userId: 'p1',
      seat: 2,
      action: 'check',
      amount: 0,
      stage: 'flop',
      timestamp: 1,
    });
    const stale = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0, acquired);
    expect(stale.receipt.reason).toBe('joint_acquisition_state_mismatch');
    expect(draw).toHaveBeenCalledTimes(1);
    expect(stale.decision).toBe(baseline);
  });

  it('measures reused sampling time in latencyMs, never cuts on it, and does not retry refusals', () => {
    const { hero, state, baseline } = jointPolicyFixture();
    const original = sampler.sampleJointRanges;
    const draw = vi.spyOn(sampler, 'sampleJointRanges');
    let calls = 0;
    const acquired = acquireJointSamples(hero, state, { now: () => (++calls === 1 ? 0 : 2) });
    expect(acquired.status, acquired.reason).toBe('acquired');
    expect(acquired.samplingMs).toBe(2);
    const fixed = evaluateJointLivePolicy(hero, state, baseline, 'candidate', () => 0, acquired);
    let clock = 100;
    const slow = evaluateJointLivePolicy(
      hero,
      state,
      baseline,
      'candidate',
      () => (clock += 1),
      acquired
    );
    expect(slow.receipt.fired, slow.receipt.reason).toBe(true);
    // The reused 2 ms plus the wrapper's own measured 1 ms; nothing is cut.
    expect(fixed.receipt.latencyMs).toBe(2);
    expect(slow.receipt.latencyMs).toBe(3);
    expect({ ...slow.receipt, latencyMs: 0 }).toEqual({ ...fixed.receipt, latencyMs: 0 });
    expect(slow.decision).toEqual(fixed.decision);
    expect(draw).toHaveBeenCalledTimes(1);
    draw.mockImplementationOnce((...args) => {
      const full = original(...args)!;
      return { ...full, samples: full.samples.slice(0, 3), sampleBudgetExhausted: true };
    });
    const refused = acquireJointSamples(hero, state, { now: () => 0 });
    expect(refused.status).toBe('refused');
    const refusal = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0, refused);
    expect(refusal.receipt.reason).toBe(refused.reason);
    expect(draw).toHaveBeenCalledTimes(2);
  });
});
