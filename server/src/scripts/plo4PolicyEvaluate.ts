import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLO4_POLICY_PACK, plo4CoverageMatrix } from '../engine/plo4/Plo4PolicyPack.js';
// Pin the governor before any module can instantiate the live sampler singleton.
process.env.EQUITY_GOVERNOR = 'off';
const { PLO4_LEAGUE_PROFILES, PLO4_LEAGUE_SEEDS, runPlo4PolicyLeague } =
  await import('../benchmark/Plo4PolicyLeague.js');
const { runPlo4ReferenceSpots } = await import('../benchmark/Plo4PolicyEvidence.js');
const { channelHub } = await import('../hub/ChannelHub.js');

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
async function sourceHash() {
  const hash = createHash('sha256');
  async function visit(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const full = resolve(path, name);
      if ((await stat(full)).isDirectory()) await visit(full);
      else {
        hash.update(full.slice(serverRoot.length));
        hash.update('\0');
        hash.update(await readFile(full));
      }
    }
  }
  await visit(resolve(serverRoot, 'src'));
  hash.update(await readFile(resolve(serverRoot, 'package-lock.json')));
  return hash.digest('hex');
}
async function main() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(output|pairs|samples)=(.+)$/.exec(arg);
    if (!match || args.has(match[1]))
      throw new Error(
        'Usage: horse:plo4-evaluate -- --output=NEW_DIRECTORY [--pairs=2] [--samples=32]'
      );
    args.set(match[1], match[2]);
  }
  const pairs = Number(args.get('pairs') ?? 2),
    samples = Number(args.get('samples') ?? 32);
  if (
    !args.has('output') ||
    !Number.isInteger(pairs) ||
    pairs < 1 ||
    pairs > 32 ||
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 128
  )
    throw new Error('A new output directory and bounded whole-number work budgets are required');
  const output = resolve(args.get('output')!);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  let running = true;
  const cancel = () => {
    running = false;
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const startedAt = new Date().toISOString(),
      hash = await sourceHash();
    const spots = await runPlo4ReferenceSpots(samples);
    const leagues = [];
    for (const profile of PLO4_LEAGUE_PROFILES) {
      for (const seed of PLO4_LEAGUE_SEEDS) {
        if (!running) break;
        const result = await runPlo4PolicyLeague(
          { profileId: profile.id, pairs, seed },
          () => running
        );
        leagues.push(result);
        console.log(
          JSON.stringify({
            profile: profile.id,
            seed,
            complete: result.complete,
            pairs: result.completedPairs,
            changed: result.changed,
            illegal: result.illegalActions,
            conservation: result.conservationErrors,
          })
        );
        if (!result.complete) {
          running = false;
          break;
        }
      }
      if (!running) break;
    }
    if (hash !== (await sourceHash())) throw new Error('Source changed during PLO4 evaluation');
    const complete =
      leagues.length === PLO4_LEAGUE_PROFILES.length * PLO4_LEAGUE_SEEDS.length &&
      leagues.every(
        (r) =>
          r.complete &&
          r.positionCoverageComplete &&
          !r.illegalActions &&
          !r.conservationErrors &&
          !r.cardErrors &&
          !r.truncatedHands
      );
    const evidence = {
      version: PLO4_POLICY_PACK.version,
      complete,
      scope: 'offline_basic_round_not_strength_certification',
      startedAt,
      finishedAt: new Date().toISOString(),
      serverSourceAndLockSha256: hash,
      nodeVersion: process.version,
      pack: PLO4_POLICY_PACK,
      coverage: plo4CoverageMatrix(),
      oracleSamplesPerReferenceSpot: samples,
      baselineWork: 'recorded per league and decision; oracle samples do not control HorseLogic',
      pairsPerProfileSeed: pairs,
      referenceSpots: spots,
      leagues,
      promotionEligible: false,
      liveActivated: false,
    };
    await writeFile(
      resolve(output, 'phase10-evidence.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' }
    );
    console.log(JSON.stringify({ complete, profileSeedRuns: leagues.length, output }));
    if (!complete) process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'PLO4 evaluation failed');
    process.exitCode = 1;
  })
  .finally(() => {
    // HandController transitively imports the hub singleton. This standalone
    // offline command owns no sockets; stop its import-time lobby timer after
    // the awaited evidence write, including on invalid CLI requests.
    channelHub.close();
  });
