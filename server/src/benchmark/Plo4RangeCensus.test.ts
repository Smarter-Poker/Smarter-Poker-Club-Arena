import { describe, expect, it } from 'vitest';
import { plo4ReferenceSpot } from './Plo4PolicyEvidence.js';
import { evaluatePlo4Policy } from './Plo4PolicyProgram.js';
import { plo4PublicRanges } from './Plo4PublicRanges.js';

describe('Phase 10 independent evidence preserves the authoritative dealt population', () => {
  it('generates unique-combination priors and the real oracle accepts a repeated-draw seed', async () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    for (let seed = 1; seed <= 4096; seed++) {
      const ranges = plo4PublicRanges(input.hero, input.state, seed);
      const range = ranges.opponent;
      if (!('combos' in range)) throw new Error('Expected generated combination prior');
      const keys = range.combos.map((combo) =>
        combo.cards
          .map((card) => card.rank + ':' + card.suit)
          .sort()
          .join('|')
      );
      expect(new Set(keys).size, 'seed ' + seed).toBe(keys.length);
    }
    input.seed = 211;
    delete input.opponentRanges;
    const result = await evaluatePlo4Policy(input);
    expect(result.equity?.complete).toBe(true);
  });
  it('includes a dealt away all-in opponent in ranges, pot rights and reference equity', async () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    input.state.dealtSeatIds = [1, 2];
    Object.assign(input.state.players[1], {
      stack: 0,
      is_all_in: true,
      is_sitting_out: true,
    });
    expect(Object.keys(plo4PublicRanges(input.hero, input.state, input.seed))).toEqual([
      'opponent',
    ]);
    const result = await evaluatePlo4Policy(input);
    expect(result.equity?.complete).toBe(true);
    expect(result.equity?.equity).toBe(0);
    expect(result.equity?.eligiblePot).toBe(80);
    expect(result.callEvInterval).toEqual([-20, -20]);
    expect(result.selected.action).toBe('fold');
  });

  it('excludes an undealt spectator without losing a dealt folded away seat', async () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    input.state.dealtSeatIds = [1, 2];
    input.state.players.push({
      ...input.state.players[1],
      user_id: 'spectator',
      seat: 3,
      bet: 0,
      totalInvested: 0,
      is_folded: true,
    });
    expect(Object.keys(plo4PublicRanges(input.hero, input.state, input.seed))).toEqual([
      'opponent',
    ]);
    const result = await evaluatePlo4Policy(input);
    expect(result.equity?.complete).toBe(true);
    expect(result.equity?.equity).toBe(0);

    input.state.dealtSeatIds = [1, 2, 3];
    input.state.players[2].is_sitting_out = true;
    expect(Object.keys(plo4PublicRanges(input.hero, input.state, input.seed))).toEqual([
      'opponent',
      'spectator',
    ]);
  });

  it('gives an all-in call the same range evidence as a call, while preserving short raises', () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    const action = input.state.actionHistory![0];
    action.action = 'call';
    delete action.isFullRaise;
    const call = plo4PublicRanges(input.hero, input.state, input.seed);
    action.action = 'all_in';
    expect(plo4PublicRanges(input.hero, input.state, input.seed)).toEqual(call);

    action.isFullRaise = false;
    const shortRaise = plo4PublicRanges(input.hero, input.state, input.seed);
    action.action = 'raise';
    expect(plo4PublicRanges(input.hero, input.state, input.seed)).toEqual(shortRaise);
    expect(shortRaise).not.toEqual(call);
  });
});
