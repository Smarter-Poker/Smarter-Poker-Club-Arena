import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REMAINING_VARIANT_PACKS,
  REMAINING_VARIANT_DOMAIN,
  remainingVariantSeatCap,
} from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
// Pin the governor before any module can instantiate the live sampler singleton.
process.env.EQUITY_GOVERNOR = 'off';
const {
  REMAINING_VARIANT_LEAGUE_PROFILES,
  REMAINING_VARIANT_LEAGUE_SEEDS,
  runRemainingVariantLeague,
} = await import('../benchmark/RemainingVariantPolicyLeague.js');
const { remainingVariantReferenceSpots } =
  await import('../benchmark/RemainingVariantReferenceSpots.js');
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
    const match = /^--(output|pairs)=(.+)$/.exec(arg);
    if (!match || args.has(match[1]))
      throw new Error(
        'Usage: horse:remaining-variants-evaluate -- --output=NEW_DIRECTORY [--pairs=10]'
      );
    args.set(match[1], match[2]);
  }
  const pairs = Number(args.get('pairs') ?? 10);
  if (!args.has('output') || !Number.isInteger(pairs) || pairs < 1 || pairs > 32)
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
    await writeFile(
      resolve(output, 'frozen-population.json'),
      JSON.stringify(
        {
          startedAt,
          serverSourceAndLockSha256: hash,
          profiles: REMAINING_VARIANT_LEAGUE_PROFILES,
          seeds: REMAINING_VARIANT_LEAGUE_SEEDS,
          pairs,
          packs: REMAINING_VARIANT_PACKS,
          domain: REMAINING_VARIANT_DOMAIN,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx' }
    );
    const spots = remainingVariantReferenceSpots();
    const leagues = [];
    for (const profile of REMAINING_VARIANT_LEAGUE_PROFILES) {
      for (const seed of REMAINING_VARIANT_LEAGUE_SEEDS) {
        if (!running) break;
        const result = await runRemainingVariantLeague(
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
      throw new Error('Source changed during Remaining variant evaluation');
    const complete =
      leagues.length ===
        REMAINING_VARIANT_LEAGUE_PROFILES.length * REMAINING_VARIANT_LEAGUE_SEEDS.length &&
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
      version: 'remaining-variant-round1-evidence-v1',
      complete,
      scope: 'offline_basic_round_not_strength_certification',
      startedAt,
      finishedAt: new Date().toISOString(),
      serverSourceAndLockSha256: hash,
      nodeVersion: process.version,
      packs: REMAINING_VARIANT_PACKS,
      domain: REMAINING_VARIANT_DOMAIN,
      coverage: Object.fromEntries(
        (['short_deck', 'pineapple', 'flh', 'flo8'] as const).map((v) => [
          v,
          {
            cashSeats: remainingVariantSeatCap(v, 'cash'),
            maxStackBB:
              v === 'flh' || v === 'flo8'
                ? REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB
                : REMAINING_VARIANT_DOMAIN.maxStackBB,
            tournamentSeats: remainingVariantSeatCap(v, 'tournament'),
            postflopGeometryRows: { short_deck: 5880, pineapple: 2640, flh: 5880, flo8: 5340 }[v],
          },
        ])
      ),
      referenceScope:
        'eight exact terminal known-card settlements; 384 separate randomized settlement fixtures and exhaustive Short Deck ranking certification are tested independently',
      baselineWork:
        'recorded per league and decision; baseline uses variant iterations; Phase12 sampler requests32 before the pinned governor',
      pairsPerProfileSeed: pairs,
      referenceSpots: spots,
      leagues,
      promotionEligible: false,
      liveActivated: false,
    };
    await writeFile(
      resolve(output, 'phase12-evidence.json'),
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
    console.error(error instanceof Error ? error.message : 'Remaining variant evaluation failed');
    process.exitCode = 1;
  })
  .finally(() => {
    // HandController transitively imports the hub singleton. This standalone
    // offline command owns no sockets; stop its import-time lobby timer after
    // the awaited evidence write, including on invalid CLI requests.
    channelHub.close();
  });
