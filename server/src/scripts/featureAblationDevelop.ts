/** Finite development-only flag pilot. This CLI has no holdout/activation mode,
 * database client credential, scheduled service or production writer. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'feature-ablation-offline-placeholder';
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m =
    /^--(experiment|variant|profile|seed|pairs|start-pair|proposed-owner-head|output|inspect)=(.+)$/.exec(
      a
    );
  if (!m || args.has(m[1])) throw new Error('Unknown/duplicate development argument');
  args.set(m[1], m[2]);
}
for (const key of ['experiment', 'variant', 'profile', 'seed', 'pairs', 'output'])
  if (!args.has(key)) throw new Error(`Missing --${key}`);
const { hydrateFrozenFeatureAblationStores } =
  await import('../benchmark/FeatureAblationStores.js');
const { createFeatureAblationWorker } = await import('../benchmark/FeatureAblationWorker.js');
const { runFeatureAblationDevelopment, ablationPilotMoments } =
  await import('../benchmark/FeatureAblationLeague.js');
const { PLO6_V24_DEVELOPMENT_DESIGN, plo6V24DevelopmentSpec, plo6V24DevelopmentProfile } =
  await import('../benchmark/Plo6V24Qualification.js');
const {
  V53_PRESSURE_DEVELOPMENT_DESIGN,
  V53_PRESSURE_DEVELOPMENT_SEEDS,
  V53_PRESSURE_RESERVED_HOLDOUT_SEEDS,
  pressureDevelopmentSpec,
  pressureDevelopmentProfiles,
  V53_PRESSURE_WARM_SEED,
} = await import('../benchmark/PressureQualificationContract.js');
const {
  isIncrementalTarget,
  INCREMENTAL_DEVELOPMENT_DESIGN,
  INCREMENTAL_DEVELOPMENT_SEEDS,
  INCREMENTAL_RESERVED_HOLDOUT_SEEDS,
  INCREMENTAL_WARM_SEED,
  incrementalDevelopmentProfiles,
  incrementalDevelopmentSpec,
  buildIncrementalWarmRecords,
  incrementalWarmCoverage,
} = await import('../benchmark/IncrementalPressureDevelopment.js');
const { buildPressureWarmRecords, makeFeatureAblationOwnHistory, featureAblationHistoryDigest } =
  await import('../benchmark/FeatureAblationHistory.js');
const { horseObserverReadContextFromRequest } =
  await import('../engine/HorseObserverReadContext.js');
const { enableBrainTelemetry } = await import('../engine/BrainTelemetry.js');
const { channelHub } = await import('../hub/ChannelHub.js');
const { defaultHorseDecisionWorkerDependencies: deps } =
  await import('../engine/horseDecision/workerRuntime.js');
const { HORSE_PHASE12_VARIANTS } = await import('../engine/HorsePhase12Authority.js');
const { HORSE_PHASE14_DOMAINS } = await import('../engine/HorsePhase14Authority.js');
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);
const git = (a: string[]) =>
  execFileSync('git', a, {
    cwd: serverRoot,
    env: gitEnv,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
});
process.once('SIGTERM', () => {
  interrupted = true;
});
try {
  const seed = Number(args.get('seed')),
    pairs = Number(args.get('pairs')),
    startPair = Number(args.get('start-pair') ?? 0),
    experiment = args.get('experiment');
  const allowed =
    experiment === 'v24'
      ? PLO6_V24_DEVELOPMENT_DESIGN.developmentSeeds
      : experiment === 'v53'
        ? V53_PRESSURE_DEVELOPMENT_SEEDS
        : isIncrementalTarget(experiment)
          ? INCREMENTAL_DEVELOPMENT_SEEDS
          : [];
  if (!(allowed as readonly number[]).includes(seed))
    throw new Error('Only declared development seeds may be dealt');
  if (experiment === 'v24' && args.get('variant') !== 'plo6')
    throw new Error('V24 development is PLO6 only');
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 576)
    throw new Error('Initial pilot is bounded to at most576pairs per profile');
  if (args.has('inspect') && !['true', 'false'].includes(args.get('inspect')!))
    throw new Error('Invalid inspection mode');
  if (!Number.isSafeInteger(startPair) || startPair < 0 || startPair + pairs > 576)
    throw new Error('Development continuation outside declared 576-pair pilot');
  const proposedOwnerHead = args.get('proposed-owner-head');
  const dirtyCoreFiles = git(['diff', '--name-only', '--no-relative', '--', 'src/engine'])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (dirtyCoreFiles.length && !proposedOwnerHead)
    throw new Error('Uncommitted core source needs explicit exact owner-head binding');
  if (proposedOwnerHead) {
    if (!/^[0-9a-f]{40}$/.test(proposedOwnerHead))
      throw new Error('Invalid proposed owner-head identity');
    const allowedCore = [
      'server/src/engine/HorseEvEngine.ts',
      'server/src/engine/horseDecision/observerReads.ts',
      'server/src/engine/horseDecision/ownPublicHistory.ts',
    ];
    for (const file of dirtyCoreFiles) {
      if (!allowedCore.includes(file)) throw new Error('Unexpected proposed core file');
      const actual = await readFile(resolve(serverRoot, file.replace(/^server\//, '')));
      if (!actual.equals(Buffer.from(git(['show', `${proposedOwnerHead}:${file}`]))))
        throw new Error('Proposed core source differs from exact owner bytes');
    }
  }
  const out = resolve(args.get('output')!);
  await mkdir(out, { recursive: false });
  const store = await hydrateFrozenFeatureAblationStores();
  const physicalProfile =
    experiment === 'v24'
      ? plo6V24DevelopmentProfile(args.get('profile')!)
      : (isIncrementalTarget(experiment)
          ? incrementalDevelopmentProfiles(experiment, args.get('variant')! as 'plo6')
          : pressureDevelopmentProfiles(args.get('variant')! as 'plo6')
        ).find((p) => p.id === args.get('profile'));
  if (!physicalProfile) throw new Error('Unknown declared development profile');
  const warmRecords =
    experiment === 'v53' && args.get('inspect') !== 'true'
      ? buildPressureWarmRecords({
          variant: args.get('variant')! as 'plo6',
          seats: physicalProfile.seats,
          seed: V53_PRESSURE_WARM_SEED,
        })
      : isIncrementalTarget(experiment) && args.get('inspect') !== 'true'
        ? buildIncrementalWarmRecords(args.get('variant')! as 'plo6', physicalProfile.seats)
        : [];
  const history = {
    kind: isIncrementalTarget(experiment)
      ? 'incremental_public_overstab_warm_v1'
      : experiment === 'v53'
        ? 'fixed_public_warm_v1'
        : 'fresh_empty_public_v1',
    warmSeed: isIncrementalTarget(experiment)
      ? INCREMENTAL_WARM_SEED
      : experiment === 'v53'
        ? V53_PRESSURE_WARM_SEED
        : null,
    ...(isIncrementalTarget(experiment)
      ? { conditionalCoverage: incrementalWarmCoverage(warmRecords) }
      : {}),
    records: warmRecords.length,
    digest: featureAblationHistoryDigest(warmRecords),
    inspectionSkipped: args.get('inspect') === 'true',
    pooledPublicProfiles: { kind: 'empty_for_local_simulation', bootstrap: null, profiles: 0 },
  };
  if (store.stores.postflopV31 !== 0 || store.stores.postflopV31Dataset !== null)
    throw new Error('Unexpected V31 store: unbound baseline');
  const authority = {
    phase8: deps.admitPhase8Authority?.(),
    phase10: deps.admitPhase10Authority?.(),
    phase11: Object.fromEntries(
      ['plo5', 'plo6', 'plo8'].map((v) => [v, deps.admitPhase11Authority?.(v as 'plo6')])
    ),
    phase12: Object.fromEntries(
      HORSE_PHASE12_VARIANTS.map((v) => [v, deps.admitPhase12Authority?.(v)])
    ),
    phase13: Object.fromEntries(
      ['nlh', 'plo4', 'plo5', 'plo6'].map((v) => [v, deps.admitPhase13Authority?.(v as 'plo6')])
    ),
    phase14: Object.fromEntries(
      HORSE_PHASE14_DOMAINS.map((d) => [d, deps.admitPhase14Attachment?.(d)])
    ),
  };
  const sourcePaths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src'])
    .split('\0')
    .filter(Boolean)
    .sort();
  const sourceHash = createHash('sha256');
  for (const path of sourcePaths) {
    sourceHash
      .update(path + '\0')
      .update(await readFile(resolve(serverRoot, path)))
      .update('\0');
  }
  const manifest = {
    schema: 'horse-feature-ablation-development-manifest-v1',
    mode: args.get('inspect') === 'true' ? 'baseline_inspection_no_deals' : 'development',
    baselineKind: isIncrementalTarget(experiment)
      ? 'proposed_combined_candidate_development'
      : proposedOwnerHead
        ? 'proposed_owner_patch_on_protected_reference'
        : 'protected_reference_development',
    proposedOwnerHead: proposedOwnerHead ?? null,
    dirtyCoreFiles,
    baselineObservation:
      'Actual default source-admission reconstruction, not direct live catalog observation. Proposed source remains DEV-only until protected containing release and final current-source verification.',
    policyDate: '2026-10-26T00:00:00.000Z',
    warmHistoryAvailableAt: '2026-10-25T23:00:00.000Z',
    createdAt: new Date().toISOString(),
    revision: git(['rev-parse', 'HEAD']).trim(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    dirty: git(['status', '--porcelain', '--untracked-files=no']).trim().length > 0,
    sourceSha256: sourceHash.digest('hex'),
    sourceFiles: sourcePaths.length,
    lockSha256: sha(await readFile(resolve(serverRoot, 'package-lock.json'))),
    store,
    history,
    authority,
    authoritySha256: sha(JSON.stringify(authority)),
    design: isIncrementalTarget(experiment)
      ? INCREMENTAL_DEVELOPMENT_DESIGN
      : experiment === 'v24'
        ? PLO6_V24_DEVELOPMENT_DESIGN
        : V53_PRESSURE_DEVELOPMENT_DESIGN,
    observation:
      'brain evaluations including corrective re-evaluations, not accepted final layer use',
    promotionEligible: false,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(resolve(out, 'manifest.json'), manifestText, { flag: 'wx' });
  if (args.get('inspect') === 'true') {
    console.log(
      JSON.stringify({
        output: out,
        inspectionOnly: true,
        sourceSha256: manifest.sourceSha256,
        authoritySha256: manifest.authoritySha256,
        promotionEligible: false,
      })
    );
  } else {
    const historyCache = new Map<string, ReturnType<typeof makeFeatureAblationOwnHistory>>();
    const firstReceipts: unknown[] = [];
    const receiptHash = createHash('sha256');
    let receiptCount = 0;
    const planResolutions: Record<string, number> = {};
    enableBrainTelemetry();
    const brain = createFeatureAblationWorker(
      (r) => {
        receiptHash.update(JSON.stringify(r) + '\n');
        receiptCount++;
        if (firstReceipts.length < 8) firstReceipts.push(r);
      },
      (d, n) => {
        planResolutions[d] = (planResolutions[d] ?? 0) + n;
      },
      true,
      (request) => {
        const context = horseObserverReadContextFromRequest(request);
        if (!context) throw new Error('Original worker observer context unavailable');
        const key = JSON.stringify(context);
        let packet = historyCache.get(key);
        if (!packet) {
          packet = makeFeatureAblationOwnHistory(context, request.player.seat, warmRecords);
          historyCache.set(key, packet);
        }
        return packet;
      }
    );
    const spec =
      experiment === 'v24'
        ? plo6V24DevelopmentSpec(args.get('profile')!, brain)
        : isIncrementalTarget(experiment)
          ? incrementalDevelopmentSpec(
              experiment,
              args.get('variant')! as 'plo6',
              args.get('profile')!,
              brain
            )
          : pressureDevelopmentSpec(args.get('variant')! as 'plo6', args.get('profile')!, brain);
    await writeFile(resolve(out, 'warm-public-history.json'), JSON.stringify(warmRecords) + '\n', {
      flag: 'wx',
    });
    const rawHandle = await open(resolve(out, 'raw-pairs.jsonl'), 'wx');
    let result: Awaited<ReturnType<typeof runFeatureAblationDevelopment>>;
    try {
      result = await runFeatureAblationDevelopment(
        spec,
        {
          seed,
          pairs,
          startPair,
          reservedSeeds: [
            ...PLO6_V24_DEVELOPMENT_DESIGN.reservedHeldoutSeeds,
            ...V53_PRESSURE_RESERVED_HOLDOUT_SEEDS,
            ...INCREMENTAL_RESERVED_HOLDOUT_SEEDS,
          ],
        },
        () => !interrupted,
        async (row) => {
          await rawHandle.writeFile(JSON.stringify(row) + '\n');
        }
      );
    } finally {
      await rawHandle.close();
    }
    const rawPairs = await readFile(resolve(out, 'raw-pairs.jsonl'));
    const evidence = {
      manifestSha256: sha(manifestText),
      result,
      rawPairsSha256: sha(rawPairs),
      rawPairCount: result.pairs,
      pilot: ablationPilotMoments(result.sums),
      receiptCount,
      receiptSha256: receiptHash.digest('hex'),
      firstReceipts,
      planResolutions,
    };
    await writeFile(resolve(out, 'development.json'), JSON.stringify(evidence, null, 2) + '\n', {
      flag: 'wx',
    });
    const validity = Object.fromEntries(
      (
        [
          'protocolErrors',
          'brainExceptions',
          'illegalActions',
          'conservationErrors',
          'cardErrors',
          'settlementMismatches',
          'deductionMismatches',
          'truncatedHands',
          'pairedReplayMismatches',
        ] as const
      ).map((k) => [k, result[k]])
    );
    console.log(
      JSON.stringify({
        output: out,
        pairs: result.pairs,
        complete: result.complete,
        pilot: evidence.pilot,
        changedPairs: result.changedPairs,
        validity,
        refusalReason: result.refusalReason,
        ...(isIncrementalTarget(experiment)
          ? {
              conditionalWarmCoverage: incrementalWarmCoverage(warmRecords),
              candidateHeroEvaluationFires: result.candidateEvaluationFires.hero,
              referenceHeroEvaluationFires: result.referenceEvaluationFires.hero,
              acceptedHeroActionContrastPairs: result.candidateHeroActionContrastPairs,
            }
          : {}),
        candidateHeroPressureFires: Object.fromEntries(
          Object.entries(result.candidateEvaluationFires.hero).filter(([k]) =>
            k.startsWith('v53_pressure')
          )
        ),
        referenceHeroPressureFires: Object.fromEntries(
          Object.entries(result.referenceEvaluationFires.hero).filter(([k]) =>
            k.startsWith('v53_pressure')
          )
        ),
        planResolutions,
        promotionEligible: false,
      })
    );
    if (Object.values(validity).some((v) => v !== 0)) process.exitCode = 3;
    else if (!result.complete) process.exitCode = 2;
  }
} finally {
  channelHub.close();
}
