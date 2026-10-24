/** The locked V53 flag card decision from downloaded shard results.
 *
 * tsx src/scripts/horseTournamentCardSummarize.ts --card=plo4_v53_icm_mtt --input=/dir [--output=/file]
 *
 * Reads every `<card>-<seed>-<firstPair>.json` under --input (recursively),
 * applies summarizeTournamentFlagCard, prints the verdict and writes it.
 * Exit 0 only when the card is fully measured; `wins` says whether it beat
 * today's brain.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  summarizeTournamentFlagCard,
  tournamentFlagCard,
  type TournamentLeagueResult,
} from '../benchmark/HorseTournamentLeague.js';
import { horseLeagueComputeResponseIsValid } from '../benchmark/HorseLeagueComputeWorkerClient.js';

const arg = (name: string): string | undefined =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const card = tournamentFlagCard(arg('card'));
if (!card) throw new Error('--card must name a TOURNAMENT_FLAG_CARDS entry');
const input = resolve(arg('input') ?? '.');

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.startsWith(`${card!.name}-`) && entry.name.endsWith('.json')) yield path;
  }
}
const runs: TournamentLeagueResult[] = [];
for await (const path of files(input)) {
  const result = JSON.parse(await readFile(path, 'utf8'));
  // The same structural guard the parent applies at the worker boundary.
  if (!horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result }))
    throw new Error(`${path} is not a valid tournament league result`);
  runs.push(result);
}
const summary = summarizeTournamentFlagCard(card.name, runs);
console.log(JSON.stringify(summary, null, 2));
const out = arg('output');
if (out) await writeFile(resolve(out), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
process.exit(summary.measured ? 0 : 1);
