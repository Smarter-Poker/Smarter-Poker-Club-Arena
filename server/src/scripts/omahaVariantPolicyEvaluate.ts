import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OMAHA_VARIANT_PACKS,
  OMAHA_VARIANT_DOMAIN,
  omahaVariantSeatCap,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
// Pin the governor before any module can instantiate the live sampler singleton.
process.env.EQUITY_GOVERNOR = 'off';
const { OMAHA_VARIANT_LEAGUE_PROFILES, OMAHA_VARIANT_LEAGUE_SEEDS, runOmahaVariantLeague } =
  await import('../benchmark/OmahaVariantPolicyLeague.js');
const { omahaVariantReferenceSpots } = await import('../benchmark/OmahaVariantPolicyEvidence.js');
const { evaluateOmahaVariantProgram } = await import('../benchmark/OmahaVariantPolicyProgram.js');
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
        'Usage: horse:omaha-variants-evaluate -- --output=NEW_DIRECTORY [--pairs=10] [--samples=32]'
      );
    args.set(match[1], match[2]);
  }
  const pairs = Number(args.get('pairs') ?? 10),
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
    const spots = [];
    for (const fixture of omahaVariantReferenceSpots()) {
      const receipt = await evaluateOmahaVariantProgram(
        { ...fixture.input, samples },
        () => running
      );
      if (
        !receipt.equity?.complete ||
        Math.abs(receipt.equity.equity - fixture.expectedShare) > 0.0001 ||
        !receipt.livePolicy.fired
      )
        throw new Error(`Variant reference failed: ${fixture.name}`);
      spots.push({ ...fixture, receipt });
    }
    const leagues = [];
    for (const profile of OMAHA_VARIANT_LEAGUE_PROFILES) {
      for (const seed of OMAHA_VARIANT_LEAGUE_SEEDS) {
        if (!running) break;
        const result = await runOmahaVariantLeague(
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
    if (hash !== (await sourceHash()))
      throw new Error('Source changed during Omaha variant evaluation');
    const complete =
      leagues.length === OMAHA_VARIANT_LEAGUE_PROFILES.length * OMAHA_VARIANT_LEAGUE_SEEDS.length &&
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
      version: 'omaha-variant-round1-evidence-v1',
      complete,
      scope: 'offline_basic_round_not_strength_certification',
      startedAt,
      finishedAt: new Date().toISOString(),
      serverSourceAndLockSha256: hash,
      nodeVersion: process.version,
      packs: OMAHA_VARIANT_PACKS,
      domain: OMAHA_VARIANT_DOMAIN,
      coverage: Object.fromEntries(
        (['plo5', 'plo6', 'plo8'] as const).map((v) => [
          v,
          {
            cashSeats: omahaVariantSeatCap(v, 'cash'),
            tournamentSeats: omahaVariantSeatCap(v, 'tournament'),
            preflopCoordinates: { plo5: 925320, plo6: 539880, plo8: 1310760 }[v],
            postflopGeometryRows: { plo5: 4260, plo6: 2820, plo8: 5340 }[v],
          },
        ])
      ),
      oracleSamplesPerReferenceSpot: samples,
      baselineWork: 'recorded per league and decision; oracle samples do not control HorseLogic',
      pairsPerProfileSeed: pairs,
      referenceSpots: spots,
      leagues,
      promotionEligible: false,
      liveActivated: false,
    };
    await writeFile(
      resolve(output, 'phase11-evidence.json'),
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
    console.error(error instanceof Error ? error.message : 'Omaha variant evaluation failed');
    process.exitCode = 1;
  })
  .finally(() => {
    // HandController transitively imports the hub singleton. This standalone
    // offline command owns no sockets; stop its import-time lobby timer after
    // the awaited evidence write, including on invalid CLI requests.
    channelHub.close();
  });
