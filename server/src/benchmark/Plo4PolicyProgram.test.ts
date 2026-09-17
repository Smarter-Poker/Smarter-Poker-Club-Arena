import { describe, expect, it } from 'vitest';
import {
  PLO4_POLICY_PACK,
  plo4CoverageMatrix,
  plo4HandShape,
} from '../engine/plo4/Plo4PolicyPack.js';
import { evaluatePlo4Policy } from './Plo4PolicyProgram.js';
import { plo4Cards, plo4ReferenceSpot, runPlo4ReferenceSpots } from './Plo4PolicyEvidence.js';

function withoutClock(result: Awaited<ReturnType<typeof evaluatePlo4Policy>>) {
  return {
    ...result,
    elapsedMs: 0,
    equity: result.equity ? { ...result.equity, elapsedMs: 0 } : null,
  };
}
describe('Phase 10 basic PLO4 policy', () => {
  it('executes independent losing-flush, royal, dominated-draw and premium-open reference spots', async () => {
    const spots = await runPlo4ReferenceSpots();
    expect(spots.map((s) => s.receipt.selected.action)).toEqual(['fold', 'raise', 'call', 'raise']);
    expect(spots[0].receipt.equity?.confidence99).toEqual([0, 0]);
    expect(spots[1].receipt.equity?.confidence99).toEqual([1, 1]);
    expect(spots[2].receipt.livePolicy?.fired).toBe(true);
    expect(spots[3].receipt.proposal.amount).toBe(5);
  });
  it('defaults to shadow, reports a proposal and preserves detached baseline values', async () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    delete input.mode;
    const before = JSON.stringify(input);
    const result = await evaluatePlo4Policy(input);
    expect(result.mode).toBe('shadow');
    expect(result.proposal.action).toBe('fold');
    expect(result.selected).toEqual(input.baseline);
    expect(result.selected).not.toBe(input.baseline);
    expect(result.applied).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('does not consume any opponent private cards from the canonical snapshot', async () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    const expected = await evaluatePlo4Policy(input);
    input.state.players[1].cards = plo4Cards('As As As As');
    expect(withoutClock(await evaluatePlo4Policy(input))).toEqual(withoutClock(expected));
  });
  it('keeps calls within side-pot eligibility when an opponent has uncalled excess', async () => {
    const input = plo4ReferenceSpot('royal_flush');
    input.hero.stack = input.state.players[0].stack = 10;
    const result = await evaluatePlo4Policy(input);
    expect(result.equity?.refunds.opponent).toBe(10);
    expect(result.equity?.eligiblePot).toBe(60);
    expect(result.callEvInterval?.[0]).toBe(47);
    expect(result.selected.action).toBe('call');
  });
  it('reflects the configured rake in terminal call value', async () => {
    const input = plo4ReferenceSpot('royal_flush');
    input.state.rakeConfig!.percent = 0;
    const free = await evaluatePlo4Policy(input);
    input.state.rakeConfig!.percent = 5;
    const raked = await evaluatePlo4Policy(input);
    expect(free.callEvInterval).toEqual([60, 60]);
    expect(raked.callEvInterval).toEqual([56, 56]);
  });
  it('prices a losing multiway river bluff catcher without crediting unavailable side pots', async () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    input.state.players.push({
      ...input.state.players[1],
      user_id: 'third',
      seat: 3,
      bet: 0,
      totalInvested: 20,
    });
    input.state.pot += 20;
    input.opponentRanges!.third = {
      combos: [{ cards: plo4Cards('2c 4c 6d 7d'), weight: 1 }],
    };
    const result = await evaluatePlo4Policy(input);
    expect(result.equity?.complete).toBe(true);
    expect(result.livePolicy?.features).toContain('multiway');
    expect(result.selected.action).toBe('fold');
  });
  it.each(['preflop', 'flop', 'turn', 'river'] as const)(
    'preserves tournament utility ownership on %s',
    async (street) => {
      const input = plo4ReferenceSpot(street === 'preflop' ? 'premium_open' : 'non_nut_flush');
      input.state.stage = street;
      input.state.communityCards = input.state.communityCards.slice(
        0,
        { preflop: 0, flop: 3, turn: 4, river: 5 }[street]
      );
      input.state.gameMode = 'tournament';
      const result = await evaluatePlo4Policy(input);
      expect(result.reason).toBe('phase7_utility_required');
      expect(result.eligible).toBe(true);
      expect(result.livePolicy?.fired).toBe(true);
      expect(result.selected).toEqual(input.baseline);
      expect(result.applied).toBe(false);
    }
  );
  it('uses a distinct PLO4 hand shape and labels every initial-round matrix cell', () => {
    const matrix = plo4CoverageMatrix();
    expect(matrix.preflopCoordinates).toBeGreaterThan(1_000_000);
    expect(matrix.seats).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(matrix.calibrated).toBe(false);
    expect(plo4HandShape(plo4Cards('As Ad Ks Kd')).quality).toBe(1);
    expect(plo4HandShape(plo4Cards('As Ad Ah Ac')).duplicateWaste).toBe(true);
    expect(() => plo4HandShape(plo4Cards('As Ad Ks Kd 2c'))).toThrow('exactly four');
    expect(() => plo4HandShape(plo4Cards('As As Ks Kd'))).toThrow('Invalid');
    expect(Object.isFrozen(PLO4_POLICY_PACK.openQuality)).toBe(true);
    expect(PLO4_POLICY_PACK.calibratedConfidence).toBeNull();
  });
  it('opens the same connected hand later while respecting the actual legal raise ceiling', async () => {
    async function at(seat: number) {
      const input = plo4ReferenceSpot('premium_open');
      input.hero.seat = seat;
      input.hero.bet = input.hero.totalInvested = 0;
      input.hero.cards = plo4Cards('Ks Qs Jh Th');
      input.state.players = Array.from({ length: 6 }, (_, i) => ({
        ...input.hero,
        seat: i + 1,
        user_id: i + 1 === seat ? 'hero' : `v${i + 1}`,
        cards: [],
        bet: i === 1 ? 1 : i === 2 ? 2 : 0,
        totalInvested: i === 1 ? 1 : i === 2 ? 2 : 0,
      }));
      Object.assign(input.state, {
        heroSeat: seat,
        currentPlayerSeat: seat,
        toCall: 2,
        maxRaiseTo: 7,
      });
      return evaluatePlo4Policy(input);
    }
    const early = await at(4),
      button = await at(1);
    expect(early.position).toBe('early');
    expect(early.selected.action).toBe('fold');
    expect(button.position).toBe('button');
    expect(button.selected.action).toBe('raise');
    expect(button.selected.amount).toBeLessThanOrEqual(7);
  });
  it('retains the baseline on malformed, unsupported or incomplete inputs', async () => {
    for (const [change, reason] of [
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.state.gameVariant = 'plo5';
        },
        'variant_outside_pack',
      ],
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.state.boardCount = 2;
        },
        'multiboard_owned_by_phase13',
      ],
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.state.straddleActive = true;
        },
        'unknown_or_unsupported_straddle',
      ],
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.state.pot = 1;
        },
        'invalid_geometry',
      ],
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.hero.cards[0] = i.state.communityCards[0];
        },
        'invalid_cards',
      ],
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.samples = 129;
        },
        'sample_budget_outside_pack',
      ],
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.opponentRanges = {};
        },
        'incomplete_opponent_ranges',
      ],
      [
        (i: ReturnType<typeof plo4ReferenceSpot>) => {
          i.state.rakeConfig!.timedRake = { amountPerMinute: 1 };
        },
        'rake_schedule_unavailable',
      ],
    ] as const) {
      const input = plo4ReferenceSpot('non_nut_flush');
      change(input);
      const result = await evaluatePlo4Policy(input);
      expect(result.reason).toBe(reason);
      expect(result.selected).toEqual(input.baseline);
    }
  });
  it('preserves the baseline on cancellation or an incompatible opponent range', async () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    expect((await evaluatePlo4Policy(input, () => false)).reason).toBe('cancelled');
    input.opponentRanges = { opponent: { combos: [{ cards: input.hero.cards, weight: 1 }] } };
    const result = await evaluatePlo4Policy(input);
    expect(result.reason).toBe('equity_incompatible_ranges');
    expect(result.selected).toEqual(input.baseline);
  });
  it('does not turn a sampled estimate into a guaranteed price or force an illegal raise', async () => {
    const river = plo4ReferenceSpot('royal_flush');
    delete river.opponentRanges;
    river.samples = 1;
    const price = await evaluatePlo4Policy(river);
    expect(price.equity?.guaranteedShare).toBeNull();
    expect(price.selected.action).toBe('raise'); // exact own-card royal, independent of sampled confidence
    const open = plo4ReferenceSpot('premium_open');
    open.state.legalActions = ['fold', 'call'];
    open.state.minRaiseTo = open.state.maxRaiseTo = null;
    expect((await evaluatePlo4Policy(open)).selected.action).toBe('call');
  });
});
