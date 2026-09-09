/**
 * Offline promotion card for a sealed V31 candidate.
 *
 * The live engine never calls this module. It builds the exact cash, Spin,
 * tournament chip-EV, and tournament ICM contexts required by Phase 4 and
 * runs the ordinary duplicate-deal simulator against the active incumbent.
 * Multi-context families are reduced with a weighted mean and an independent
 * standard-error combination; every component remains attached as evidence.
 */

import {
  runMatchup,
  type LeagueBenchmarkComponent,
  type LeagueGameContext,
  type LeagueMatchup,
  type LeagueResult,
} from './HorseLeague.js';

export type GtoV31EvaluationFamily = 'cash' | 'spin' | 'tourney_ev' | 'tourney_icm';
export type GtoV31EvaluationKind = 'paired_replay' | 'league';

export interface GtoV31EvaluationScenario {
  key: string;
  family: GtoV31EvaluationFamily;
  pairs: number;
  matchup: LeagueMatchup;
}

const HEX64 = /^[0-9a-f]{64}$/;
const TOTAL_PAIRS = 5_000;

const tournamentContext = (
  tournament: NonNullable<LeagueGameContext['tournament']>,
  format: 'mtt' | 'spin' = 'mtt'
): LeagueGameContext => ({
  gameMode: 'tournament',
  format,
  ante: 0,
  tournament,
});

function candidateArms(
  datasetChecksum: string,
  kind: GtoV31EvaluationKind
): Pick<LeagueMatchup, 'a' | 'b'> {
  if (!HEX64.test(datasetChecksum) || datasetChecksum === '0'.repeat(64)) {
    throw new Error('a sealed V31 dataset checksum is required');
  }
  // Paired replay isolates the candidate policy from every adaptive read and
  // side effect. The league card deliberately leaves the full brain enabled
  // inside HorseLeague's private sandboxes, so it measures the candidate in
  // the same decision stack production uses without touching live memory.
  if (kind === 'paired_replay') {
    return {
      a: { gtoV31DatasetChecksum: datasetChecksum, mind: false, telemetry: false },
      b: { mind: false, telemetry: false },
    };
  }
  return {
    a: { gtoV31DatasetChecksum: datasetChecksum },
    b: {},
  };
}

/**
 * The scenarios are intentionally explicit. A Spin ladder is not chip EV,
 * and a satellite, bubble, final table, ITM ladder, and generic ICM ladder
 * are distinct utility contexts even when they share cards and blinds.
 */
export function buildGtoV31EvaluationScenarios(
  family: GtoV31EvaluationFamily,
  kind: GtoV31EvaluationKind,
  datasetChecksum: string
): GtoV31EvaluationScenario[] {
  const arms = candidateArms(datasetChecksum, kind);
  const prefix = `gto_v31_${kind}_${family}`;
  if (family === 'cash') {
    return [
      {
        key: 'cash_ev',
        family,
        pairs: TOTAL_PAIRS,
        matchup: {
          name: `${prefix}_cash_ev`,
          seats: 2,
          stackBB: 80,
          context: { gameMode: 'cash', format: 'cash', ante: 0 },
          ...arms,
        },
      },
    ];
  }
  if (family === 'spin') {
    return [
      {
        key: 'chip_ev',
        family,
        pairs: TOTAL_PAIRS / 2,
        matchup: {
          name: `${prefix}_chip_ev`,
          seats: 3,
          stackBB: 20,
          context: tournamentContext(
            {
              playersLeft: 3,
              spotsPaid: 1,
              avgStackChips: 40,
              stacks: [44, 40, 36],
              payoutPct: [1],
            },
            'spin'
          ),
          ...arms,
        },
      },
      {
        key: 'spin_ladder',
        family,
        pairs: TOTAL_PAIRS / 2,
        matchup: {
          name: `${prefix}_spin_ladder`,
          seats: 3,
          stackBB: 20,
          context: tournamentContext(
            {
              playersLeft: 3,
              spotsPaid: 2,
              avgStackChips: 40,
              stacks: [46, 40, 34],
              payoutPct: [0.8, 0.2],
            },
            'spin'
          ),
          ...arms,
        },
      },
    ];
  }
  if (family === 'tourney_ev') {
    return [
      {
        key: 'chip_ev',
        family,
        pairs: TOTAL_PAIRS,
        matchup: {
          name: `${prefix}_chip_ev`,
          seats: 6,
          stackBB: 40,
          context: tournamentContext({
            playersLeft: 72,
            spotsPaid: 12,
            avgStackChips: 80,
          }),
          ...arms,
        },
      },
    ];
  }

  const stacks = [160, 128, 104, 80, 56, 32];
  const base = {
    playersLeft: 18,
    spotsPaid: 6,
    avgStackChips: 80,
    stacks,
    payoutPct: [0.34, 0.23, 0.16, 0.11, 0.09, 0.07],
  };
  const utilities: Array<{
    key: string;
    tournament: NonNullable<LeagueGameContext['tournament']>;
  }> = [
    {
      key: 'satellite',
      tournament: {
        ...base,
        playersLeft: 9,
        spotsPaid: 6,
        satellite: true,
        satelliteSeats: 6,
        payoutPct: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6],
      },
    },
    { key: 'bubble', tournament: { ...base, playersLeft: 7, nearBubble: true } },
    {
      key: 'final_table',
      tournament: { ...base, playersLeft: 6, spotsPaid: 4, finalTable: true },
    },
    { key: 'in_money', tournament: { ...base, playersLeft: 5, spotsPaid: 6, inMoney: true } },
    { key: 'ladder', tournament: base },
  ];
  return utilities.map(({ key, tournament }) => ({
    key,
    family,
    pairs: TOTAL_PAIRS / utilities.length,
    matchup: {
      name: `${prefix}_${key}`,
      seats: 6,
      stackBB: 40,
      context: tournamentContext(tournament),
      ...arms,
    },
  }));
}

function asComponent(
  scenario: GtoV31EvaluationScenario,
  result: LeagueResult
): LeagueBenchmarkComponent {
  return {
    scenario: scenario.key,
    hands: result.hands,
    bb100: result.bb100,
    stderr: result.stderr,
    durationMs: result.durationMs,
    illegalActions: result.illegalActions,
    truncatedStreets: result.truncatedStreets,
    candidatePolicyHits: result.candidatePolicyHits,
    candidateExecutionMismatches: result.candidateExecutionMismatches,
    candidateNodeRoles: [...result.candidateNodeRoles],
  };
}

export function aggregateGtoV31Evaluation(
  name: string,
  components: LeagueBenchmarkComponent[]
): LeagueResult {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('V31 evaluation has no benchmark components');
  }
  const hands = components.reduce((total, component) => total + component.hands, 0);
  if (hands <= 0) throw new Error('V31 evaluation has no completed hands');
  const bb100 =
    components.reduce((total, component) => total + component.bb100 * component.hands, 0) / hands;
  const stderr =
    Math.sqrt(
      components.reduce((total, component) => total + (component.stderr * component.hands) ** 2, 0)
    ) / hands;
  return {
    matchup: name,
    hands,
    bb100,
    stderr,
    durationMs: components.reduce((total, component) => total + component.durationMs, 0),
    illegalActions: components.reduce((total, component) => total + component.illegalActions, 0),
    truncatedStreets: components.reduce(
      (total, component) => total + component.truncatedStreets,
      0
    ),
    candidatePolicyHits: components.reduce(
      (total, component) => total + component.candidatePolicyHits,
      0
    ),
    candidateExecutionMismatches: components.reduce(
      (total, component) => total + component.candidateExecutionMismatches,
      0
    ),
    candidateNodeRoles: [
      ...new Set(components.flatMap((component) => component.candidateNodeRoles)),
    ].sort(),
    benchmarkComponents: components.map((component) => ({ ...component })),
  };
}

export async function runGtoV31EvaluationFamily(args: {
  family: GtoV31EvaluationFamily;
  kind: GtoV31EvaluationKind;
  datasetChecksum: string;
  runSeed: number;
  shouldContinue?: () => boolean;
}): Promise<LeagueResult> {
  const scenarios = buildGtoV31EvaluationScenarios(args.family, args.kind, args.datasetChecksum);
  const components: LeagueBenchmarkComponent[] = [];
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index];
    const result = await runMatchup(
      scenario.matchup,
      scenario.pairs,
      (args.runSeed ^ ((index + 1) * 0x9e3779b9)) >>> 0,
      args.shouldContinue
    );
    components.push(asComponent(scenario, result));
  }
  return aggregateGtoV31Evaluation(
    `gto_v31_${args.kind}_${args.family}_${args.datasetChecksum}`,
    components
  );
}
