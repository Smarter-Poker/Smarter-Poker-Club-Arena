import { describe, expect, it } from 'vitest';
import { evaluateOmahaVariantProgram } from './OmahaVariantPolicyProgram.js';
import {
  omahaVariantReferenceSpots,
  omahaVariantSpot,
  variantCards,
} from './OmahaVariantPolicyEvidence.js';
import { omahaVariantPublicRanges } from './OmahaVariantPublicRanges.js';
import { evaluateOmahaEquity } from './OmahaEquityOracle.js';
import { referenceDeck, cardKey } from './OmahaReference.js';
import {
  OMAHA_VARIANT_PACKS,
  omahaVariantSeatCap,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import { omahaCardFacts } from '../engine/omaha/OmahaCardFacts.js';

describe('Phase 11 independent high/low references', () => {
  it('retains an away all-in winner in the independent side-pot reference', async () => {
    const spot = omahaVariantReferenceSpots().find((s) =>
      s.name.includes('short-stack-wins-main')
    )!;
    const input = structuredClone(spot.input);
    input.state.dealtSeatIds = input.state.players.map((p) => p.seat);
    input.state.players[1].is_sitting_out = true;
    const result = await evaluateOmahaVariantProgram(input);
    expect(result.equity?.complete, result.reason).toBe(true);
    expect(result.equity!.perPot.map((p) => [p.amount, p.equity])).toEqual([
      [150, 0],
      [300, 1],
    ]);
    expect(result.equity!.maxConservationError).toBe(0);
    expect(result.equity!.equity).toBeCloseTo(2 / 3, 10);
  });

  it.each(['plo5', 'plo6', 'plo8'] as const)(
    '%s preserves folded deals and away all-ins, and excludes undealt spectators from public priors',
    (variant) => {
      const s = omahaVariantSpot(variant, 'river', 4);
      s.state.dealtSeatIds = [1, 2, 3];
      Object.assign(s.state.players[1], { is_sitting_out: true, is_all_in: true, stack: 0 });
      Object.assign(s.state.players[2], { is_sitting_out: true, is_folded: true });
      Object.assign(s.state.players[3], {
        is_sitting_out: true,
        is_folded: true,
        totalInvested: 0,
        bet: 0,
      });
      const ranges = omahaVariantPublicRanges(variant, s.hero, s.state, 11191);
      expect(Object.keys(ranges).sort()).toEqual(['v2', 'v3']);
    }
  );

  it('does not raise tied nut high plus tied nut low as a scoop in a four-way quartered pot', async () => {
    const s = omahaVariantSpot('plo8', 'river', 4);
    s.hero.cards = variantCards('As 2s 7s 8s');
    s.state.communityCards = variantCards('4c 5d 6h Kh Qc');
    s.state.players[2].totalInvested = s.state.players[3].totalInvested = 40;
    s.state.pot = 140;
    const r = await evaluateOmahaVariantProgram({
      ...s,
      seed: 11109901,
      mode: 'candidate',
      opponentRanges: {
        v2: { combos: [{ cards: variantCards('Ah 2h 7h 8h'), weight: 1 }] },
        v3: { combos: [{ cards: variantCards('Ad 2d 7d 8d'), weight: 1 }] },
        v4: { combos: [{ cards: variantCards('Ac 2c 7c 8c'), weight: 1 }] },
      },
    });
    expect(r.equity?.equity).toBe(0.25);
    expect(r.livePolicy.features).toEqual(
      expect.arrayContaining(['nut_high', 'nut_low', 'quarter_risk'])
    );
    expect(r.selected.action).toBe('call');
    expect(r.reason).toBe('split_price_call');
  });
  it.each(omahaVariantReferenceSpots())('$name', async ({ input, expectedShare, name }) => {
    const r = await evaluateOmahaVariantProgram(input);
    expect(r.equity?.complete, JSON.stringify(r)).toBe(true);
    expect(r.equity!.equity).toBeCloseTo(expectedShare, 4); // Canonical one-cent odd-chip rounding.
    expect(r.equity!.highEquity + r.equity!.lowEquity).toBeCloseTo(r.equity!.equity, 10);
    expect(r.equity!.maxConservationError).toBe(0);
    expect(r.livePolicy.equity?.provenance).toBe('independent_offline_oracle');
    if (expectedShare === 0 || name.includes('expensive') || name.includes('sixthed'))
      expect(r.selected.action).toBe('fold');
    if (expectedShare === 1) expect(r.selected.action).toBe('raise');
    if (name.includes('side')) {
      expect(r.equity!.perPot.map((p) => [p.amount, p.equity])).toEqual([
        [150, 0],
        [300, 1],
      ]);
      expect(r.livePolicy.features).toContain('separate_pot_eligibility');
    }
  });
  it('reports counterfeit exposure and distinguishes replacement low from high-only cards', () => {
    const low = omahaCardFacts(variantCards('As 2s Jh Td'), variantCards('3c 4d 8h'));
    expect(low.nutLow).toBe(true);
    expect(low.counterfeitTransitions.some((t) => t.nutLowAfter === false)).toBe(true);
    const backup = omahaCardFacts(variantCards('As 2s 5h Td'), variantCards('3c 4d 8h'));
    expect(
      backup.counterfeitTransitions.filter((t) => t.nutLowAfter === false).length
    ).toBeLessThan(low.counterfeitTransitions.filter((t) => t.nutLowAfter === false).length);
  });
  it.each(['plo5', 'plo6', 'plo8'] as const)(
    '%s conditions separate priors on public actions without private-card leakage',
    (variant) => {
      const s = omahaVariantSpot(variant, 'flop');
      const a = omahaVariantPublicRanges(variant, s.hero, s.state, 11199);
      s.state.players[1].cards = variantCards('Ah Ad 2h 2d');
      expect(omahaVariantPublicRanges(variant, s.hero, s.state, 11199)).toEqual(a);
      s.state.actionHistory = [];
      expect(omahaVariantPublicRanges(variant, s.hero, s.state, 11199)).not.toEqual(a);
      const known = new Set([...s.hero.cards, ...s.state.communityCards].map(cardKey));
      for (const range of Object.values(a))
        if ('combos' in range)
          for (const combo of range.combos) {
            expect(combo.cards).toHaveLength(OMAHA_VARIANT_PACKS[variant].holes);
            expect(combo.cards.some((c) => known.has(cardKey(c)))).toBe(false);
          }
    }
  );
  it.each(['plo5', 'plo6', 'plo8'] as const)(
    '%s independently settles the actual maximum tournament table',
    async (variant) => {
      const deck = referenceDeck();
      const n = omahaVariantSeatCap(variant, 'tournament');
      const players = Array.from({ length: n }, (_, i) => ({
        id: `v${i}`,
        seat: i + 1,
        contributed: 100,
        range: {
          combos: [{ cards: deck.splice(0, OMAHA_VARIANT_PACKS[variant].holes), weight: 1 }],
        },
      }));
      const r = await evaluateOmahaEquity({
        variant,
        heroId: 'v0',
        players,
        boards: [deck.splice(0, 5)],
        dealerSeat: n,
        chipUnit: 1,
        mode: 'exact_river',
        samples: 1,
        seed: 11199,
      });
      expect(r.complete).toBe(true);
      expect(r.maxConservationError).toBe(0);
      expect(r.perPot[0].eligiblePlayers).toHaveLength(n);
    }
  );
  it('never applies an invalid, cancelled or tournament-only offline proposal', async () => {
    const s = omahaVariantSpot('plo5', 'preflop');
    for (const bad of [{ seed: 0 }, { seed: 1, samples: 129 }]) {
      const r = await evaluateOmahaVariantProgram({ ...s, ...bad, mode: 'candidate' });
      expect(r.selected).toEqual(s.baseline);
      expect(r.selected).not.toBe(s.baseline);
    }
    const r = await evaluateOmahaVariantProgram({ ...s, seed: 1, mode: 'candidate' }, () => false);
    expect(r.selected).toEqual(s.baseline);
    const tournament = omahaVariantSpot('plo8', 'preflop', 2, 'tournament');
    expect(
      (await evaluateOmahaVariantProgram({ ...tournament, seed: 1, mode: 'candidate' })).selected
    ).toEqual(tournament.baseline);
  });
});
