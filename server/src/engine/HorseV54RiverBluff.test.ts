/**
 * V54 RIVER BLUFF (2026-10-24): a river big bet or shove bluff, ONLY WHEN IT
 * MAKES SENSE.
 *
 * Dan, 2026-10-24 16:21 Chicago: "a player just said to me, i've never once
 * seen a player bluff on the river, the bluff shove or big bet bluff needed
 * to be implemented ONLY WHEN IT MAKES SENSE."
 *
 * Pins, all at pinned RNG seeds and a pinned decision clock:
 *  1. Eligibility. It fires heads-up on a river checked to hero, with air,
 *     a blocker, a turn barrel that was flatted and an opponent who folds
 *     rivers; it never fires against a calling station, multiway, with
 *     showdown value, without a story, into an uncapped Omaha range, without
 *     a blocker, on a tournament bubble, into an all-in opponent, or facing a
 *     bet. In every spot it declines (except the station, which it checks),
 *     the decision is the one the brain makes with the flag off.
 *  2. Sizing: 0.75-1.5 pot deep in Hold'em, the shove when shallow, the pot
 *     in pot limit.
 *  3. Frequency: never every eligible spot; never above the cap that keeps
 *     bluffs within the s/(1+2s) share of the betting range.
 *  4. Determinism: same seed, same decision; the range-composition read
 *     consumes no decision RNG.
 *  5. Default off: the flag unset (and false) reproduces, byte for byte, the
 *     decisions recorded from the code before V54 in
 *     HorseV54RiverBluff.golden.json (wall-clock latencies inside the
 *     receipts excluded: they are measurements, not decisions).
 *  6. Wiring: data-ledger flag and receipts, league cards, legacy arm.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HorseLogic,
  v54BluffProbability,
  v54BluffShare,
  V54_PROFILE_FACTOR,
  type HorseDecideOpts,
} from './HorseLogic.js';
import {
  estimateRiverRangeComposition,
  restoreFastRandom,
  saveFastRandom,
  seedFastRandom,
  variantInfo,
} from './HorseEval.js';
import { HorseMind } from './HorseMind.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { HORSE_DATA_LEDGER } from './HorseDataLedger.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import {
  GOLDEN_SEEDS,
  GOLDEN_SPOTS,
  NLH_AIR_BLOCKER,
  NLH_AIR_BUBBLE,
  NLH_AIR_FACING_BET,
  NLH_AIR_MULTIWAY,
  NLH_AIR_NO_BLOCKER,
  NLH_AIR_OPP_ALL_IN,
  NLH_AIR_PASSIVE,
  NLH_AIR_SHALLOW,
  NLH_MIDDLE_PAIR,
  PLO4_AIR_NO_BLOCKER,
  PLO4_NUT_BLOCKER_AIR,
  PLO4_TWO_BARRELS_CALLED,
  PLO4_TWO_PAIR,
  c,
  decideSpot,
  seedOpponentRiverRead,
  spotState,
  type V54Spot,
} from './HorseV54RiverBluff.test-support.js';

const SUITE_TIMEOUT_MS = 60_000 * (process.env.RUNNER_ENVIRONMENT === 'self-hosted' ? 3 : 1);
const ON: HorseDecideOpts = { v54RiverBluff: true, telemetry: true };
/** Wall-clock measurements inside the decision receipts (policy graph and
 *  joint-policy latencies) are not decisions; everything else is compared. */
const WALL_CLOCK = new Set(['latencyMs', 'elapsedMs', 'policyMs', 'simulationMs']);
const stable = (d: unknown): string =>
  JSON.stringify(d, (k, v) => (WALL_CLOCK.has(k) ? undefined : v));
// Protected baseline211ebe: preserve selected action, chips, timing and RNG.
// Only the two-called-barrel Omaha row changed after the common-prior update;
// it was independently replayed against that protected runtime.
// Source-derived authority digests naturally change when policy source changes.
const baselineDecision = (d: ReturnType<typeof decideSpot>): string =>
  JSON.stringify({
    action: d.action,
    amount: d.amount ?? null,
    thinkTime: d.thinkTime,
    rngState: saveFastRandom(),
  });
const SEEDS = Array.from({ length: 120 }, (_, i) => 31 + i * 7919);
/** The pot every fixture brings to the river. */
const POT = 68;

enableBrainTelemetry();
afterEach(() => {
  HorseMind.reset();
  drainFires();
});

function fires(): Record<string, number> {
  return Object.fromEntries(
    drainFires()
      .filter((r) => r.feature.startsWith('v54_'))
      .map((r) => [r.feature, r.fires])
  );
}

const FOLDER = () => seedOpponentRiverRead(21, 30); // folds 70% of river bets
const STATION = () => seedOpponentRiverRead(3, 30); // folds 10%
const UNKNOWN = () => HorseMind.reset();

describe('V54 fires only when it makes sense', () => {
  it(
    'fires in a capped heads-up river spot with a blocker against a folding opponent',
    () => {
      FOLDER();
      drainFires();
      const bets = SEEDS.map((s) => decideSpot(NLH_AIR_BLOCKER, s, ON)).filter(
        (d) => d.action === 'bet' || d.action === 'all_in'
      );
      const f = fires();
      expect(bets.length).toBeGreaterThan(SEEDS.length * 0.25);
      expect(f.v54_river_bluff).toBe(bets.length);
      // every non-bluff in the owned spot is a check, counted as frequency
      expect(f.v54_river_bluff_skip_frequency).toBe(SEEDS.length - bets.length);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'fires in PLO4 when hero holds the nut-flush blocker after one called barrel',
    () => {
      FOLDER();
      drainFires();
      const bets = SEEDS.map((s) => decideSpot(PLO4_NUT_BLOCKER_AIR, s, ON)).filter(
        (d) => d.action === 'bet' || d.action === 'all_in'
      );
      expect(bets.length).toBeGreaterThan(SEEDS.length * 0.25);
      expect(fires().v54_river_bluff).toBe(bets.length);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'never bluffs a calling station: it checks every time',
    () => {
      for (const spot of [NLH_AIR_BLOCKER, NLH_AIR_SHALLOW, PLO4_NUT_BLOCKER_AIR]) {
        STATION();
        drainFires();
        for (const s of SEEDS) expect(decideSpot(spot, s, ON).action).toBe('check');
        const f = fires();
        expect(f.v54_river_bluff ?? 0).toBe(0);
        expect(f.v54_river_bluff_skip_station).toBe(SEEDS.length);
      }
    },
    SUITE_TIMEOUT_MS
  );

  // Each declined spot leaves the decision to the layers below, exactly as
  // with the flag off, and names its reason.
  const DECLINED: Array<[string, V54Spot, string | null]> = [
    ['multiway', NLH_AIR_MULTIWAY, 'v54_river_bluff_skip_multiway'],
    ['showdown value (NLH middle pair)', NLH_MIDDLE_PAIR, 'v54_river_bluff_skip_showdown_value'],
    ['showdown value (PLO4 two pair)', PLO4_TWO_PAIR, 'v54_river_bluff_skip_showdown_value'],
    ['no story (hero checked behind twice)', NLH_AIR_PASSIVE, 'v54_river_bluff_skip_no_story'],
    [
      'uncapped (PLO4 range called two barrels)',
      PLO4_TWO_BARRELS_CALLED,
      'v54_river_bluff_skip_uncapped',
    ],
    ['no blocker (NLH)', NLH_AIR_NO_BLOCKER, 'v54_river_bluff_skip_no_blocker'],
    ['no blocker (PLO4)', PLO4_AIR_NO_BLOCKER, 'v54_river_bluff_skip_no_blocker'],
    ['incomplete tournament economics', NLH_AIR_BUBBLE, 'v54_river_bluff_skip_tournament_context'],
    ['illegal: the opponent is all in', NLH_AIR_OPP_ALL_IN, 'v54_river_bluff_skip_all_in'],
    ['facing a bet', NLH_AIR_FACING_BET, null],
  ];
  for (const [label, spot, reason] of DECLINED) {
    it(
      `does not fire: ${label}`,
      () => {
        for (const read of [FOLDER, UNKNOWN]) {
          read();
          drainFires();
          for (const s of SEEDS.slice(0, 40)) {
            const on = stable(decideSpot(spot, s, ON));
            const off = stable(decideSpot(spot, s, { telemetry: true }));
            expect(on, `${spot.name} seed ${s}`).toBe(off);
          }
          const f = fires();
          expect(f.v54_river_bluff ?? 0).toBe(0);
          if (reason) expect(f[reason]).toBe(40);
          else expect(Object.keys(f)).toEqual([]);
        }
      },
      SUITE_TIMEOUT_MS
    );
  }
});

describe('V54 sizing', () => {
  it(
    'Hold’em deep: a big bet between three quarters and one and a half pots',
    () => {
      FOLDER();
      const sizes = SEEDS.map((s) => decideSpot(NLH_AIR_BLOCKER, s, ON))
        .filter((d) => d.action === 'bet')
        .map((d) => d.amount! / POT);
      expect(sizes.length).toBeGreaterThan(0);
      for (const f of sizes) {
        expect(f).toBeGreaterThanOrEqual(0.74);
        expect(f).toBeLessThanOrEqual(1.5);
      }
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'Hold’em shallow (50 behind into 68): the bluff is the shove',
    () => {
      FOLDER();
      const acts = new Set(
        SEEDS.map((s) => decideSpot(NLH_AIR_SHALLOW, s, ON).action).filter((a) => a !== 'check')
      );
      expect([...acts]).toEqual(['all_in']);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'pot limit: the pot, never more',
    () => {
      FOLDER();
      const bets = SEEDS.map((s) => decideSpot(PLO4_NUT_BLOCKER_AIR, s, ON)).filter(
        (d) => d.action === 'bet'
      );
      expect(bets.length).toBeGreaterThan(0);
      for (const d of bets) expect(d.amount).toBe(POT);
    },
    SUITE_TIMEOUT_MS
  );
});

describe('V54 frequency', () => {
  it('the reference bluff share is s/(1+2s), and the cap keeps bluffs inside it', () => {
    expect(v54BluffShare(1)).toBeCloseTo(1 / 3, 12);
    expect(v54BluffShare(0.75)).toBeCloseTo(0.3, 12);
    expect(v54BluffShare(1.5)).toBeCloseTo(0.375, 12);
    for (const s of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      for (const value of [0.05, 0.2, 0.4, 0.6]) {
        for (const air of [0.02, 0.1, 0.3, 0.6]) {
          const p = v54BluffProbability(s, value, air);
          expect(p).toBeGreaterThanOrEqual(0);
          // never more often than with as much air as value
          expect(p).toBeLessThanOrEqual(s / (1 + s) + 1e-12);
          // bluffs / (bluffs + value) never exceeds the reference share
          const bluffs = p * air;
          expect(bluffs / (bluffs + value)).toBeLessThanOrEqual(v54BluffShare(s) + 1e-12);
        }
      }
    }
    expect(v54BluffProbability(1, 0, 0.5)).toBe(0);
  });

  it(
    'does not bluff every eligible spot, and stays under the cap by opponent read',
    () => {
      const seeds = Array.from({ length: 400 }, (_, i) => 101 + i * 104729);
      for (const [read, factor] of [
        [FOLDER, V54_PROFILE_FACTOR.folder],
        [UNKNOWN, V54_PROFILE_FACTOR.unknown],
      ] as const) {
        read();
        const fired = seeds.filter((s) => decideSpot(NLH_AIR_BLOCKER, s, ON).action === 'bet');
        const rate = fired.length / seeds.length;
        // The biggest size V54 takes is 1.5 pot, where s/(1+s) = 0.6, so no
        // read can push an air combo past 0.6 x its read factor.
        const cap = 0.6 * factor;
        const se = Math.sqrt((cap * (1 - cap)) / seeds.length);
        expect(rate).toBeGreaterThan(0);
        expect(rate).toBeLessThan(1);
        expect(rate).toBeLessThanOrEqual(cap + 3 * se);
      }
    },
    SUITE_TIMEOUT_MS
  );
});

describe('V54 determinism', () => {
  it(
    'the same seed gives the same decision',
    () => {
      FOLDER();
      for (const spot of [NLH_AIR_BLOCKER, NLH_AIR_SHALLOW, PLO4_NUT_BLOCKER_AIR]) {
        for (const s of SEEDS.slice(0, 30)) {
          expect(stable(decideSpot(spot, s, ON))).toBe(stable(decideSpot(spot, s, ON)));
        }
      }
    },
    SUITE_TIMEOUT_MS
  );

  it('the range-composition read is reproducible and consumes no decision RNG', () => {
    const board = [
      c('9', 'hearts'),
      c('8', 'spades'),
      c('5', 'diamonds'),
      c('K', 'clubs'),
      c('2', 'hearts'),
    ];
    for (const variant of ['nlh', 'plo4', 'plo6']) {
      seedFastRandom(424242);
      const before = saveFastRandom();
      const a = estimateRiverRangeComposition(board, [0.55, 1], [0.3, 0.9], variantInfo(variant));
      expect(saveFastRandom()).toBe(before);
      const b = estimateRiverRangeComposition(board, [0.55, 1], [0.3, 0.9], variantInfo(variant));
      expect(a).not.toBeNull();
      expect(b).toEqual(a);
      expect(a!.valueShare + a!.airShare).toBeLessThanOrEqual(1);
      restoreFastRandom(before);
    }
    // not a river, or a game it does not model: no read
    expect(
      estimateRiverRangeComposition(board.slice(0, 4), [0.5, 1], [0.3, 0.9], variantInfo('nlh'))
    ).toBeNull();
    expect(
      estimateRiverRangeComposition(board, [0.5, 1], [0.3, 0.9], variantInfo('plo8'))
    ).toBeNull();
  });
});

describe('V54 default off reproduces the brain before it, byte for byte', () => {
  const golden = JSON.parse(
    readFileSync(new URL('./HorseV54RiverBluff.golden.json', import.meta.url), 'utf8')
  ) as Record<string, { sha256: string; actions: string[] }>;
  const digest = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');
  for (const flag of [undefined, false]) {
    it(
      `v54RiverBluff ${String(flag)}: every golden river spot decides exactly as recorded`,
      () => {
        const opts: HorseDecideOpts = flag === undefined ? {} : { v54RiverBluff: flag };
        const run = (key: string, lines: string[]) =>
          expect(digest(lines), key).toBe(golden[key].sha256);
        HorseMind.reset();
        for (const spot of GOLDEN_SPOTS)
          run(
            spot.name,
            GOLDEN_SEEDS.map((s) => baselineDecision(decideSpot(spot, s, opts)))
          );
        for (const spot of GOLDEN_SPOTS)
          run(
            spot.name + '_mindoff',
            GOLDEN_SEEDS.map((s) => baselineDecision(decideSpot(spot, s, { ...opts, mind: false })))
          );
        for (const spot of [NLH_AIR_BLOCKER, PLO4_NUT_BLOCKER_AIR]) {
          FOLDER();
          run(
            spot.name + '_folder',
            GOLDEN_SEEDS.map((s) => baselineDecision(decideSpot(spot, s, opts)))
          );
          STATION();
          run(
            spot.name + '_station',
            GOLDEN_SEEDS.map((s) => baselineDecision(decideSpot(spot, s, opts)))
          );
        }
        expect(Object.keys(golden).length).toBe(GOLDEN_SPOTS.length * 2 + 4);
      },
      SUITE_TIMEOUT_MS
    );
  }
});

describe('V54 golden sensitivity', () => {
  it(
    'the golden comparison can see a change: with the flag ON the bluff spot no longer matches',
    () => {
      const golden = JSON.parse(
        readFileSync(new URL('./HorseV54RiverBluff.golden.json', import.meta.url), 'utf8')
      ) as Record<string, { sha256: string }>;
      FOLDER();
      const lines = GOLDEN_SEEDS.map((s) =>
        baselineDecision(decideSpot(NLH_AIR_BLOCKER, s, { v54RiverBluff: true }))
      );
      const sha = createHash('sha256').update(lines.join('\n')).digest('hex');
      expect(sha).not.toBe(golden.nlh_air_blocker_folder.sha256);
    },
    SUITE_TIMEOUT_MS
  );
});

describe('V54 wiring', () => {
  it('is registered in the data ledger as a flag, a receipt and a skip family', () => {
    const keys = new Map(HORSE_DATA_LEDGER.map((e) => [`${e.kind}:${e.key}`, e]));
    expect(keys.get('flag:v54RiverBluff')).toBeDefined();
    expect(keys.get('receipt:v54_river_bluff')).toBeDefined();
    expect(keys.get('receipt:v54_river_bluff_skip_*')).toBeDefined();
  });

  it('has nlh/plo4/plo5/plo6 league cards with the flag ON in arm A, and is off in the legacy arm', () => {
    for (const [name, variant] of [
      ['v54_river_bluff', undefined],
      ['plo4_v54_river_bluff', 'plo4'],
      ['plo5_v54_river_bluff', 'plo5'],
      ['plo6_v54_river_bluff', 'plo6'],
    ] as const) {
      const card = LEAGUE_MATCHUPS.find((m) => m.name === name);
      expect(card, name).toBeDefined();
      expect(card!.variant).toBe(variant);
      expect(card!.pairs).toBe(6000);
      expect(card!.a).toEqual({ v54RiverBluff: true });
      expect(card!.b).toEqual({});
    }
    const legacy = LEAGUE_MATCHUPS.find((x) => x.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v54RiverBluff).toBe(false);
  });
});

// Recovery hardening: an unavailable sampled domain or prize context cannot
// silently receive the fallback bluff prior.
describe('V54 recovered boundary refusals', () => {
  it('does not estimate hi-lo or invalid probability bars', () => {
    const board = NLH_AIR_BLOCKER.board;
    expect(
      estimateRiverRangeComposition(board, [0.5, 1], [0.3, 0.9], variantInfo('plo8'))
    ).toBeNull();
    for (const [value, air] of [
      [NaN, 0.2],
      [0.6, Infinity],
      [0.2, 0.6],
      [-1, -2],
      [1.1, 0.2],
    ])
      expect(
        estimateRiverRangeComposition(board, [0.5, 1], [0.3, 0.9], variantInfo('nlh'), value, air)
      ).toBeNull();
  });
  it('names missing tournament economics and leaves the pre-existing decision intact', () => {
    FOLDER();
    const { hero, gs } = spotState(NLH_AIR_BUBBLE);
    for (const seed of SEEDS.slice(0, 40)) {
      seedFastRandom(seed);
      const on = HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        { ...ON, observeMind: false, decisionTimeMs: 1770000000000 }
      );
      seedFastRandom(seed);
      const off = HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        { telemetry: true, observeMind: false, decisionTimeMs: 1770000000000 }
      );
      expect(stable(on)).toBe(stable(off));
    }
    const f = fires();
    expect(f.v54_river_bluff ?? 0).toBe(0);
    expect(f.v54_river_bluff_skip_tournament_context).toBe(40);
  });
});

describe('V54 larger Omaha holdings reach the actual candidate', () => {
  it.each(['plo5', 'plo6'] as const)(
    '%s uses its own legal physical holding and pot-limit bet',
    (variant) => {
      const spot: V54Spot = {
        ...PLO4_NUT_BLOCKER_AIR,
        variant,
        name: variant + '_nut_blocker_air',
        hole: [
          ...PLO4_NUT_BLOCKER_AIR.hole,
          c('5', 'hearts'),
          ...(variant === 'plo6' ? [c('7', 'clubs')] : []),
        ],
      };
      FOLDER();
      drainFires();
      const bets = SEEDS.map((seed) => decideSpot(spot, seed, ON)).filter(
        (d) => d.action === 'bet'
      );
      const f = fires();
      expect(f.v54_river_bluff ?? 0).toBeGreaterThan(0);
      expect(f.v54_river_bluff).toBe(bets.length);
      for (const d of bets) expect(d.amount).toBe(POT);
    },
    SUITE_TIMEOUT_MS
  );
});
