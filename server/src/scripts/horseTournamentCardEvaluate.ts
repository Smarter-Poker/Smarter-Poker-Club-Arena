/** One shard of a V53 tournament flag card through the low-priority league process.
 *
 * tsx src/scripts/horseTournamentCardEvaluate.ts --output=/absolute/new-directory \
 *   --card=plo4_v53_icm_mtt --seed=53101101 --first-pair=0 --pairs=64 [--field=human|horse]
 *
 * Writes the shard's result and manifest only. It cannot activate a live
 * policy: the decision is made by horseTournamentCardSummarize.ts from every
 * shard of every held-out seed (summarizeTournamentFlagCard), and a winning
 * card is switched on by a reviewed change to the flag's default.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HorseLeagueComputeWorkerClient } from '../benchmark/HorseLeagueComputeWorkerClient.js';
import {
  TOURNAMENT_FLAG_CARD_PAIRS,
  TOURNAMENT_FLAG_CARD_SEEDS,
  tournamentFlagCard,
} from '../benchmark/HorseTournamentLeague.js';
import { HUMAN_CALIBRATED_POPULATION_ID } from '../benchmark/HumanCalibratedPopulation.js';
import { gtoChartCount } from '../engine/GtoCharts.js';
import { gtoPostflopCount } from '../engine/GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../engine/GtoPostflopV31.js';

const arg = (name: string): string | undefined =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputArg = arg('output');
if (!outputArg) throw new Error('--output is required; use a new evidence directory');
const output = resolve(outputArg);
const card = tournamentFlagCard(arg('card'));
if (!card) throw new Error('--card must name a TOURNAMENT_FLAG_CARDS entry');
const seed = Number(arg('seed'));
if (!TOURNAMENT_FLAG_CARD_SEEDS.includes(seed as never))
  throw new Error('--seed must be a predeclared held-out flag card seed');
const firstPair = Number(arg('first-pair') ?? 0);
const pairs = Number(arg('pairs') ?? TOURNAMENT_FLAG_CARD_PAIRS);
if (
  !Number.isSafeInteger(firstPair) ||
  !Number.isSafeInteger(pairs) ||
  firstPair < 0 ||
  pairs < 1 ||
  firstPair + pairs > TOURNAMENT_FLAG_CARD_PAIRS
)
  throw new Error('--first-pair/--pairs must lie inside the locked pair range');
const field = arg('field') ?? 'human';
if (field !== 'human' && field !== 'horse') throw new Error('--field is human or horse');

await mkdir(output, { recursive: false });
const write = (name: string, data: unknown) =>
  writeFile(resolve(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
await write('manifest.json', {
  mode: 'flag_card_shard',
  head,
  dirty: Boolean(dirty),
  card,
  seed,
  firstPair,
  pairs,
  field,
  activation: 'never',
  equityGovernor: 'off_in_isolated_compute_process',
  createdAt: new Date().toISOString(),
});

let cancelled = false;
process.once('SIGINT', () => (cancelled = true));
process.once('SIGTERM', () => (cancelled = true));
// Omaha never consults the hold'em solver stores, and the field is the same
// brain in both arms, so the shard needs no database and no secret.
const client = new HorseLeagueComputeWorkerClient({
  hydrateSolverStores: false,
  expectedSolverStores: {
    charts: gtoChartCount(),
    postflop: gtoPostflopCount(),
    postflopV31: gtoPostflopV31Count(),
    postflopV31Dataset: gtoPostflopV31Dataset(),
  },
});
let ok = false;
try {
  await client.ready();
  const result = await client.runTournamentLeague(
    {
      objective: card.objective,
      seed,
      pairs,
      firstPair,
      flagCard: card.name,
      evidenceMode: 'fixture',
      ...(field === 'human' ? { opponentPopulation: HUMAN_CALIBRATED_POPULATION_ID } : {}),
    },
    () => !cancelled
  );
  await write(`${card.name}-${seed}-${firstPair}.json`, result);
  console.log(
    JSON.stringify({
      card: card.name,
      seed,
      firstPair,
      pairs: result.pairs,
      complete: result.complete,
      meanDifference: result.meanDifference,
      cardDecisions: result.cardDecisions,
      cardChanged: result.cardChanged,
      divergentPairs: result.divergentPairs,
      illegalActions: result.illegalActions,
      conservationErrors: result.conservationErrors,
      truncatedHands: result.truncatedHands,
    })
  );
  ok =
    result.complete &&
    result.illegalActions === 0 &&
    result.conservationErrors === 0 &&
    result.truncatedHands === 0;
} finally {
  await client.shutdown();
}
process.exit(cancelled ? 130 : ok ? 0 : 1);
