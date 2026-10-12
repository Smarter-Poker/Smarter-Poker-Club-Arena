/** One shard of the P10.2 PLO4 strength matrix (Horse Brain Phase 10).
 *
 *   tsx src/scripts/plo4StrengthEvaluate.ts --output=NEW_DIRECTORY \
 *     --profile=<contract profile id> --seed=<held-out seed> --shard=<k> --contract
 *
 * Without --contract it is a development run (--pairs=N allowed) on a
 * development seed and can never enter the verdict. Contract mode requires a
 * clean committed checkout, plays exactly the contract's pairs and writes
 * manifest.json and <profile>-<seed>-s<k>.json. A SIGTERM or SIGINT stops at
 * the next pair and still writes the incomplete result, so a lost runner
 * leaves a named attempt receipt rather than nothing. It writes local files
 * only and cannot activate a policy; server/scripts/phase10-strength-assemble.mjs
 * decides the verdict from every shard with the real contract.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Pin the governor before any module can instantiate the live sampler singleton.
process.env.EQUITY_GOVERNOR = 'off';
// Offline only: imported engine modules construct a database client at load
// time, so they get an address that resolves to nothing and a key that is not
// one. The league never reads or writes the database.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'plo4-strength-offline-placeholder';
const {
  PLO4_STRENGTH_CONTRACT,
  plo4StrengthContractDigest,
  plo4StrengthProfile,
  plo4StrengthShardKey,
  plo4StrengthShardReasons,
} = await import('../benchmark/Plo4StrengthContract.js');
const { runPlo4StrengthShard } = await import('../benchmark/Plo4PolicyLeague.js');
const { gtoChartCount } = await import('../engine/GtoCharts.js');
const { gtoPostflopCount } = await import('../engine/GtoPostflop.js');
const { gtoPostflopV31Count, gtoPostflopV31Dataset } = await import('../engine/GtoPostflopV31.js');
const { channelHub } = await import('../hub/ChannelHub.js');

const USAGE =
  'Usage: tsx src/scripts/plo4StrengthEvaluate.ts --output=NEW_DIRECTORY --profile=ID --seed=N --shard=K [--contract | --pairs=N]';
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

async function main(): Promise<number> {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(output|profile|seed|shard|pairs)=(.+)$/.exec(arg);
    if (arg === '--contract' && !args.has('contract')) args.set('contract', 'true');
    else if (!match || args.has(match[1])) throw new Error(USAGE);
    else args.set(match[1], match[2]);
  }
  const contract = args.has('contract');
  const seed = Number(args.get('seed'));
  const shard = Number(args.get('shard'));
  const profile = plo4StrengthProfile(args.get('profile') ?? '');
  if (!args.has('output') || !profile || !Number.isInteger(seed) || !Number.isInteger(shard))
    throw new Error(USAGE);
  if (contract && args.has('pairs')) throw new Error('A contract shard plays the contract pairs');
  const pairs = args.has('pairs') ? Number(args.get('pairs')) : undefined;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8' });
  if (contract && dirty) throw new Error('Contract evidence requires a clean committed checkout');
  const source = await fingerprint();
  const output = resolve(args.get('output')!);
  await mkdir(output, { recursive: false });
  const write = (name: string, data: unknown) =>
    writeFile(resolve(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  const key = plo4StrengthShardKey(profile.id, seed, shard);
  await write('manifest.json', {
    schema: 'horse-phase10-strength-manifest-v1',
    mode: contract ? 'contract' : 'development',
    head,
    dirty: Boolean(dirty),
    trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
    ...source,
    contractVersion: PLO4_STRENGTH_CONTRACT.version,
    contractDigest: plo4StrengthContractDigest(),
    packVersion: PLO4_STRENGTH_CONTRACT.candidate.packVersion,
    profileId: profile.id,
    seed,
    shard,
    pairs: pairs ?? PLO4_STRENGTH_CONTRACT.matrix.pairsPerShard,
    runtimeStores: {
      charts: gtoChartCount(),
      postflop: gtoPostflopCount(),
      postflopV31: gtoPostflopV31Count(),
      postflopV31Dataset: gtoPostflopV31Dataset(),
    },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    equityGovernor: 'off',
    activation: 'never',
    createdAt: new Date().toISOString(),
  });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const result = await runPlo4StrengthShard(
      { profileId: profile.id, seed, shard, mode: contract ? 'contract' : 'development', pairs },
      () => !cancelled
    );
    const sourceUnchanged =
      JSON.stringify(source) === JSON.stringify(await fingerprint()) &&
      head === execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await write(`${key}.json`, { ...result, sourceUnchanged, cancelled });
    const reasons = plo4StrengthShardReasons(result);
    console.log(
      JSON.stringify({
        shard: key,
        pairs: result.pairs,
        complete: result.complete,
        durationMs: result.durationMs,
        sourceUnchanged,
        cancelled,
        reasons,
      })
    );
    if (cancelled) return 130;
    return result.complete && sourceUnchanged && (!contract || reasons.length === 0) ? 0 : 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'P10.2 shard failed');
  code = 1;
} finally {
  // HandController transitively imports the hub singleton; this offline command
  // owns no sockets, so stop its import-time timer after the awaited write.
  channelHub.close();
}
process.exit(code);
