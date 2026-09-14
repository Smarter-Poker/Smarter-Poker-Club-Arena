import { performance } from 'node:perf_hooks';
/** Historical review rates remain diagnostic; paired decisions must stay identical. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HorseLogic,
  resolveHorseStyle,
  leakLoad,
  nlhStackoffLoad,
  ploStackoffLoad,
  riverWarLoad,
  limpBloatLoad,
  NLH_STACKOFF_TAGS,
  LEAK_LOAD_TAGGED,
  type HorseGameStateV2,
  type HorseProfileMods,
} from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import { leakFamilyOf } from '../services/HorseSelfTuner.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';

beforeEach(() => {
  seedFastRandom(0x41);
  HorseMind.reset();
  drainFires();
});

const SUIT: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
function c(spec: string): Card {
  return { rank: spec.slice(0, -1) as Card['rank'], suit: SUIT[spec.slice(-1)] as Card['suit'] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...overrides,
  } as SeatPlayer;
}

function rec(
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return { seat, userId: `horse-${seat}`, action, amount, timestamp: 0, stage, ...extra };
}

/** Hero (seat 2, BB) holds top pair rag kicker; villain (seat 3) opened,
 *  c-bet the flop, and now fires a pot-sized turn barrel. */
function topPairFacingPotBarrel(): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const history: ActionRecord[] = [
    rec(1, 'sb' as ActionRecord['action'], 1, 'preflop'),
    rec(2, 'bb' as ActionRecord['action'], 2, 'preflop'),
    rec(3, 'raise', 6, 'preflop', { isFullRaise: true }),
    rec(1, 'fold', 0, 'preflop'),
    rec(2, 'call', 4, 'preflop'),
    rec(2, 'check', 0, 'flop'),
    rec(3, 'bet', 8, 'flop', { isFullRaise: true }),
    rec(2, 'call', 8, 'flop'),
    rec(2, 'check', 0, 'turn'),
    rec(3, 'bet', 29, 'turn', { isFullRaise: true }),
  ];
  const hero = mkPlayer(2, { cards: cc('Kd', '6c'), stack: 186, totalInvested: 14 });
  const gs = {
    players: [mkPlayer(1, { is_folded: true }), hero, mkPlayer(3, { bet: 29, stack: 157 })],
    communityCards: cc('Kh', '9s', '4d', 'Jc'),
    pot: 29 + 29,
    currentBet: 29,
    minRaise: 29,
    stage: 'turn' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 3,
    gameMode: 'cash' as const,
    format: 'cash',
    actionHistory: history,
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

/** A LIMPED pot: three limps, flop checks through, villain bombs the turn.
 *  Hero holds a pair of nines with a bad kicker. */
function limpedPotFacingBomb(): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const history: ActionRecord[] = [
    rec(1, 'sb' as ActionRecord['action'], 1, 'preflop'),
    rec(2, 'bb' as ActionRecord['action'], 2, 'preflop'),
    rec(3, 'call', 2, 'preflop'),
    rec(4, 'call', 2, 'preflop'),
    rec(1, 'call', 1, 'preflop'),
    rec(2, 'check', 0, 'preflop'),
    rec(1, 'check', 0, 'flop'),
    rec(2, 'check', 0, 'flop'),
    rec(3, 'check', 0, 'flop'),
    rec(4, 'check', 0, 'flop'),
    rec(1, 'check', 0, 'turn'),
    rec(2, 'check', 0, 'turn'),
    rec(3, 'bet', 8, 'turn', { isFullRaise: true }),
    rec(4, 'fold', 0, 'turn'),
    rec(1, 'fold', 0, 'turn'),
  ];
  const hero = mkPlayer(2, { cards: cc('9d', '5c'), stack: 198, totalInvested: 2 });
  const gs = {
    players: [
      mkPlayer(1, { is_folded: true }),
      hero,
      mkPlayer(3, { bet: 8, stack: 190 }),
      mkPlayer(4, { is_folded: true }),
    ],
    communityCards: cc('9h', 'Qs', '3d', 'Tc'),
    pot: 8 + 8,
    currentBet: 8,
    minRaise: 8,
    stage: 'turn' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 4,
    gameMode: 'cash' as const,
    format: 'cash',
    actionHistory: history,
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

/** River: hero bet 30 into 60 with a flush on a paired board and got raised
 *  to 120. A raise war the tag table says this horse keeps losing. */
function riverRaisedAfterBet(): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const history: ActionRecord[] = [
    rec(1, 'sb' as ActionRecord['action'], 1, 'preflop'),
    rec(2, 'bb' as ActionRecord['action'], 2, 'preflop'),
    rec(2, 'raise', 6, 'preflop', { isFullRaise: true }),
    rec(3, 'call', 6, 'preflop'),
    rec(1, 'fold', 0, 'preflop'),
    rec(2, 'bet', 8, 'flop', { isFullRaise: true }),
    rec(3, 'call', 8, 'flop'),
    rec(2, 'bet', 20, 'turn', { isFullRaise: true }),
    rec(3, 'call', 20, 'turn'),
    rec(2, 'bet', 30, 'river', { isFullRaise: true }),
    rec(3, 'raise', 120, 'river', { isFullRaise: true }),
  ];
  const hero = mkPlayer(2, { cards: cc('Ks', '7s'), stack: 136, bet: 30, totalInvested: 64 });
  const gs = {
    players: [mkPlayer(1, { is_folded: true }), hero, mkPlayer(3, { bet: 120, stack: 46 })],
    communityCards: cc('Qs', '4s', '4d', '9s', '2c'),
    pot: 69 + 30 + 120,
    currentBet: 120,
    minRaise: 90,
    stage: 'river' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 1,
    gameMode: 'cash' as const,
    format: 'cash',
    actionHistory: history,
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

function rate(
  make: () => { hero: SeatPlayer; gs: HorseGameStateV2 },
  mods: HorseProfileMods,
  pick: (a: string) => boolean,
  opts: Record<string, unknown> = {},
  trials = 80
): number {
  let n = 0;
  for (let t = 1; t <= trials; t++) {
    seedFastRandom(t * 7919 + 41);
    HorseMind.reset();
    const { hero, gs } = make();
    const d = HorseLogic.decide(hero, gs, 'balanced', mods, opts);
    if (pick(d.action)) n++;
  }
  return n / trials;
}

const TAGGED_NLH: HorseProfileMods = {
  leaksHoldem: { top_pair_weak_kicker_stackoff: 9, weak_kicker_trips_stackoff: 4 },
  leaksHandsHoldem: 100,
};

// ─────────────────────────────────────────────────────────────────────────────
describe('V41 loads - the profile parses and the family split holds', () => {
  it('resolveHorseStyle carries the family maps with their denominators', () => {
    const { mods } = resolveHorseStyle(
      {
        style: 'tag',
        leaks: { nonnut_flush_stackoff: 12 },
        leaksHands: 200,
        leaksOmaha: { nonnut_flush_stackoff: 2, junk: 'x' },
        leaksHandsOmaha: 80,
        leaksHoldem: { nonnut_flush_stackoff: 10, top_pair_weak_kicker_stackoff: 3 },
        leaksHandsHoldem: 120,
      },
      'h1'
    );
    expect(mods.leaksOmaha).toEqual({ nonnut_flush_stackoff: 2 });
    expect(mods.leaksHandsOmaha).toBe(80);
    expect(mods.leaksHoldem).toEqual({
      nonnut_flush_stackoff: 10,
      top_pair_weak_kicker_stackoff: 3,
    });
    expect(mods.leaksHandsHoldem).toBe(120);
    // The pooled map says 12/200 = 0.06 of "non-nut flush stack-offs"; the
    // Omaha family says 2/80 = 0.025. Before the split every one of those
    // hold em flushes counted against the Omaha pressure cap.
    expect(ploStackoffLoad(mods)).toBeCloseTo(0.025, 5);
    expect(nlhStackoffLoad(mods)).toBeCloseTo(13 / 120, 5);
  });

  it('a family map without a denominator is dropped, and the pooled map is the fallback', () => {
    const { mods } = resolveHorseStyle(
      { leaks: { coldcall_stackoff: 8 }, leaksHands: 100, leaksHoldem: { coldcall_stackoff: 8 } },
      'h2'
    );
    expect(mods.leaksHoldem).toBeUndefined();
    expect(nlhStackoffLoad(mods)).toBeCloseTo(0.08, 5);
    expect(leakLoad(mods, NLH_STACKOFF_TAGS, 'omaha')).toBeCloseTo(0.08, 5);
  });

  it('under 40 reviewed hands every load is zero', () => {
    expect(nlhStackoffLoad({ leaksHoldem: { coldcall_stackoff: 30 }, leaksHandsHoldem: 39 })).toBe(
      0
    );
    expect(riverWarLoad({ leaks: { river_raise_war: 30 }, leaksHands: 39 }, 'holdem')).toBe(0);
    expect(limpBloatLoad(undefined, 'omaha')).toBe(0);
  });

  it('the tuner files each rollup variant under the right family', () => {
    for (const v of ['plo4', 'plo5', 'plo6', 'plo8', 'flo8']) expect(leakFamilyOf(v)).toBe('omaha');
    for (const v of ['nlh', 'pineapple', 'short_deck', 'flh', null, undefined])
      expect(leakFamilyOf(v)).toBe('holdem');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('historical review signals cannot control live policy', () => {
  const cases = [
    ['hold em pressure', topPairFacingPotBarrel, TAGGED_NLH],
    [
      'limped pot',
      limpedPotFacingBomb,
      {
        leaksHoldem: { limped_pot_bloat: 7 },
        leaksHandsHoldem: 100,
      },
    ],
    [
      'river escalation',
      riverRaisedAfterBet,
      {
        leaksHoldem: { river_raise_war: 3, river_raise_paidoff: 4 },
        leaksHandsHoldem: 100,
      },
    ],
  ] as const;

  it.each(cases)(
    '%s retains exact paired decisions with reports and the legacy switch',
    (_name, make, signals) => {
      // Freeze compute-budget timing only for deterministic policy comparison.
      // Real clocks and worker scheduling are covered by the native probe.
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      try {
        for (let trial = 1; trial <= 80; trial++) {
          const play = (mods: HorseProfileMods, opts = {}) => {
            seedFastRandom(trial * 7919 + 41);
            HorseMind.reset();
            const { hero, gs } = make();
            return HorseLogic.decide(hero, gs, 'balanced', { aggression: 1.1, ...mods }, opts);
          };
          const clean = play({});
          expect(play(signals)).toEqual(clean);
          expect(play(signals, { v41Leaks: false })).toEqual(clean);
        }
      } finally {
        clock.mockRestore();
      }
    }
  );

  it('reports ignored evidence without issuing retired applied receipts', () => {
    enableBrainTelemetry();
    const { hero, gs } = topPairFacingPotBarrel();
    HorseLogic.decide(hero, gs, 'balanced', TAGGED_NLH, { telemetry: true });
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires.phase14_review_signal_ignored).toBe(1);
    expect(
      Object.keys(fires).some((k) => k.startsWith('v41_') || k === 'v40_leak_profile_read')
    ).toBe(false);
    HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: true });
    expect(drainFires().some((r) => r.feature === 'phase14_review_signal_ignored')).toBe(false);
    HorseLogic.decide(hero, gs, 'balanced', TAGGED_NLH, { telemetry: true, v41Leaks: false });
    expect(drainFires().some((r) => r.feature === 'phase14_review_signal_ignored')).toBe(false);
  });

  it('retains the structural river guard for a non-nut flush', () => {
    expect(rate(riverRaisedAfterBet, {}, (a) => a === 'raise' || a === 'all_in')).toBe(0);
  });

  it('retains the diagnostic sample threshold and legacy league option', () => {
    expect(LEAK_LOAD_TAGGED).toBe(0.08);
    expect(LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b.v41Leaks).toBe(false);
  });
});
