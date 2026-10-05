/** One shard of one P12.2 Phase 12 strength matrix (Horse Brain Phase 12).
 *
 *   tsx src/scripts/remainingVariantStrengthEvaluate.ts \
 *     --variant=<short_deck|pineapple|flh|flo8> \
 *     --output=NEW_DIRECTORY --profile=<contract profile id> --seed=<held-out seed> \
 *     --shard=<k> --contract
 *
 * Without --contract it is a development run (--pairs=N allowed) on a
 * development seed and can never enter the verdict. Contract mode requires a
 * clean committed checkout, plays exactly the pack's pairs per shard and
 * writes manifest.json and <profile>-<seed>-s<k>.json. An unknown variant, or
 * a profile that is not that variant's, is refused before anything is
 * written. A SIGTERM or SIGINT stops at the next pair and still writes the
 * incomplete result, so a lost runner leaves a named attempt receipt rather
 * than nothing. It writes local files only and cannot activate a policy;
 * server/scripts/phase12-strength-assemble.mjs decides the verdict from every
 * shard of the pack with the real contract.
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
process.env.SUPABASE_SERVICE_ROLE_KEY = 'phase12-strength-offline-placeholder';
const {
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  isRemainingVariantStrengthVariant,
  remainingVariantStrengthContractDigest,
  remainingVariantStrengthPack,
  remainingVariantStrengthProfile,
  remainingVariantStrengthShardKey,
  remainingVariantStrengthShardReasons,
} = await import('../benchmark/RemainingVariantStrengthContract.js');
const { runRemainingVariantStrengthShard } =
  await import('../benchmark/RemainingVariantStrengthLeague.js');
const { gtoChartCount } = await import('../engine/GtoCharts.js');
const { gtoPostflopCount } = await import('../engine/GtoPostflop.js');
const { gtoPostflopV31Count, gtoPostflopV31Dataset } = await import('../engine/GtoPostflopV31.js');
const { channelHub } = await import('../hub/ChannelHub.js');

const USAGE =
  'Usage: tsx src/scripts/remainingVariantStrengthEvaluate.ts --variant=short_deck|pineapple|flh|flo8 --output=NEW_DIRECTORY --profile=ID --seed=N --shard=K [--contract | --pairs=N]';
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
    const match = /^--(variant|output|profile|seed|shard|pairs)=(.+)$/.exec(arg);
    if (arg === '--contract' && !args.has('contract')) args.set('contract', 'true');
    else if (!match || args.has(match[1])) throw new Error(USAGE);
    else args.set(match[1], match[2]);
  }
  const variant = args.get('variant');
  if (!isRemainingVariantStrengthVariant(variant))
    throw new Error(`Unknown P12.2 variant. ${USAGE}`);
  const contract = args.has('contract');
  const seed = Number(args.get('seed'));
  const shard = Number(args.get('shard'));
  const profile = remainingVariantStrengthProfile(variant, args.get('profile') ?? '');
  if (!profile) throw new Error(`Unknown ${variant} contract profile. ${USAGE}`);
  if (!args.has('output') || !Number.isInteger(seed) || !Number.isInteger(shard))
    throw new Error(USAGE);
  if (contract && args.has('pairs')) throw new Error('A contract shard plays the contract pairs');
  const pairs = args.has('pairs') ? Number(args.get('pairs')) : undefined;
  const pack = remainingVariantStrengthPack(variant);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8' });
  if (contract && dirty) throw new Error('Contract evidence requires a clean committed checkout');
  const source = await fingerprint();
  const output = resolve(args.get('output')!);
  await mkdir(output, { recursive: false });
  const write = (name: string, data: unknown) =>
    writeFile(resolve(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  const key = remainingVariantStrengthShardKey(profile.id, seed, shard);
  await write('manifest.json', {
    schema: 'horse-phase12-strength-manifest-v1',
    mode: contract ? 'contract' : 'development',
    variant,
    head,
    dirty: Boolean(dirty),
    trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
    ...source,
    contractVersion: REMAINING_VARIANT_STRENGTH_CONTRACT.version,
    contractDigest: remainingVariantStrengthContractDigest(),
    packVersion: pack.candidate.packVersion,
    profileId: profile.id,
    seed,
    shard,
    pairs: pairs ?? pack.matrix.pairsPerShard,
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
    const result = await runRemainingVariantStrengthShard(
      variant,
      { profileId: profile.id, seed, shard, mode: contract ? 'contract' : 'development', pairs },
      () => !cancelled
    );
    const sourceUnchanged =
      JSON.stringify(source) === JSON.stringify(await fingerprint()) &&
      head === execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await write(`${key}.json`, { ...result, sourceUnchanged, cancelled });
    const reasons = remainingVariantStrengthShardReasons(variant, result);
    console.log(
      JSON.stringify({
        variant,
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
  console.error(error instanceof Error ? error.message : 'P12.2 shard failed');
  code = 1;
} finally {
  // HandController transitively imports the hub singleton; this offline command
  // owns no sockets, so stop its import-time timer after the awaited write.
  channelHub.close();
}
process.exit(code);
