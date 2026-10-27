/** Manual, protected, contract-only provider runner. It never calls the DEV
 * export and has no production database credentials, writer or activation. */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'feature-ablation-offline-placeholder';
const args = new Map<string, string>();
let planOnly = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--plan') {
    if (planOnly) throw Error('Duplicate plan mode');
    planOnly = true;
    continue;
  }
  const m = /^--(target|source-sha|output|cell)=(.+)$/.exec(arg);
  if (!m || args.has(m[1])) throw Error('Unknown or duplicate contract argument');
  args.set(m[1], m[2]);
}
for (const key of ['target', 'source-sha', 'output'])
  if (!args.has(key)) throw Error('Missing --' + key);
if (!planOnly && !args.has('cell')) throw Error('Missing registered cell');
if (planOnly && args.has('cell')) throw Error('Plan mode never selects or deals a cell');
const {
  qualificationPlan,
  qualificationPlanDigest,
  assertProtectedFeatureAblationSource,
  validateFeatureAblationCell,
  featureQualificationCanonical,
} = await import('../benchmark/FeatureAblationQualification.js');
const { hydrateFrozenFeatureAblationStores } =
  await import('../benchmark/FeatureAblationStores.js');
const { buildPressureWarmRecords, makeFeatureAblationOwnHistory, featureAblationHistoryDigest } =
  await import('../benchmark/FeatureAblationHistory.js');
const { createFeatureAblationWorker } = await import('../benchmark/FeatureAblationWorker.js');
const { V53_PRESSURE_POPULATION } = await import('../benchmark/V53PressurePopulation.js');
const { getFullRakeConfig } = await import('../config/RakeConfig.js');
const { horseObserverReadContextFromRequest } =
  await import('../engine/HorseObserverReadContext.js');
const { enableBrainTelemetry } = await import('../engine/BrainTelemetry.js');
const { channelHub } = await import('../hub/ChannelHub.js');
try {
  const { defaultHorseDecisionWorkerDependencies: deps } =
    await import('../engine/horseDecision/workerRuntime.js');
  const { HORSE_PHASE12_VARIANTS } = await import('../engine/HorsePhase12Authority.js');
  const { HORSE_PHASE14_DOMAINS } = await import('../engine/HorsePhase14Authority.js');
  const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
  const target = args.get('target') as 'plo6_v24' | 'v53_pressure',
    plan = qualificationPlan(target),
    planDigest = qualificationPlanDigest(plan),
    sourceSha = args.get('source-sha')!;
  const source = assertProtectedFeatureAblationSource(plan, sourceSha);
  const store = await hydrateFrozenFeatureAblationStores();
  if (hash(featureQualificationCanonical(store)) !== plan.storeInputsDigest)
    throw Error('Frozen loader identity changed');
  const warmByProfile = new Map<string, ReturnType<typeof buildPressureWarmRecords>>();
  const historyByProfile: Record<string, unknown> = {};
  for (const p of plan.profiles) {
    const records =
      target === 'v53_pressure'
        ? buildPressureWarmRecords({
            variant: p.variant,
            seats: p.seats,
            seed: plan.clock.warmSeed,
          })
        : [];
    warmByProfile.set(p.id, records);
    historyByProfile[p.id] = {
      kind: target === 'v53_pressure' ? 'fixed_public_warm_v1' : 'fresh_empty_public_v1',
      warmSeed: target === 'v53_pressure' ? plan.clock.warmSeed : null,
      records: records.length,
      digest: featureAblationHistoryDigest(records),
      pooledPublicProfiles: plan.pooledPublicProfiles,
    };
  }
  if (hash(featureQualificationCanonical(historyByProfile)) !== plan.historyDigest)
    throw Error('Fixed public history identity changed');
  function currentAdmissions() {
    return {
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
  }
  function admittedPolicyDigests(value: unknown, prefix = '', out: Record<string, string> = {}) {
    if (!value || typeof value !== 'object') return out;
    const x = value as Record<string, unknown>;
    if (x.status === 'admitted' && x.authority && typeof x.authority === 'object') {
      const a = x.authority as { policyDigest?: unknown };
      if (typeof a.policyDigest !== 'string') throw Error('Admitted policy digest missing');
      out[prefix] = a.policyDigest;
      return out;
    }
    for (const [k, v] of Object.entries(x))
      if (v && typeof v === 'object') admittedPolicyDigests(v, prefix ? prefix + '.' + k : k, out);
    return out;
  }
  function verifyAdmissions() {
    const bootstrap = Reflect.get(deps, 'publicProfileBootstrap');
    if (typeof bootstrap === 'function' && bootstrap() != null)
      throw Error('Declared empty controlled public pool differs from original bootstrap');
    const a = JSON.parse(JSON.stringify(currentAdmissions())),
      policies = admittedPolicyDigests(a);
    if (
      hash(featureQualificationCanonical(a)) !== plan.admissionDigest ||
      hash(featureQualificationCanonical(policies)) !== plan.policyDigestsDigest ||
      featureQualificationCanonical(policies) !== featureQualificationCanonical(plan.policyDigests)
    )
      throw Error('Actual original admission/policy identity changed');
    return a;
  }
  verifyAdmissions();
  const out = resolve(args.get('output')!);
  if (planOnly) {
    await writeFile(out, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    console.log('MATRIX=' + JSON.stringify({ include: plan.matrix.map((c) => ({ key: c.key })) }));
    console.log(JSON.stringify({ target, planDigest, source, heldoutHandsDealt: 0 }));
  } else {
    const cell = plan.matrix.find((c) => c.key === args.get('cell'));
    if (!cell) throw Error('Unknown registered cell');
    const profile = plan.profiles.find((p) => p.id === cell.profileId)!;
    const attempt = JSON.parse(await readFile(resolve(out, 'attempt.json'), 'utf8'));
    const bindings = {
      policyDigestsDigest: plan.policyDigestsDigest,
      dependencyDigest: plan.dependencyDigest,
      storeInputsDigest: plan.storeInputsDigest,
      admissionDigest: plan.admissionDigest,
      historyDigest: plan.historyDigest,
    };
    const expected = { planDigest, target, sourceSha, ...bindings, cell };
    if (
      attempt.schema !== 'horse-feature-ablation-attempt-v1' ||
      attempt.cellKey !== cell.key ||
      attempt.exitCode !== null ||
      featureQualificationCanonical(attempt.identity) !== featureQualificationCanonical(expected)
    )
      throw Error('Original pre-deal attempt binding refused');
    async function verifyProvider() {
      const op = attempt.operation,
        repo = process.env.GITHUB_REPOSITORY,
        run = process.env.GITHUB_RUN_ID,
        runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT),
        token = process.env.GITHUB_TOKEN;
      if (
        repo !== 'Smarter-Poker/Smarter-Poker-Club-Arena' ||
        String(op.providerRunId) !== run ||
        op.runAttempt !== runAttempt ||
        !/^\d+$/.test(String(op.jobId)) ||
        !token ||
        runAttempt > plan.maxAttempts
      )
        throw Error('Actual provider attempt unavailable');
      const get = async (suffix: string) => {
        const r = await fetch(`https://api.github.com/repos/${repo}${suffix}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw Error('Provider identity read refused');
        const body: unknown = await r.json();
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw Error('Provider identity shape refused');
        return body as Record<string, unknown>;
      };
      const [j, r] = await Promise.all([
        get(`/actions/jobs/${op.jobId}`),
        get(`/actions/runs/${run}`),
      ]);
      const createdAt = j.created_at ?? r.created_at,
        createdAtSource = j.created_at ? 'job.created_at' : 'run.created_at';
      if (
        String(j.id) !== String(op.jobId) ||
        String(j.run_id) !== run ||
        j.run_attempt !== runAttempt ||
        j.name !== `Cell ${cell!.key}` ||
        r.path !== '.github/workflows/horse-feature-ablation-qualification.yml' ||
        r.event !== 'workflow_dispatch' ||
        r.head_branch !== 'main' ||
        op.createdAt !== createdAt ||
        op.createdAtSource !== createdAtSource
      )
        throw Error('Original provider job identity mismatch');
    }
    let authorized: Promise<void> | undefined;
    const authorizedGuard = () =>
      (authorized ??= (async () => {
        assertProtectedFeatureAblationSource(plan, sourceSha);
        verifyAdmissions();
        await verifyProvider();
      })());
    await authorizedGuard(); // The mandatory private-core wrapper repeats this guard before dealing.
    const physicalRake = getFullRakeConfig(1, 2, profile.variant);
    const physical = {
      id: profile.id,
      variant: profile.variant,
      seats: profile.seats,
      stackBB: profile.stackBB,
      tableSeats: 6,
      publishedRake: true,
      productionStyles: true,
      moodClock: 'deal_seed_time_of_day' as const,
      rakePercent: physicalRake.rakePercent,
      rakeCapBB: physicalRake.rakeCap / 2,
      anteBB: 0,
      straddle: false,
      tournament: false,
      opponentStyle: 'balanced' as const,
    };
    const receiptHash = createHash('sha256'),
      samples: unknown[] = [];
    let receiptCount = 0,
      interrupted = false;
    process.once('SIGINT', () => {
      interrupted = true;
    });
    process.once('SIGTERM', () => {
      interrupted = true;
    });
    const historyCache = new Map<string, ReturnType<typeof makeFeatureAblationOwnHistory>>();
    enableBrainTelemetry();
    const brain = createFeatureAblationWorker(
      (r) => {
        receiptHash.update(JSON.stringify(r) + '\n');
        receiptCount++;
        if (samples.length < 8) samples.push(r);
      },
      () => {},
      true,
      (request) => {
        const context = horseObserverReadContextFromRequest(request);
        if (!context) throw Error('Original observer context unavailable');
        const key = JSON.stringify(context);
        let packet = historyCache.get(key);
        if (!packet) {
          packet = makeFeatureAblationOwnHistory(
            context,
            request.player.seat,
            warmByProfile.get(profile.id)!
          );
          historyCache.set(key, packet);
        }
        return packet;
      }
    );
    const spec = {
      id: plan.version,
      profile: physical,
      brain,
      candidate: plan.flags.candidate,
      reference: plan.flags.reference,
      ...(target === 'v53_pressure' ? { population: V53_PRESSURE_POPULATION } : {}),
    };
    const league = await import('../benchmark/FeatureAblationLeague.js'),
      runContract = Reflect.get(league, 'runFeatureAblationContract');
    if (typeof runContract !== 'function')
      throw Error('Verified contract-only core capability unavailable');
    await mkdir(out, { recursive: true });
    const rawFile = resolve(out, 'raw-pairs.jsonl'),
      raw = await open(rawFile, 'wx'),
      rawHash = createHash('sha256');
    let rawPairCount = 0;
    try {
      const result = await runContract(
        spec,
        {
          seed: cell.seed,
          pairs: cell.pairs,
          startPair: cell.firstPair,
          planDigest,
          cellKey: cell.key,
        },
        authorizedGuard,
        async (row: unknown) => {
          const line = JSON.stringify(row) + '\n';
          await raw.writeFile(line);
          rawHash.update(line);
          rawPairCount++;
        },
        () => !interrupted
      );
      assertProtectedFeatureAblationSource(plan, sourceSha);
      verifyAdmissions();
      const envelope = {
        schema: 'horse-feature-ablation-cell-v1' as const,
        mode: 'contract' as const,
        target,
        cellKey: cell.key,
        sourceSha,
        planDigest,
        ...bindings,
        operation: attempt.operation,
        result,
        rawPairsSha256: rawHash.digest('hex'),
        rawPairCount,
        execution: {
          workerReceiptSha256: receiptHash.digest('hex'),
          workerReceiptCount: receiptCount,
          sampledWorkerReceipts: samples,
        },
      };
      await writeFile(resolve(out, 'result.json'), JSON.stringify(envelope, null, 2) + '\n', {
        flag: 'wx',
      });
      const reasons = validateFeatureAblationCell(plan, cell, envelope);
      if (reasons.length || !result.complete) process.exitCode = 2;
      console.log(
        JSON.stringify({
          target,
          cell: cell.key,
          pairs: result.pairs,
          complete: result.complete,
          reasons,
          qualified: false,
          activationAllowed: false,
          opportunityDenominator: 'not_measured',
          scope:
            'fixed-work FAST semantics; original caller scheduling and production latency not measured',
        })
      );
    } finally {
      await raw.close();
      channelHub.close();
    }
  }
} finally {
  channelHub.close();
}
