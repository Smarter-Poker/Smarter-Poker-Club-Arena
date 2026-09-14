/** Offline tournament evidence through the existing low-priority process.
 * tsx src/scripts/horseTournamentEvaluate.ts --output=/absolute/new-directory
 * Add --promotion for the frozen 3 x 6 x 1024 matrix with hydrated stores.
 * This command writes local receipts only. It cannot activate a live policy.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HorseLeagueComputeWorkerClient } from '../benchmark/HorseLeagueComputeWorkerClient.js';
import {
  TOURNAMENT_LEAGUE_OBJECTIVES,
  TOURNAMENT_PROMOTION_PAIRS,
  TOURNAMENT_PROMOTION_SEEDS,
  summarizeTournamentPromotion,
  tournamentBaselineRunVerified,
  type TournamentLeagueResult,
} from '../benchmark/HorseTournamentLeague.js';
import { gtoChartCount } from '../engine/GtoCharts.js';
import { gtoPostflopCount } from '../engine/GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../engine/GtoPostflopV31.js';
import { loadGtoCharts } from '../services/GtoChartLoader.js';
import { loadGtoPostflop } from '../services/GtoPostflopLoader.js';
import { loadGtoPostflopV31 } from '../services/GtoPostflopV31Loader.js';

const outputArg = process.argv.find((v) => v.startsWith('--output='))?.slice('--output='.length);
if (!outputArg) throw new Error('--output is required; use a new evidence directory');
const output = resolve(outputArg);
const promotion = process.argv.includes('--promotion');
const hydrate = promotion || process.argv.includes('--hydrate');
const objectiveArg = process.argv
  .find((v) => v.startsWith('--objective='))
  ?.slice('--objective='.length);
const selectedObjective = TOURNAMENT_LEAGUE_OBJECTIVES.find((v) => v === objectiveArg);
if (objectiveArg && !selectedObjective) throw new Error('Unknown tournament objective');
const seedArg = process.argv.find((v) => v.startsWith('--seed='))?.slice('--seed='.length);
const selectedSeed = TOURNAMENT_PROMOTION_SEEDS.find((v) => v === Number(seedArg));
if (seedArg && !selectedSeed) throw new Error('A shard must use a predeclared promotion seed');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const diff = execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8' });
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
async function fingerprint() {
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src'],
    { encoding: 'utf8', cwd: serverRoot }
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path + '\0');
    hash.update(await readFile(resolve(serverRoot, path)));
    hash.update('\0');
  }
  return {
    sourceSha256: hash.digest('hex'),
    sourceFiles: paths.length,
    serverLockSha256: createHash('sha256')
      .update(await readFile(resolve(serverRoot, 'package-lock.json')))
      .digest('hex'),
  };
}
const source = await fingerprint();
if (promotion && dirty) throw new Error('Promotion evidence requires a clean committed checkout');
await mkdir(output, { recursive: false });
const write = (name: string, data: unknown) =>
  writeFile(resolve(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
if (hydrate) {
  const url = process.env.SUPABASE_URL ?? 'https://kuklfnapbkmacvwxktbh.supabase.co';
  if (new URL(url).hostname !== 'kuklfnapbkmacvwxktbh.supabase.co')
    throw new Error('Approved solver-store project is required');
  await Promise.all([loadGtoCharts(), loadGtoPostflop(), loadGtoPostflopV31()]);
}
const stores = {
  charts: gtoChartCount(),
  postflop: gtoPostflopCount(),
  postflopV31: gtoPostflopV31Count(),
  postflopV31Dataset: gtoPostflopV31Dataset(),
};
const manifest = {
  mode: promotion ? 'promotion' : 'fixture',
  head,
  dirty: Boolean(dirty),
  trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
  ...source,
  solverStores: stores,
  seeds: selectedSeed ? [selectedSeed] : promotion ? TOURNAMENT_PROMOTION_SEEDS : [901791],
  pairs: promotion ? TOURNAMENT_PROMOTION_PAIRS : 4,
  objectives: selectedObjective ? [selectedObjective] : TOURNAMENT_LEAGUE_OBJECTIVES,
  requiredMatrix: {
    seeds: TOURNAMENT_PROMOTION_SEEDS,
    objectives: TOURNAMENT_LEAGUE_OBJECTIVES,
    pairs: TOURNAMENT_PROMOTION_PAIRS,
  },
  activation: 'never',
  equityGovernor: 'off_in_isolated_compute_process',
  createdAt: new Date().toISOString(),
};
await write('manifest.json', manifest);
let cancelled = false;
process.once('SIGINT', () => {
  cancelled = true;
});
process.once('SIGTERM', () => {
  cancelled = true;
});
const client = new HorseLeagueComputeWorkerClient({
  hydrateSolverStores: hydrate,
  expectedSolverStores: stores,
});
const runs: TournamentLeagueResult[] = [];
let baselineVerified = false;
try {
  await client.ready();
  outer: for (const seed of manifest.seeds)
    for (const objective of manifest.objectives) {
      if (cancelled) break outer;
      const result = await client.runTournamentLeague(
        {
          objective,
          seed,
          pairs: manifest.pairs,
          evidenceMode: promotion ? 'promotion' : 'fixture',
        },
        () => !cancelled
      );
      runs.push(result);
      await write(`${objective}-${seed}.json`, result);
      console.log(
        JSON.stringify({
          objective,
          seed,
          pairs: result.pairs,
          complete: result.complete,
          fired: result.fired,
          eligible: result.eligible,
          changed: result.changed,
          meanDifference: result.meanDifference,
          confidence99: result.confidence99,
          illegalActions: result.illegalActions,
          p99: result.latencyMs.p99,
          promotionEligible: result.promotionEligible,
        })
      );
      if (!result.complete) break outer;
    }
} finally {
  await client.shutdown();
  await write('summary.json', summarizeTournamentPromotion(runs));
  const sourceUnchanged =
    JSON.stringify(source) === JSON.stringify(await fingerprint()) &&
    head === execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  baselineVerified =
    sourceUnchanged &&
    runs.length === manifest.seeds.length * manifest.objectives.length &&
    runs.every(tournamentBaselineRunVerified);
  await write('baseline-verification.json', {
    version: runs[0]?.version,
    complete: baselineVerified,
    scope: 'software_baseline_not_strength_promotion',
    sourceUnchanged,
    runs: runs.map((run) => ({
      objective: run.objective,
      seed: run.seed,
      verified: tournamentBaselineRunVerified(run),
      eligible: run.eligible,
      fired: run.fired,
      budgetExhaustions: run.budgetExhaustions,
      p99: run.latencyMs.p99,
    })),
  });
}
// Imported engine services may own unrelated referenced handles. This CLI is
// complete only after its child has exited and its final receipt is durable.
process.exit(cancelled ? 130 : baselineVerified ? 0 : 1);
