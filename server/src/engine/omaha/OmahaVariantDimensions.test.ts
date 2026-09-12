import { describe, expect, it } from 'vitest';
import { omahaVariantSpot } from '../../benchmark/OmahaVariantPolicyEvidence.js';
import { evaluateOmahaVariantPolicy } from './OmahaVariantLivePolicy.js';
import { omahaVariantSeatCap } from './OmahaVariantPolicyPack.js';

describe('Phase 11 postflop geometry and hostile-state boundaries', () => {
  it.each(['plo5', 'plo6', 'plo8'] as const)(
    '%s covers all live seat counts and positions, every street/role and short-to-deep stacks',
    (variant) => {
      const seen = new Set<string>();
      let count = 0;
      for (const mode of ['cash', 'tournament'] as const)
        for (let seats = 2; seats <= omahaVariantSeatCap(variant, mode); seats++)
          for (let button = 1; button <= seats; button++)
            for (const street of ['flop', 'turn', 'river'] as const)
              for (const depth of [1, 4, 20, 100, 250])
                for (const role of [
                  'checked_to',
                  'facing_bet',
                  'facing_raise',
                  'call_off',
                ] as const) {
                  const s = omahaVariantSpot(variant, street, seats, mode);
                  s.state.dealerSeat = button;
                  const price = role === 'checked_to' ? 0 : role === 'call_off' ? depth * 2 : 2;
                  s.hero.bet = role === 'facing_raise' ? 1 : 0;
                  s.hero.totalInvested = 20 + s.hero.bet;
                  s.hero.stack = depth * 2 - s.hero.bet;
                  s.state.players.forEach((p, i) => {
                    p.bet = i === 0 ? s.hero.bet : i === 1 ? price : 0;
                    p.stack = depth * 2 - p.bet;
                    p.is_all_in = p.stack === 0;
                    p.totalInvested = 20 + p.bet;
                  });
                  s.state.currentBet = price;
                  s.state.toCall = price - s.hero.bet;
                  s.state.pot = s.state.players.reduce((n, p) => n + p.totalInvested, 0);
                  s.state.minRaiseTo = Math.max(2, price * 2);
                  s.state.maxRaiseTo = Math.min(s.hero.stack, price + s.state.pot + price);
                  s.state.legalActions = price ? ['fold', 'call'] : ['check'];
                  if (s.state.maxRaiseTo >= s.state.minRaiseTo)
                    s.state.legalActions.push(price ? 'raise' : 'bet');
                  else {
                    s.state.minRaiseTo = null;
                    s.state.maxRaiseTo = null;
                  }
                  s.baseline = { action: price ? 'call' : 'check', thinkTime: 0 };
                  s.state.actionHistory =
                    role === 'checked_to'
                      ? []
                      : [
                          {
                            userId: 'v2',
                            seat: 2,
                            stage: street,
                            action: role === 'facing_raise' ? 'raise' : 'bet',
                            amount: price,
                            timestamp: 1,
                            isFullRaise: true,
                          },
                        ];
                  if (role === 'facing_raise')
                    s.state.actionHistory.unshift({
                      userId: s.hero.user_id,
                      seat: 1,
                      stage: street,
                      action: 'bet',
                      amount: 1,
                      timestamp: 0,
                      isFullRaise: true,
                    });
                  // Pairwise rotation of rake/ante/straddle overlays; full numeric
                  // cross-product interpolation is separately certified preflop.
                  s.state.rakeConfig!.percent = mode === 'cash' ? [0, 5, 10][count % 3] : 0;
                  s.state.ante = [0, 1, 2][Math.floor(count / 3) % 3];
                  s.state.straddleActive = mode === 'cash' && count % 2 === 0;
                  const r = evaluateOmahaVariantPolicy(
                    s.hero,
                    s.state,
                    s.baseline,
                    null,
                    'candidate',
                    () => 0,
                    1,
                    false
                  );
                  if (
                    !r.receipt.eligible ||
                    !r.receipt.fired ||
                    !s.state.legalActions.includes(r.proposal.action)
                  )
                    throw new Error(
                      JSON.stringify({ variant, mode, seats, button, street, depth, role, r })
                    );
                  if (
                    ['raise', 'bet'].includes(r.proposal.action) &&
                    (!(r.proposal.amount! >= s.state.minRaiseTo!) ||
                      !(r.proposal.amount! <= s.state.maxRaiseTo!))
                  )
                    throw new Error('Wager escaped canonical geometry');
                  seen.add(`${mode}/${street}/${r.receipt.role}`);
                  count++;
                }
      for (const mode of ['cash', 'tournament'])
        for (const street of ['flop', 'turn', 'river'])
          for (const role of ['checked_to', 'facing_bet', 'facing_raise', 'call_off'])
            expect(seen.has(`${mode}/${street}/${role}`)).toBe(true);
      expect(count).toBe({ plo5: 4260, plo6: 2820, plo8: 5340 }[variant]);
    },
    30000
  );
  it('rejects nonfinite money, mismatched hero state, impossible wager bounds and unsupported seat counts', () => {
    const edits = [
      (s: ReturnType<typeof omahaVariantSpot>) => {
        s.state.bigBlind = Infinity;
      },
      (s: ReturnType<typeof omahaVariantSpot>) => {
        s.state.players[1].bet = NaN;
      },
      (s: ReturnType<typeof omahaVariantSpot>) => {
        s.state.players[0].stack += 1;
      },
      (s: ReturnType<typeof omahaVariantSpot>) => {
        s.state.maxRaiseTo = NaN;
      },
      (s: ReturnType<typeof omahaVariantSpot>) => {
        s.hero.is_folded = true;
      },
    ];
    for (const edit of edits) {
      const s = omahaVariantSpot('plo6');
      edit(s);
      const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'candidate', () => 0);
      expect(r.receipt.eligible).toBe(false);
      expect(r.decision).toBe(s.baseline);
    }
    const s = omahaVariantSpot('plo6', 'preflop', 7);
    expect(evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null).receipt.eligible).toBe(
      false
    );
  });
});
