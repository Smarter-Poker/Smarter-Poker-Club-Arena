/**
 * P13-B: one coherent joint distribution reaches Phase 7 for a tournament
 * joint decision.
 *
 * A rigged real PKO bomb hand (two boards, whole chips, an odd main pot)
 * reaches hero's river decision through the actual controller, with a short
 * stack already all in. HorseLogic runs the Phase 13 owner in candidate
 * evidence mode, and Phase 7 prices the joint samples. The test reads what
 * crossed the boundary and recomputes, independently and per sample from the
 * same joint draws, hero's award, the short stack's elimination and the
 * bounty claim on the hand where hero checks.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TournamentUtilityInput } from '../HorseTournamentUtility.js';
import type { evaluateJointLivePolicy } from './JointLivePolicy.js';

type JointLivePolicyResult = ReturnType<typeof evaluateJointLivePolicy>;
import { HorseLogic, type HorseDecideOpts } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { decisionSpot, play, type Rig, type Step } from './JointEconomicsHarness.test-support.js';

const seen = vi.hoisted(() => ({
  joint: [] as unknown[],
  utility: [] as unknown[],
}));
vi.mock('./JointLivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./JointLivePolicy.js')>();
  return {
    ...actual,
    evaluateJointLivePolicy: (...args: Parameters<typeof actual.evaluateJointLivePolicy>) => {
      const result = actual.evaluateJointLivePolicy(...args);
      seen.joint.push(result);
      return result;
    },
  };
});
vi.mock('../HorseTournamentUtility.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HorseTournamentUtility.js')>();
  return {
    ...actual,
    evaluateTournamentUtilityDetailed: (
      input: Parameters<typeof actual.evaluateTournamentUtilityDetailed>[0]
    ) => {
      seen.utility.push(input);
      return actual.evaluateTournamentUtilityDetailed(input);
    },
  };
});

const opts: HorseDecideOpts = {
  telemetry: false,
  mind: false,
  decisionTimeMs: 0,
  phase10Plo4: 'off',
  phase11Omaha: 'off',
  phase12Remaining: 'off',
};

describe('P13-B: one coherent joint distribution reaches Phase 7', () => {
  it('a PKO two-board bomb river: same samples, exact identities, payout and bounty context', () => {
    const rig: Rig = {
      variant: 'nlh',
      mode: 'tournament',
      smallBlind: 10,
      bigBlind: 25,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      bombPot: { boardCount: 2, anteMultiplier: 1.5 },
      dealer: 3,
      seats: [
        { id: 'hero', stack: 1000, hole: 'Kh 2d' },
        { id: 'big', stack: 1300, hole: 'Ah 5h' },
        { id: 'short', stack: 115, hole: 'Kd 2c' },
      ],
      boards: ['Ks Qd 8s 7c 6s', 'Jh Th 9c 3h 3d'],
    };
    // Antes 38 each; short moves all in for 77 on the flop and both call.
    const pre: Step[] = [
      [1, 'check'],
      [2, 'check'],
      [3, 'all_in'],
      [1, 'call'],
      [2, 'call'],
      [1, 'check'],
      [2, 'check'],
    ];
    const played = play(rig, pre);
    const { hero, state } = decisionSpot(played, rig);
    const live = played.controller.getState().players;
    const totals = Object.fromEntries(live.map((p) => [p.user_id, p.stack + p.totalInvested]));
    state.tournament = {
      schemaVersion: 1,
      contextStatus: 'complete',
      contextIssues: [],
      playersLeft: 3,
      spotsPaid: 2,
      payoutPct: [65, 35],
      stacks: Object.values(totals),
      stackByUser: totals,
      currentSmallBlind: 10,
      currentBigBlind: 25,
      currentAnte: 0,
      anteType: 'none',
      prizePoolCents: 10000,
      bountyPoolCents: 3000,
      isPko: true,
      isBounty: true,
      bountyFactor: 0.5,
      bountyByUser: { hero: 1000, big: 1000, short: 1000 },
      isMysteryBounty: false,
      mysteryBountyStage: 'none',
      reentryOpen: false,
      rebuyOpen: false,
      addOnPeriodOpen: false,
      maxReentries: 0,
      maxRebuys: 0,
      reloadsUsed: 0,
      addOnTaken: false,
      rebuyAffordable: false,
      addOnAffordable: false,
    } as never;
    expect(state.pot).toBe(345);
    expect(state.boardCount).toBe(2);
    seen.joint = [];
    seen.utility = [];
    seedFastRandom(1306070);
    const decision = HorseLogic.decide(
      hero,
      state,
      'balanced',
      {},
      { ...opts, phase13Joint: 'candidate', phase13EvidenceMode: true }
    );
    expect(decision.jointPolicy?.fired, decision.jointPolicy?.reason).toBe(true);
    expect(decision.jointPolicy?.utilityOwner).toBe('phase7_evaluated');
    const joint = (seen.joint as JointLivePolicyResult[]).at(-1)!.jointEvidence!;
    const inputs = (seen.utility as TournamentUtilityInput[]).filter((i) => i.settlement);
    // Two owners price this bomb decision: Phase 7's own multi-board path
    // first, then the Phase 13 bridge, which reuses Phase 7's acquisition.
    // Both read the same joint draws: not a copy and not a fresh sample.
    expect(inputs).toHaveLength(2);
    for (const i of inputs) {
      expect(i.showdownSamples).toBe(joint.samples);
      expect(i.sampledOpponentIds).toEqual(joint.opponentIds);
      expect(i.settlement).toEqual({ chipUnit: 1, dealerSeat: 3, splitLow: false });
    }
    const input = inputs[1];
    // Exact player-to-stack identity, seat by seat, from the controller.
    for (const p of live) {
      const q = input.players.find((x) => x.user_id === p.user_id)!;
      expect([q.seat, q.stack, q.totalInvested, q.is_all_in]).toEqual([
        p.seat,
        p.stack,
        p.totalInvested,
        p.is_all_in,
      ]);
      expect(input.context.fieldStackByUser[p.user_id]).toBe(totals[p.user_id]);
      expect(input.context.bountyByUser[p.user_id]).toBe(1000);
    }
    expect(input.context.payoutPct).toEqual([65, 35]);
    expect(input.context.isPko).toBe(true);
    const ledger = decision.jointPolicy!.shadowUtility!;
    expect(ledger.fieldReconciliationErrorChips).toBe(0);
    expect(ledger.effectiveOutcomeSamples).toBe(joint.samples.length);

    // Independent per-sample settlement of the check line: one 345 pot (all
    // three in for 115), 173 on board 1 and 172 on board 2, each to its best
    // high, ties shared with the odd chip clockwise from the button (hero,
    // big, then short).
    const ids = ['hero', ...joint.opponentIds];
    const order = ['hero', 'big', 'short'];
    let award = 0,
      won = 0,
      bounty = 0,
      share = 0;
    for (const sample of joint.samples) {
      const got: Record<string, number> = { hero: 0, big: 0, short: 0 };
      const winners = new Set<string>();
      sample.boards.forEach((b, i) => {
        const units = i === 0 ? 173 : 172;
        const score = (id: string) =>
          id === 'hero' ? b.heroHigh : b.opponentHigh[joint.opponentIds.indexOf(id)];
        const best = Math.max(...ids.map(score));
        const tied = order.filter((id) => score(id) === best);
        tied.forEach((id, k) => {
          got[id] += Math.floor(units / tied.length) + Number(k < units % tied.length);
          winners.add(id);
        });
      });
      award += got.hero;
      won += Number(got.hero > 0);
      // The short stack is eliminated when it wins nothing; the head goes to
      // every distinct winner of the pot it was in.
      const claimed = got.short === 0 && winners.has('hero');
      bounty += Number(claimed);
      if (claimed) share += 1 / [...winners].filter((id) => id !== 'short').length;
    }
    const n = joint.samples.length;
    const check = ledger.candidates.find((c) => c.action === 'check')!;
    expect(check.chipEv).toBeCloseTo(Math.round((award / n) * 100) / 100, 9);
    expect(check.winProbability).toBeCloseTo(won / n, 12);
    expect(check.bountyWinProbability).toBeCloseTo(bounty / n, 12);
    // PKO: half the 10.00 head is paid now, in points of the 130.00 funded
    // pools, shared by the claimants.
    expect(check.bountyEv).toBeCloseTo(((share / n) * 500 * 100) / 13000, 12);
    expect(check.bustProbability).toBe(0);
    expect(check.stackConservationError).toBeLessThan(1e-8);
    // The draws really disagree across boards, so identity matters.
    expect(won).toBeGreaterThan(0);
    expect(bounty).toBeGreaterThan(0);
    expect(bounty).toBeLessThan(won);
  });
});
