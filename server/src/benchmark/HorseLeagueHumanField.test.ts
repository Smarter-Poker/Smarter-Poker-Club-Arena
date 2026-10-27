/**
 * THE LEAGUE MEASURES THE HORSES AGAINST HUMANS, NOT ONLY AGAINST EACH OTHER
 * (2026-10-24)
 *
 * Every card on the nightly league was a MIRROR: all six seats horses, half on
 * config A and half on config B. That says what a layer is worth against
 * other horses. Live data says the fleet is roughly break-even against human
 * players before rake, so that is not the number that pays. A human-field
 * card (LeagueMatchup.opponentPopulation) seats ONE hero horse against the
 * human-calibrated population and replays each deal with the other arm.
 *
 * Pins:
 *  1. The field is what the name says: on a human-field card HorseLogic only
 *     ever decides for the hero seat, every other seat is seated as a human
 *     (`is_horse: false`) and decides through the calibrated population, and
 *     the population's responses are counted in the result.
 *  2. Duplicate deals survive: identical arms replay identical hands (the
 *     mirror invariant, now hero-vs-field), chips are conserved, the shared
 *     strategy RNG is left where it was found, and live HorseMind is untouched.
 *  3. Every human card on the standing card measures something: its arms
 *     diverge at a sample the suite can afford, so it is not INERT.
 *  4. The compute boundary validates the new shape exactly, refuses a result
 *     that contradicts itself, and refuses a result whose field does not match
 *     the request. A real worker thread returns the same numbers as a direct
 *     run.
 *  5. The nightly runner sends the human cards to the worker unchanged and
 *     records the field in config_a / config_b - no schema change.
 *  6. Variants without a qualified human profile are refused, not invented.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const { fromMock, rpcMock } = vi.hoisted(() => ({ fromMock: vi.fn(), rpcMock: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { from: fromMock, rpc: rpcMock } }));

import {
  HUMAN_FIELD_COMPONENT_SCENARIOS,
  HUMAN_FIELD_HERO_SEAT,
  HUMAN_FIELD_NAME_PREFIX,
  HUMAN_FIELD_VARIANTS,
  LEAGUE_MATCHUPS,
  leagueResultConfig,
  playHand,
  runLeague,
  runMatchup,
  type LeagueMatchup,
  type LeagueResult,
} from './HorseLeague.js';
import {
  HorseLeagueComputeWorkerClient,
  horseLeagueComputeResponseIsValid,
  type HorseLeagueCompute,
} from './HorseLeagueComputeWorkerClient.js';
import { HUMAN_CALIBRATED_POPULATION_ID } from './HumanCalibratedPopulation.js';
import { HorseLogic } from '../engine/HorseLogic.js';
import { HorseMind } from '../engine/HorseMind.js';
import { fastRandom, seedFastRandom } from '../engine/HorseEval.js';

const HUMAN = HUMAN_CALIBRATED_POPULATION_ID;
const humanCards = () =>
  LEAGUE_MATCHUPS.filter((m) => m.opponentPopulation === HUMAN_CALIBRATED_POPULATION_ID);

/** The human cards and the mirror card each one is the twin of. */
const EXPECTED_HUMAN_CARDS: Array<[string, string]> = [
  ['human_mind_layer', 'mind_layer'],
  ['human_v12_ranges_river', 'v12_ranges_river'],
  ['human_v7_preflop', 'v7_preflop'],
  ['human_v11_leak_fixes', 'v11_leak_fixes'],
  ['human_v10_strategy', 'v10_strategy'],
  ['human_v20_multiway', 'v20_multiway'],
  ['human_full_vs_v2_legacy', 'full_vs_v2_legacy'],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a human-field card seats the calibrated field, not horses', { timeout: 120_000 }, () => {
  it('HorseLogic decides only for the hero; every other seat is a human-calibrated non-horse', async () => {
    const seen = { hero: 0, other: 0, nonHeroHorseFlags: new Set<boolean>() };
    const original = HorseLogic.decide.bind(HorseLogic);
    vi.spyOn(HorseLogic, 'decide').mockImplementation((player, gs, style, mods, opts) => {
      if (player.seat === HUMAN_FIELD_HERO_SEAT + 1 && player.is_horse === true) seen.hero++;
      else seen.other++;
      for (const p of gs.players) {
        if (p.seat !== HUMAN_FIELD_HERO_SEAT + 1) seen.nonHeroHorseFlags.add(p.is_horse === true);
      }
      return original(player, gs, style, mods, opts);
    });
    const r = await runMatchup(
      { name: 'human_probe', a: {}, b: { mind: false }, opponentPopulation: HUMAN },
      60,
      20261024
    );
    expect(seen.hero).toBeGreaterThan(0);
    expect(seen.other, 'HorseLogic decided for a seat that should be human').toBe(0);
    expect([...seen.nonHeroHorseFlags]).toEqual([false]);

    expect(r.opponentPopulation).toBe(HUMAN);
    const decisions = Object.values(r.humanResponses ?? {}).reduce(
      (sum, node) => sum + Object.values(node).reduce((s, n) => s + n, 0),
      0
    );
    // Five calibrated seats act in every hand: far more decisions than hands.
    expect(decisions).toBeGreaterThan(r.hands);
    expect(Object.keys(r.humanResponses ?? {})).toContain('preflop/unopened');
    expect(r.illegalActions).toBe(0);
    expect(r.truncatedStreets).toBe(0);
    expect(r.hands).toBe(120);
    expect(r.benchmarkComponents.map((c) => c.scenario)).toEqual([
      ...HUMAN_FIELD_COMPONENT_SCENARIOS,
    ]);
    for (const c of r.benchmarkComponents) expect(c.hands).toBe(60);
  });

  it('bb100 is arm A minus arm B, per hero hand, from the same deals', async () => {
    const r = await runMatchup(
      { name: 'human_probe', a: {}, b: { mind: false }, opponentPopulation: HUMAN },
      80,
      4242
    );
    const [a, b] = r.benchmarkComponents;
    expect(r.bb100).toBeCloseTo(a.bb100 - b.bb100, 9);
  });

  it('conserves chips and seats humans as non-horses in a dealt hand', () => {
    const sb = HorseMind.createSandbox();
    const responses: Record<string, Record<string, number>> = {};
    for (let h = 0; h < 80; h++) {
      const net = playHand(
        3000 + h * 7919,
        (h % 6) + 1,
        () => ({}),
        undefined,
        sb,
        'nlh',
        6,
        100,
        undefined,
        undefined,
        { population: HUMAN, isHuman: (s) => s !== 0, responses }
      );
      expect(Math.abs(net.reduce((x, y) => x + y, 0)), `hand ${h} leaked chips`).toBeLessThan(1e-6);
    }
    expect(Object.keys(responses).length).toBeGreaterThan(0);
  });
});

describe('duplicate deals and isolation survive the human field', { timeout: 120_000 }, () => {
  beforeEach(() => HorseMind.reset());

  it('identical arms replay identical hands: the human-field mirror is inert by construction', async () => {
    const r = await runMatchup(
      { name: 'human_mirror', a: {}, b: {}, opponentPopulation: HUMAN },
      120,
      777
    );
    expect(r.divergentPairs).toBe(0);
    expect(r.inert).toBe(true);
    expect(r.bb100).toBe(0);
    expect(r.stderr).toBe(0);
    // Not because nothing happened: the hero won or lost chips every way.
    expect(r.benchmarkComponents[0].stderr).toBeGreaterThan(0);
  });

  it('is deterministic for a seed, leaves the shared RNG where it was, and never touches live memory', async () => {
    seedFastRandom(0xfeed1234);
    const before = fastRandom();
    seedFastRandom(0xfeed1234);
    const liveDirty = HorseMind.dirtyCount();
    const m: LeagueMatchup = {
      name: 'human_det',
      a: {},
      b: { v12: false },
      opponentPopulation: HUMAN,
    };
    const r1 = await runMatchup(m, 40, 99);
    expect(fastRandom()).toBe(before);
    const r2 = await runMatchup(m, 40, 99);
    expect(r1.bb100).toBe(r2.bb100);
    expect(r1.stderr).toBe(r2.stderr);
    expect(r1.humanResponses).toEqual(r2.humanResponses);
    expect(HorseMind.dirtyCount()).toBe(liveDirty);
    for (let s = 1; s <= 6; s++) {
      expect(HorseMind.getStats(`league-${s}`)).toBeUndefined();
      expect(HorseMind.getStats(`league-human-${s}`)).toBeUndefined();
    }
  });

  it('a mirror card (no field) is byte-for-byte what it was', async () => {
    const r = await runMatchup({ name: 'v11', a: {}, b: { v11: false } }, 40, 20260921);
    expect(r.opponentPopulation).toBeUndefined();
    expect(r.humanResponses).toBeUndefined();
    expect(r.benchmarkComponents).toEqual([]);
    expect(Object.keys(r).sort()).toEqual(
      [
        'matchup',
        'hands',
        'bb100',
        'stderr',
        'durationMs',
        'illegalActions',
        'truncatedStreets',
        'candidatePolicyHits',
        'candidateExecutionMismatches',
        'candidateNodeRoles',
        'benchmarkComponents',
        'divergentPairs',
        'inert',
      ].sort()
    );
  });

  it('refuses a variant without a qualified human profile instead of inventing one', async () => {
    expect(HUMAN_FIELD_VARIANTS).toEqual(['nlh']);
    await expect(
      runMatchup(
        {
          name: 'human_plo4',
          variant: 'plo4',
          a: {},
          b: { v15: false },
          opponentPopulation: HUMAN,
        },
        4,
        1
      )
    ).rejects.toThrow(/cannot deal plo4/);
    await expect(
      runMatchup(
        { name: 'human_x', a: {}, b: {}, opponentPopulation: 'not-a-population' as never },
        4,
        1
      )
    ).rejects.toThrow(/Unknown league opponent population/);
  });
});

describe(
  'the standing card carries human twins of the highest-value NLH layers',
  { timeout: 300_000 },
  () => {
    it('each human card is the human twin of a mirror card: same arms, NLH, named human_*', () => {
      const cards = humanCards();
      expect(cards.map((m) => m.name)).toEqual(EXPECTED_HUMAN_CARDS.map(([n]) => n));
      const byName = new Map(LEAGUE_MATCHUPS.map((m) => [m.name, m]));
      for (const [human, mirror] of EXPECTED_HUMAN_CARDS) {
        const h = byName.get(human)!;
        const m = byName.get(mirror);
        expect(m, `${mirror} left the card; ${human} has no mirror twin`).toBeDefined();
        expect(h.name.startsWith(HUMAN_FIELD_NAME_PREFIX)).toBe(true);
        expect(h.variant ?? 'nlh').toBe('nlh');
        expect(h.seats ?? 6).toBe(6);
        expect(h.a).toEqual(m!.a);
        expect(h.b).toEqual(m!.b);
        expect(m!.opponentPopulation).toBeUndefined();
      }
      // Only human cards carry the prefix, and every one of them carries a field.
      for (const m of LEAGUE_MATCHUPS) {
        expect(m.name.startsWith(HUMAN_FIELD_NAME_PREFIX)).toBe(m.opponentPopulation !== undefined);
      }
    });

    it.each(EXPECTED_HUMAN_CARDS.map(([n]) => n))(
      '%s: the two arms do not play identical poker against the field',
      async (name) => {
        const card = LEAGUE_MATCHUPS.find((m) => m.name === name)!;
        const r = await runMatchup(card, 400, 4242);
        expect(r.hands).toBe(800);
        expect(r.divergentPairs).toBeGreaterThan(0);
        expect(r.inert).toBe(false);
        expect(r.stderr).toBeGreaterThan(0);
        expect(
          horseLeagueComputeResponseIsValid({ type: 'MATCHUP_RESULT', jobId: 1, result: r })
        ).toBe(true);
      }
    );
  }
);

describe('the compute boundary knows the human-field shape exactly', { timeout: 120_000 }, () => {
  const wrap = (result: unknown) => ({ type: 'MATCHUP_RESULT', jobId: 1, result });
  let real: LeagueResult;
  beforeEach(async () => {
    real ??= await runMatchup(
      { name: 'human_v11', a: {}, b: { mind: false }, opponentPopulation: HUMAN },
      40,
      20261024
    );
  });

  it('accepts a real result and refuses every self-contradiction', () => {
    expect(horseLeagueComputeResponseIsValid(wrap(real))).toBe(true);
    const bad: Array<[string, unknown]> = [
      ['wrong population', { ...real, opponentPopulation: 'human-calibrated-v0' }],
      ['responses missing', (({ humanResponses: _h, ...rest }) => rest)(real)],
      ['population missing', (({ opponentPopulation: _p, ...rest }) => rest)(real)],
      ['no field decisions over dealt hands', { ...real, humanResponses: {} }],
      ['unknown action', { ...real, humanResponses: { 'flop/facing_bet': { shove: 1 } } }],
      ['negative count', { ...real, humanResponses: { 'flop/facing_bet': { call: -1 } } }],
      ['one component', { ...real, benchmarkComponents: real.benchmarkComponents.slice(0, 1) }],
      [
        'components swapped',
        { ...real, benchmarkComponents: [...real.benchmarkComponents].reverse() },
      ],
      [
        'component hands disagree',
        {
          ...real,
          benchmarkComponents: real.benchmarkComponents.map((c) => ({ ...c, hands: c.hands + 1 })),
        },
      ],
      ['inert contradicts divergence', { ...real, inert: !real.inert }],
      ['divergence evidence missing', (({ divergentPairs: _d, ...rest }) => rest)(real)],
    ];
    for (const [why, result] of bad) {
      expect(horseLeagueComputeResponseIsValid(wrap(result)), why).toBe(false);
    }
  });

  it('refuses a result whose field does not match the requested card', async () => {
    const { EventEmitter } = await import('node:events');
    class FakeWorker extends EventEmitter {
      readonly sent: Array<{ type: string; jobId: number }> = [];
      postMessage(m: { type: string; jobId: number }): void {
        this.sent.push(m);
      }
      async terminate(): Promise<number> {
        return 0;
      }
    }
    const ready = {
      type: 'READY',
      solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
    };
    const mirror = await runMatchup({ name: 'human_v11', a: {}, b: { mind: false } }, 20, 20261024);
    const cases: Array<[LeagueMatchup, LeagueResult]> = [
      // A human card answered by a mirror result: the field was dropped.
      [{ name: 'human_v11', a: {}, b: { mind: false }, opponentPopulation: HUMAN }, mirror],
      // A mirror card answered by a human-field result: a field was invented.
      [{ name: 'human_v11', a: {}, b: { mind: false } }, real],
    ];
    for (const [request, answer] of cases) {
      const worker = new FakeWorker();
      const client = new HorseLeagueComputeWorkerClient({
        workerFactory: () => worker as never,
        expectedSolverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
        readyTimeoutMs: 1_000,
        heartbeatTimeoutMs: 1_000,
      });
      worker.emit('message', ready);
      const pending = client.runMatchup(request, 20, 1);
      await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
      worker.emit('message', {
        type: 'MATCHUP_RESULT',
        jobId: worker.sent[0].jobId,
        result: answer,
      });
      await expect(pending).rejects.toThrow(/does not match the requested opponent field/);
      await client.shutdown();
    }
  });

  it('a real worker thread returns exactly the numbers a direct run does', async () => {
    const workerEntry = new URL('./HorseLeagueComputeWorker.ts', import.meta.url).href;
    const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const bootstrap =
      `import { register } from ${JSON.stringify(tsxApi)};` +
      `register(); await import(${JSON.stringify(workerEntry)});`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
      workerData: { hydrateSolverStores: false },
    });
    const client = new HorseLeagueComputeWorkerClient({
      workerFactory: () => worker,
      hydrateSolverStores: false,
      expectedSolverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
      readyTimeoutMs: 30_000,
      heartbeatTimeoutMs: 30_000,
    });
    onTestFinished(() => client.shutdown());
    const card = LEAGUE_MATCHUPS.find((m) => m.name === 'human_mind_layer')!;
    const direct = await runMatchup(card, 30, 0x5eed);
    const viaWorker = await client.runMatchup(card, 30, 0x5eed);
    const pick = (r: LeagueResult) => ({
      matchup: r.matchup,
      hands: r.hands,
      bb100: r.bb100,
      stderr: r.stderr,
      divergentPairs: r.divergentPairs,
      inert: r.inert,
      opponentPopulation: r.opponentPopulation,
      humanResponses: r.humanResponses,
      components: r.benchmarkComponents.map((c) => [c.scenario, c.hands, c.bb100, c.stderr]),
    });
    expect(pick(viaWorker)).toEqual(pick(direct));
  }, 90_000);
});

describe('the nightly runner sends the human cards and records their field', () => {
  beforeEach(() => {
    fromMock.mockReset();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ error: null });
  });

  it('every human card reaches the worker unchanged and is stored with its field in config_a/config_b', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T13:05:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const upserts: Array<Record<string, unknown>> = [];
    fromMock.mockImplementation(() => {
      const query = {
        order: vi.fn(() => query),
        // Nothing measured yet: staleness-first ordering keeps rotation order.
        limit: vi.fn(async () => ({ data: [], error: null })),
      };
      return {
        select: vi.fn(() => query),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        }),
      };
    });
    const requested: LeagueMatchup[] = [];
    const compute = {
      ready: vi.fn(async () => ({
        charts: 0,
        postflop: 0,
        postflopV31: 0,
        postflopV31Dataset: null,
      })),
      scoreSolverAgreement: vi.fn(async () => ({ reference: null }) as never),
      scoreGtoV31Agreement: vi.fn(async () => ({ reference: null }) as never),
      // A small real run per card, so what is stored is what the simulator said.
      runMatchup: vi.fn(async (m: LeagueMatchup, _pairs: number, seed: number) => {
        requested.push(m);
        return runMatchup(m, 2, seed);
      }),
      shutdown: vi.fn(async () => undefined),
    } as unknown as HorseLeagueCompute;

    const results = await runLeague(
      '2026-10-24',
      () => true,
      () => compute,
      () => true
    );
    const human = humanCards();
    expect(human.length).toBeGreaterThan(0);
    for (const card of human) {
      const sent = requested.find((m) => m.name === card.name);
      expect(sent, `${card.name} never reached the worker`).toBeDefined();
      expect(sent!.opponentPopulation).toBe(HUMAN);
      const row = upserts.find((u) => u.matchup === card.name)!;
      expect(row, `${card.name} was not written`).toBeDefined();
      expect(row.config_a).toEqual({ ...card.a, opponentPopulation: HUMAN });
      expect(row.config_b).toEqual({ ...card.b, opponentPopulation: HUMAN });
      expect(row.config_a).toEqual(leagueResultConfig(card, 'a'));
      expect(row.hands).toBe(4);
      const components = row.candidate_benchmark_components as Array<{ scenario: string }>;
      expect(components.map((c) => c.scenario)).toEqual([...HUMAN_FIELD_COMPONENT_SCENARIOS]);
      // The upsert carries no column that does not already exist.
      expect(Object.keys(row).sort()).toEqual(
        [
          'run_date',
          'matchup',
          'hands',
          'bb100',
          'stderr',
          'status',
          'refusal_reason',
          'config_a',
          'config_b',
          'duration_ms',
          'illegal_actions',
          'truncated_streets',
          'candidate_policy_hits',
          'candidate_execution_mismatches',
          'candidate_node_roles',
          'candidate_benchmark_components',
        ].sort()
      );
    }
    // A mirror card's configs are written exactly as before.
    const mirrorRow = upserts.find((u) => u.matchup === 'mind_layer')!;
    expect(mirrorRow.config_a).toEqual({});
    expect(mirrorRow.config_b).toEqual({ mind: false });
    expect(results.length).toBe(upserts.length);
  }, 300_000);
});
