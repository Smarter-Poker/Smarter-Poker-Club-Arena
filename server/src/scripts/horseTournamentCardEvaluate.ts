/** One protected registered card shard; cannot activate any strategy. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'tournament-card-offline-placeholder';
const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--(source-sha|card|cell|output|plan)=(.+)$/.exec(arg);
  if (!m || args.has(m[1])) throw Error('Unknown or duplicate argument');
  args.set(m[1], m[2]);
}
for (const key of ['source-sha', 'card', 'output'])
  if (!args.has(key)) throw Error('Missing ' + key);
const { tournamentFlagCells, tournamentFlagHash, TOURNAMENT_FLAG_DESIGN } =
  await import('../benchmark/HorseTournamentFlagContract.js');
const { assertTournamentFlagSource, tournamentFlagProvider } =
  await import('../benchmark/HorseTournamentFlagQualification.js');
const plan = JSON.parse(
  await readFile(new URL('../benchmark/HorseTournamentFlagPlan.json', import.meta.url), 'utf8')
);
const sourceSha = args.get('source-sha')!,
  card = args.get('card')!,
  output = resolve(args.get('output')!);
const source = assertTournamentFlagSource(plan, sourceSha);
const cells = tournamentFlagCells(card);
if (args.has('plan')) {
  if (args.get('plan') !== 'true' || args.has('cell')) throw Error('Plan does not deal a cell');
  await writeFile(
    output,
    JSON.stringify(
      {
        plan,
        planDigest: tournamentFlagHash(plan),
        sourceSha,
        ...source,
        card,
        matrix: cells,
        activation: false,
      },
      null,
      2
    ) + '\n',
    { flag: 'wx' }
  );
  process.exit(0);
}
const cell = cells.find((c) => c.key === args.get('cell'));
if (!cell) throw Error('Unknown registered cell');
const provider = await tournamentFlagProvider(card, cell.key);
await mkdir(output, { recursive: false });
const manifest = {
  schema: 'horse-tournament-flag-result-v1',
  sourceSha,
  sourceDigest: source.runtimeSourceDigest,
  dependencyDigest: source.dependencyDigest,
  workflowDigest: source.workflowDigest,
  planDigest: tournamentFlagHash(plan),
  designDigest: plan.designDigest,
  field: TOURNAMENT_FLAG_DESIGN.field,
  card,
  cell,
  reporter: provider.reporter,
};
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
  flag: 'wx',
});
const { HorseLeagueComputeWorkerClient } =
  await import('../benchmark/HorseLeagueComputeWorkerClient.js');
const { gtoChartCount } = await import('../engine/GtoCharts.js');
const { gtoPostflopCount } = await import('../engine/GtoPostflop.js');
const { gtoPostflopV31Count, gtoPostflopV31Dataset } = await import('../engine/GtoPostflopV31.js');
const client = new HorseLeagueComputeWorkerClient({
  hydrateSolverStores: false,
  expectedSolverStores: {
    charts: gtoChartCount(),
    postflop: gtoPostflopCount(),
    postflopV31: gtoPostflopV31Count(),
    postflopV31Dataset: gtoPostflopV31Dataset(),
  },
});
let cancelled = false,
  code = 1;
process.once('SIGINT', () => (cancelled = true));
process.once('SIGTERM', () => (cancelled = true));
try {
  await client.ready();
  const result = await client.runTournamentLeague(
    {
      objective: card.endsWith('_mtt') ? 'mtt' : 'sng',
      flagCard: card,
      seed: cell.seed,
      firstPair: cell.firstPair,
      pairs: cell.pairs,
      evidenceMode: 'fixture',
      opponentPopulation: TOURNAMENT_FLAG_DESIGN.field,
      flagQualification: {
        sourceSha,
        planDigest: tournamentFlagHash(plan),
        providerRunId: provider.reporter!.runId,
        providerJobId: provider.reporter!.jobId,
        runAttempt: 1,
      },
    },
    () => !cancelled
  );
  assertTournamentFlagSource(plan, sourceSha);
  code = cancelled
    ? 130
    : result.complete &&
        result.illegalActions === 0 &&
        result.conservationErrors === 0 &&
        result.truncatedHands === 0
      ? 0
      : 1;
  await writeFile(
    resolve(output, 'result.json'),
    JSON.stringify(
      { ...manifest, result, resultDigest: tournamentFlagHash(result), originalExitCode: code },
      null,
      2
    ) + '\n',
    { flag: 'wx' }
  );
} finally {
  await client.shutdown();
}
process.exit(code);
