import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.EQUITY_GOVERNOR = 'off';
const { JOINT_LEAGUE_PROFILES, JOINT_LEAGUE_SEEDS, runJointPolicyLeague } =
  await import('../benchmark/JointPolicyLeague.js');
const { JOINT_LIVE_DOMAIN } = await import('../engine/multiway/JointLivePolicy.js');
const { JOINT_RANGE_PACK } = await import('../engine/multiway/JointRangeSampler.js');
const { JOINT_ACTION_PACK } = await import('../engine/multiway/JointActionModel.js');
const { channelHub } = await import('../hub/ChannelHub.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
async function sourceHash() {
  const hash = createHash('sha256');
  async function walk(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const full = resolve(path, name);
      if ((await stat(full)).isDirectory()) await walk(full);
      else {
        hash.update(full.slice(root.length));
        hash.update('\0');
        hash.update(await readFile(full));
      }
    }
  }
  await walk(resolve(root, 'src'));
  hash.update(await readFile(resolve(root, 'package-lock.json')));
  return hash.digest('hex');
}
async function main() {
  const values = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--(output|pairs)=(.+)$/.exec(arg);
    if (!m || values.has(m[1]))
      throw new Error('Usage: jointPolicyEvaluate --output=NEW_DIRECTORY [--pairs=10]');
    values.set(m[1], m[2]);
  }
  const count = Number(values.get('pairs') ?? 10);
  if (!values.has('output') || !Number.isInteger(count) || count < 10 || count > 32)
    throw new Error('New output and 10-32 pairs required for full relative positions');
  const output = resolve(values.get('output')!);
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
    // Persist the immutable population/seeds/work contract before any outcome.
    await writeFile(
      resolve(output, 'frozen-population.json'),
      JSON.stringify(
        {
          startedAt,
          sourceHash: hash,
          profiles: JOINT_LEAGUE_PROFILES,
          seeds: JOINT_LEAGUE_SEEDS,
          pairs: count,
          domain: JOINT_LIVE_DOMAIN,
          ranges: JOINT_RANGE_PACK,
          responses: JOINT_ACTION_PACK,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx' }
    );
    const leagues = [];
    outer: for (const profile of JOINT_LEAGUE_PROFILES)
      for (const seed of JOINT_LEAGUE_SEEDS) {
        if (!running) break outer;
        const r = await runJointPolicyLeague(
          { profileId: profile.id, pairs: count, seed },
          () => running
        );
        leagues.push(r);
        await writeFile(
          resolve(output, profile.id + '-' + seed + '.json'),
          JSON.stringify(r, null, 2) + '\n',
          { flag: 'wx' }
        );
        console.log(
          JSON.stringify({
            profile: profile.id,
            seed,
            complete: r.complete,
            pairs: r.completedPairs,
            changed: r.changed,
            illegal: r.illegalActions,
            conservation: r.conservationErrors,
          })
        );
        if (!r.complete) break outer;
      }
    if (hash !== (await sourceHash()))
      throw new Error('Source changed during frozen joint evaluation');
    const complete =
      leagues.length === JOINT_LEAGUE_PROFILES.length * JOINT_LEAGUE_SEEDS.length &&
      leagues.every(
        (r) =>
          r.complete &&
          r.positionCoverageComplete &&
          !r.illegalActions &&
          !r.conservationErrors &&
          !r.cardErrors &&
          !r.truncatedHands &&
          r.pairs.some((p) => (p.candidate.joint?.fired ?? 0) > 0) &&
          (!r.profile.tournament ||
            r.pairs.some((p) => (p.candidate.joint?.utilityEvaluated ?? 0) > 0))
      );
    const criticalBuckets = leagues
      .map((r) => ({
        profile: r.profile.id,
        seed: r.seed,
        mean: r.meanAfterRakeDifferenceBbPerHand,
        confidence99: r.confidence99,
        metricScope: r.metricScope,
        changed: r.changed,
        eligible: r.pairs.reduce((n, p) => n + p.candidate.eligible, 0),
      }))
      .sort((a, b) => (a.mean ?? -Infinity) - (b.mean ?? -Infinity));
    await writeFile(
      resolve(output, 'phase13-evidence.json'),
      JSON.stringify(
        {
          version: 'joint-round1-evidence-v1',
          startedAt,
          finishedAt: new Date().toISOString(),
          serverSourceAndLockSha256: hash,
          nodeVersion: process.version,
          complete,
          profileSeedRuns: leagues.length,
          pairsPerProfileSeed: count,
          promotionEligible: false,
          liveActivated: false,
          scope: 'offline_bounded_first_round_not_strength_certification',
          criticalBuckets,
          leagues,
        },
        null,
        2
      ) + '\n',
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
    console.error(error instanceof Error ? error.message : 'Joint evaluation failed');
    process.exitCode = 1;
  })
  .finally(() => channelHub.close());
