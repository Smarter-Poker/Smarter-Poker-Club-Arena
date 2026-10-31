import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/** Structural fixtures only; never warm histories, consume seeds or execute deals. */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  qualificationPlan,
  validateLockedFeatureAblationPlan,
  FEATURE_ABLATION_REQUIRED_RUNTIME_FILES,
  featureQualificationCanonical,
} from './FeatureAblationQualification.js';
import {
  incrementalComponentCoverage,
  assertIncrementalWorkerFlags,
  assertIncrementalPlanProvenance,
  incrementalQualificationRules,
  authenticateIncrementalPlan,
  TOURNAMENT_RESERVED_HOLDOUT_SEEDS,
} from './IncrementalPressureQualification.js';
import {
  INCREMENTAL_FLAGS,
  incrementalDevelopmentProfiles,
  incrementalDevelopmentSpec,
  type IncrementalTarget,
} from './IncrementalPressureDevelopment.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import {
  runFeatureAblationContract,
  runFeatureAblationDevelopment,
} from './FeatureAblationLeague.js';
const targets = [...Object.keys(INCREMENTAL_FLAGS), 'pressure_package'] as IncrementalTarget[];
const hash = (x: unknown) =>
  createHash('sha256').update(featureQualificationCanonical(x)).digest('hex');
const H = 'a'.repeat(64);
function fixture(target: IncrementalTarget): any {
  const rules = incrementalQualificationRules(target);
  const variants = (['nlh', 'plo4', 'plo5', 'plo6'] as const).filter(
    (v) => target !== 'small_pot_near_nut_value_raise' || v !== 'nlh'
  );
  const profiles = variants.flatMap((v) =>
    incrementalDevelopmentProfiles(target, v)
      .filter((p) => rules.shapes.includes(`${p.seats}:${p.stackBB}`))
      .map((p) => ({ id: p.id, variant: v, seats: p.seats, stackBB: p.stackBB, weight: 1 }))
  );
  const runtimeSourceFiles = Object.fromEntries(
    [
      ...FEATURE_ABLATION_REQUIRED_RUNTIME_FILES,
      'src/benchmark/IncrementalPressureQualification.ts',
      'src/benchmark/IncrementalPressureDevelopment.ts',
    ].map((p) => [p, H])
  );
  return {
    schema: 'horse-incremental-ablation-plan-v2',
    version: 'structural-fixture-never-protected',
    state: 'heldout_locked',
    target,
    dealSampler: 'sha256-profile-seed-index-v1',
    baselineReferenceRevision: 'b'.repeat(40),
    runtimeSourceFiles,
    runtimeSourceDigest: hash(runtimeSourceFiles),
    policyDigests: { fixture: H },
    policyDigestsDigest: hash({ fixture: H }),
    dependencyDigest: H,
    storeInputsDigest: H,
    admissionDigest: H,
    historyDigest: H,
    maxAttempts: 1,
    pooledPublicProfiles: { kind: 'empty_for_local_simulation', bootstrap: null, profiles: 0 },
    flags: rules.flags,
    population: rules.population.id,
    clock: {
      policyDateMs: Date.UTC(2026, 9, 26),
      publicHistoryAvailableAtMs: Date.UTC(2026, 9, 25, 23),
      warmSeed: rules.warmSeed,
    },
    profiles,
    heldoutSeeds: rules.seeds,
    matrix: profiles.flatMap((p) =>
      rules.seeds.map((seed) => ({
        key: `${p.id}-${seed}`,
        profileId: p.id,
        variant: p.variant,
        seed,
        shard: 0,
        firstPair: 0,
        pairs: 576,
      }))
    ),
    interval: PLO4_STRENGTH_CONTRACT.interval,
    thresholds: {
      primaryLowerBoundAboveBb100: 0,
      eachSeedPointEstimateAboveBb100: 0,
      everyCriticalCellLowerBoundAtLeastBb100: -10,
    },
    criticalCells: ['profile', 'relative_position', 'depth'],
    coverage: {
      opportunityDenominator: 'not_measured',
      byProfile: Object.fromEntries(
        profiles.map((p) => [
          p.id,
          {
            candidateHeroDecisionsMinimum: 1,
            referenceHeroDecisionsMinimum: 1,
            acceptedHeroContrastsMinimum: 1,
            evaluationCounterMinimums: Object.fromEntries(
              incrementalComponentCoverage(target, p.seats)
                .filter((c) => c.applicable)
                .map((c) => [c.counter, 1])
            ),
          },
        ])
      ),
    },
  };
}
test('separate schema accepts six structural designs but neither empty registry nor JSON grants execution', async () => {
  for (const target of targets) {
    assert.deepEqual(validateLockedFeatureAblationPlan(fixture(target)), []);
    assert.throws(() => qualificationPlan(target), /plan refused/);
    await assert.rejects(authenticateIncrementalPlan(fixture(target)), /provider unavailable/);
    let called = 0;
    const profile = incrementalDevelopmentProfiles(target, 'plo4')[0];
    const spec = incrementalDevelopmentSpec(target, 'plo4', profile.id, {
      id: 'current-worker-original-observer-controlled-crn-v1',
      decide: () => {
        called++;
        throw Error('must not deal');
      },
    });
    await assert.rejects(
      runFeatureAblationContract(
        spec,
        { seed: 28301109, pairs: 576, startPair: 0, planDigest: H, cellKey: 'unregistered' },
        () => {
          called++;
        }
      ),
      /plan refused/
    );
    assert.equal(called, 0);
  }
  assert.deepEqual(
    JSON.parse(
      readFileSync(new URL('./IncrementalPressureQualificationPlans.json', import.meta.url), 'utf8')
    ),
    {}
  );
});
test('flags, warm seed, physical domain, reserved family and source cannot be substituted', () => {
  for (const mutate of [
    (p: any) => {
      p.flags = { candidate: { v53Pressure: true }, reference: { v53Pressure: false } };
    },
    (p: any) => {
      p.clock.warmSeed = 1;
    },
    (p: any) => {
      p.heldoutSeeds = [1];
    },
    (p: any) => {
      p.population = 'foreign';
    },
    (p: any) => {
      p.profiles[0].id = 'foreign';
    },
    (p: any) => {
      delete p.runtimeSourceFiles['src/benchmark/IncrementalPressureDevelopment.ts'];
      p.runtimeSourceDigest = hash(p.runtimeSourceFiles);
    },
    (p: any) => {
      p.schema = 'horse-feature-ablation-plan-v1';
    },
    (p: any) => {
      p.thresholds.primaryLowerBoundAboveBb100 = -1;
    },
  ]) {
    const p = fixture('pressure_package');
    mutate(p);
    assert.ok(validateLockedFeatureAblationPlan(p).length);
  }
  const p = fixture('river_bluff_checkraise');
  p.profiles[0].seats = 4;
  assert.ok(validateLockedFeatureAblationPlan(p).length);
});
test('generic development refuses tournament reserved seeds without invoking brain', async () => {
  let called = 0;
  const target = 'combo_draw_pressure';
  const profile = incrementalDevelopmentProfiles(target, 'plo4')[0];
  const spec = incrementalDevelopmentSpec(target, 'plo4', profile.id, {
    id: 'no-deal',
    decide: () => {
      called++;
      throw Error('no');
    },
  });
  for (const seed of TOURNAMENT_RESERVED_HOLDOUT_SEEDS)
    await assert.rejects(runFeatureAblationDevelopment(spec, { seed, pairs: 1 }), /never deals/);
  assert.equal(called, 0);
});

test('predeclaration requires original provider, protected merge and strict pre-run time', () => {
  const commit = 'b'.repeat(40),
    operation = {
      id: 42,
      repository: { id: 1132369872, full_name: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' },
      path: '.github/workflows/horse-feature-ablation-qualification.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: 'c'.repeat(40),
      created_at: '2026-10-27T18:00:00Z',
    };
  const prs = [
    {
      merge_commit_sha: commit,
      merged_at: '2026-10-27T17:00:00Z',
      base: {
        ref: 'main',
        repo: { id: 1132369872, full_name: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' },
      },
    },
  ];
  assert.equal(assertIncrementalPlanProvenance(operation, prs, commit, '42'), operation);
  for (const changed of [
    { ...operation, id: 43 },
    { ...operation, created_at: '2026-10-27T17:00:00Z' },
    { ...operation, event: 'pull_request' },
    { ...operation, head_sha: null },
    ...[
      undefined,
      { ...operation.repository, id: 1132369873 },
      { ...operation.repository, id: '1132369872' },
      { ...operation.repository, full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
      { ...operation.repository, full_name: 'foreign/Smarter-Poker-Club-Arena' },
    ].map((repository) => ({ ...operation, repository })),
  ])
    assert.throws(() => assertIncrementalPlanProvenance(changed, prs, commit, '42'));
  assert.throws(() => assertIncrementalPlanProvenance(operation, [], commit, '42'));
  for (const repository of [
    undefined,
    { ...prs[0].base.repo, id: 1132369873 },
    { ...prs[0].base.repo, id: '1132369872' },
    { ...prs[0].base.repo, full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
    { ...prs[0].base.repo, full_name: 'foreign' },
  ])
    assert.throws(() =>
      assertIncrementalPlanProvenance(
        operation,
        [{ ...prs[0], base: { ref: 'main', repo: repository } }],
        commit,
        '42'
      )
    );
});

test('workflow admission requires the canonical built-in repository identity before Git or provider access', async () => {
  vi.stubEnv('GITHUB_REPOSITORY', 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena');
  vi.stubEnv('GITHUB_RUN_ID', '42');
  vi.stubEnv('GITHUB_TOKEN', 'structural-fixture-not-a-credential');
  vi.stubEnv('GITHUB_REF', 'refs/heads/main');
  vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
  try {
    for (const repositoryId of [undefined, '', '1132369873', '01132369872']) {
      vi.stubEnv('GITHUB_REPOSITORY_ID', repositoryId);
      await assert.rejects(
        authenticateIncrementalPlan(fixture('pressure_package')),
        /provider unavailable/
      );
    }
    vi.stubEnv('GITHUB_REPOSITORY_ID', '1132369872');
    for (const repository of [
      'Smarter-Poker/Smarter-Poker-Club-Arena',
      'foreign/Smarter-Poker-Club-Arena',
    ]) {
      vi.stubEnv('GITHUB_REPOSITORY', repository);
      await assert.rejects(
        authenticateIncrementalPlan(fixture('pressure_package')),
        /provider unavailable/
      );
    }
    vi.stubEnv('GITHUB_REPOSITORY', 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena');
    // Matching provider metadata reaches the real independent source/plan
    // gates: shallow CI history, an unmerged branch, dirty source or empty
    // registry still refuses it. The provider-only gate has already passed.
    await assert.rejects(
      authenticateIncrementalPlan(fixture('pressure_package')),
      /Incremental (family history is shallow|source dirty|plan bytes changed)|Command failed: git merge-base --is-ancestor [0-9a-f]{40} origin\/main/
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test('actual worker flags require exactly the declared arm, including all five package flags', () => {
  for (const target of targets) {
    const rules = incrementalQualificationRules(target);
    assertIncrementalWorkerFlags(target, rules.flags.candidate);
    assertIncrementalWorkerFlags(target, rules.flags.reference);
    assert.throws(() => assertIncrementalWorkerFlags(target, {}));
    assert.throws(() =>
      assertIncrementalWorkerFlags(target, { ...rules.flags.candidate, v53Pressure: true })
    );
  }
  assert.throws(() =>
    assertIncrementalWorkerFlags('pressure_package', {
      ...incrementalQualificationRules('pressure_package').flags.candidate,
      riverBluffCheckRaise: false,
    })
  );
});

test('each applicable component needs its own registered positive counter, never a pooled rescue', () => {
  const p = fixture('pressure_package');
  for (const profile of p.profiles) {
    const c = p.coverage.byProfile[profile.id].evaluationCounterMinimums;
    assert.equal(Object.hasOwn(c, 'river_bluff_checkraise_accepted'), profile.seats === 2);
  }
  const profile = p.profiles[0];
  p.coverage.byProfile[profile.id].evaluationCounterMinimums = {};
  assert.ok(
    validateLockedFeatureAblationPlan(p).some((x) =>
      x.startsWith('incremental_component_coverage:')
    )
  );
  p.coverage.byProfile[profile.id].evaluationCounterMinimums = { foreign: 1 };
  assert.ok(
    validateLockedFeatureAblationPlan(p).some((x) =>
      x.startsWith('incremental_component_coverage:')
    )
  );
});

test('actual CLI disables its governor before transitive imports and refuses absent plans without output', () => {
  const server = fileURLToPath(new URL('../../', import.meta.url));
  const cliUrl = new URL('../scripts/featureAblationQualify.ts', import.meta.url).href;
  const governorUrl = new URL('../engine/EquityLoadGovernor.ts', import.meta.url).href;
  const program = `process.argv=[process.execPath,'featureAblationQualify.ts','--plan','--target=pressure_package','--source-sha='+'a'.repeat(40),'--output='+process.cwd()+'/never-written-unregistered-plan.json'];try {await import(${JSON.stringify(cliUrl)});} catch {} const {equityGovernor}=await import(${JSON.stringify(governorUrl)});const {existsSync}=await import('node:fs');const receipt={enabled:equityGovernor.snapshot().enabled,outputExists:existsSync(process.cwd()+'/never-written-unregistered-plan.json')};console.log(JSON.stringify(receipt));process.exit(receipt.enabled||receipt.outputExists?1:0);`;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program],
    {
      cwd: server,
      env: {
        ...process.env,
        EQUITY_GOVERNOR: 'on',
        NODE_ENV: 'qualification',
        VITEST: '',
        SUPABASE_URL: 'https://supabase.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'qualification-offline-placeholder',
      },
      encoding: 'utf8',
      timeout: 20000,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)!), {
    enabled: false,
    outputExists: false,
  });
}, 25000);

test('joint family locks complete member plans and never reassigns exposed seeds to new source or dispatch', async () => {
  const { validateIncrementalFamily, assertIncrementalFamilyRuns } =
    await import('./IncrementalPressureQualification.js');
  const a = fixture('combo_draw_pressure'),
    b = fixture('targeted_river_bluff');
  const registry = { combo_draw_pressure: a, targeted_river_bluff: b };
  const families = {
    '283': {
      schema: 'horse-incremental-crn-family-v1',
      providerAnchor: { workflowId: 70, baselineRunId: 90, baselineRunNumber: 17 },
      runtimeSourceDigest: a.runtimeSourceDigest,
      members: [
        { target: a.target, planDigest: hash(a) },
        { target: b.target, planDigest: hash(b) },
      ],
    },
  };
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        new URL('./IncrementalPressureQualificationFamilies.json', import.meta.url),
        'utf8'
      )
    ),
    {}
  );
  const family = validateIncrementalFamily(a, registry, families);
  assert.throws(() => validateIncrementalFamily(a, registry, {}), /not locked/);
  assert.throws(
    () =>
      validateIncrementalFamily(
        a,
        { ...registry, targeted_river_bluff: { ...b, matrix: [] } },
        families
      ),
    /changed/
  );
  const source = 'b'.repeat(40);
  const run = (id: number, target: string, sha = source) => ({
    id,
    path: '.github/workflows/horse-feature-ablation-qualification.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: source,
    created_at: id === 1 ? '2026-10-27T17:59:00Z' : '2026-10-27T18:00:00Z',
    display_title: `Held-out ${target} at ${sha}`,
    status: 'completed',
    conclusion: 'failure',
  });
  const current = run(2, b.target),
    previous = run(1, a.target);
  assert.equal(
    assertIncrementalFamilyRuns([current, previous], current, b.target, source, family).length,
    1
  );
  for (const old of [
    run(1, b.target),
    run(1, a.target, 'c'.repeat(40)),
    { ...previous, display_title: null },
    { ...previous, created_at: current.created_at },
    run(1, 'river_position_defense'),
  ])
    assert.throws(() =>
      assertIncrementalFamilyRuns([current, old], current, b.target, source, family)
    );
  assert.throws(
    () => assertIncrementalFamilyRuns([previous], current, b.target, source, family),
    /incomplete/
  );
  assert.throws(
    () => assertIncrementalFamilyRuns([current, current], current, b.target, source, family),
    /incomplete/
  );
});
test('only affirmatively unstarted original-operation cells may recover', async () => {
  const { assertIncrementalUnconsumedRecovery } =
    await import('./IncrementalPressureQualification.js');
  const job = {
    name: 'Cell a',
    run_attempt: 1,
    status: 'completed',
    steps: [
      {
        name: 'Execute the one registered cell without retry',
        status: 'completed',
        conclusion: 'skipped',
        started_at: null,
      },
    ],
  };
  assert.doesNotThrow(() => assertIncrementalUnconsumedRecovery([job], 2, 'a'));
  for (const steps of [
    [],
    [{ ...job.steps[0], conclusion: 'failure', started_at: '2026-10-27T18:00:00Z' }],
    [{ ...job.steps[0], conclusion: 'cancelled' }],
  ])
    assert.throws(() => assertIncrementalUnconsumedRecovery([{ ...job, steps }], 2, 'a'));
  assert.throws(() => assertIncrementalUnconsumedRecovery([], 2, 'a'));
  assert.throws(() => assertIncrementalUnconsumedRecovery([job], 2, 'b'));
});

test('provider lineage detects deleted runs without assuming numbering starts at one', async () => {
  const { assertIncrementalProviderLineage, assertIncrementalFamilyHistory } =
    await import('./IncrementalPressureQualification.js');
  const anchor = { workflowId: 70, baselineRunId: 90, baselineRunNumber: 17 };
  const baseline = { id: 90, workflow_id: 70, run_number: 17, created_at: '2026-10-27T15:00:00Z' };
  const current = { id: 93, workflow_id: 70, run_number: 20, created_at: '2026-10-27T18:00:00Z' };
  const runs = [
    baseline,
    { ...baseline, id: 91, run_number: 18 },
    { ...baseline, id: 92, run_number: 19 },
    current,
  ];
  assert.doesNotThrow(() =>
    assertIncrementalProviderLineage(runs, current, anchor, baseline, '2026-10-27T16:00:00Z')
  );
  for (const inventory of [
    runs.filter((r) => r.id !== 91),
    runs.filter((r) => r.id !== 90),
    [...runs, { ...baseline, id: 95, run_number: 18 }],
    runs.map((r) => (r.id === 92 ? { ...r, workflow_id: 71 } : r)),
  ])
    assert.throws(() =>
      assertIncrementalProviderLineage(inventory, current, anchor, baseline, '2026-10-27T16:00:00Z')
    );
  assert.throws(() =>
    assertIncrementalProviderLineage(runs, current, anchor, baseline, baseline.created_at)
  );
  assert.throws(() =>
    assertIncrementalProviderLineage(
      runs,
      current,
      { ...anchor, baselineRunNumber: 18 },
      baseline,
      '2026-10-27T16:00:00Z'
    )
  );
  const family = { providerAnchor: anchor };
  const snapshots = [
    { commit: 'c'.repeat(40), family },
    { commit: 'b'.repeat(40), family },
    { commit: 'a'.repeat(40), family: undefined },
  ];
  assert.equal(assertIncrementalFamilyHistory(snapshots, family), 'b'.repeat(40));
  assert.throws(() =>
    assertIncrementalFamilyHistory(
      [
        snapshots[0],
        { ...snapshots[1], family: { providerAnchor: { ...anchor, baselineRunId: 91 } } },
      ],
      family
    )
  );
  assert.throws(() =>
    assertIncrementalFamilyHistory([snapshots[0], snapshots[2], snapshots[1]], family)
  );
});

// Prospective declaration and producer exercise existing locked-plan validation;
// fixture evidence is unsigned and never installed as a release selection.
test('condition(a) producer binds an exact declared profile without a condition(b) gate', async () => {
  const { featureAdmissionArtifacts } = await import('../../scripts/feature-ablation-assemble.mjs');
  const { featureLiveDomainRefusals } = await import('./FeatureAblationQualification.js');
  const { publishedCashPricing } = await import('../config/leagueCashPricing.js');
  const { admitHorseFeatureAuthority, runningFeatureSourcePaths } =
    await import('../engine/HorseFeatureAuthority.js');
  const { HorseQualifiedAuthorityHolder } = await import('../engine/HorseQualifiedAuthority.js');
  const sourceBytes = Buffer.from('unsigned structural source fixture'),
    sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const p = fixture('combo_draw_pressure');
  for (const path of [...Object.keys(p.runtimeSourceFiles), ...runningFeatureSourcePaths()])
    p.runtimeSourceFiles[path] = sourceHash;
  p.dependencyDigest = sourceHash;
  const profile = p.profiles.find((x: any) => x.variant === 'plo4' && x.seats === 2);
  p.liveAdmission = {
    schema: 'horse-feature-live-domain-v1',
    profileId: profile.id,
    domain: {
      variant: 'plo4',
      mode: 'cash',
      asset: 'chips',
      chipUnit: 0.01,
      boardCount: 1,
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      bigBlindAnte: false,
      bettingStructure: 'pot_limit',
      sidePots: false,
      dealtSeats: [2],
      remainingPlayers: [2],
      startingStackBB: 100,
      effectiveStackBB: [0, 100],
      ...publishedCashPricing({ variant: 'plo4', tournament: false, seats: 2, tableSeats: 6 }),
    },
  };
  for (const f of [
    'src/engine/HorseFeatureAuthority.ts',
    'src/engine/HorseFeatureLiveDomain.ts',
    'src/config/leagueCashPricing.ts',
  ])
    p.runtimeSourceFiles[f] = sourceHash;
  p.runtimeSourceDigest = hash(p.runtimeSourceFiles);
  assert.deepEqual(validateLockedFeatureAblationPlan(p), []);
  const assembly: any = {
    schema: 'horse-feature-ablation-assembly-v1',
    sourceSha: 'b'.repeat(40),
    target: p.target,
    planDigest: hash(p),
    qualified: true,
    activationAllowed: false,
    reasons: [],
    summary: {
      qualified: true,
      activationAllowed: false,
      planDigest: hash(p),
      byVariant: { plo4: { qualified: true } },
    },
    provider: { rawArtifactsRetained: true, inventorySha256: H },
  };
  const produce = (plan = p, a = assembly) =>
    featureAdmissionArtifacts({
      plan,
      assembly: a,
      validatePlan: validateLockedFeatureAblationPlan,
      validateDomain: featureLiveDomainRefusals,
    });
  const output = produce();
  assert.equal(output.admission.qualified, true);
  assert.equal(output.admission.activationAllowed, false);
  assert.equal(output.admission.conditionB, 'post_launch_monitoring_withdrawal_only');
  assert.equal('population' in output.admission, false);
  for (const binding of [output.admission.plan, output.admission.assembly]) {
    const name = binding.path.split('/').at(-1)!;
    assert.equal(createHash('sha256').update(output.files[name]).digest('hex'), binding.sha256);
  }
  const admissionFile = Object.entries(output.files).find(([name]) =>
    name.endsWith('-admission.json')
  )!;
  const now = Date.now(),
    selection = {
      schema: 'horse-feature-release-selection-v1' as const,
      qualificationPath: 'docs/evidence/feature-activation/' + admissionFile[0],
      qualificationSha256: createHash('sha256')
        .update(admissionFile[1] as string)
        .digest('hex'),
      sourceSha: assembly.sourceSha,
      approvalGeneration: 1,
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      withdrawn: null,
    };
  const admitted = admitHorseFeatureAuthority(
    selection,
    { read: (path) => Buffer.from(output.files[path.split('/').at(-1)!]) },
    now,
    () => sourceBytes
  );
  assert.equal(admitted.status, 'admitted');
  const holder = new HorseQualifiedAuthorityHolder(
    '11111111-1111-4111-8111-111111111111',
    'horse-feature-promotion-v1'
  );
  holder.apply(admitted);
  assert.equal(holder.receipt().state, 'usable');
  assert.equal(produce(p, { ...assembly, reasons: undefined }).admission.qualified, false);
  assert.equal(produce(p, { ...assembly, qualified: false }).admission.qualified, false);
  for (const change of [
    { smallBlind: 2 },
    { ante: 1 },
    { asset: 'diamonds' },
    { dealtSeats: [2, 4] },
    { startingStackBB: 200 },
    { effectiveStackBB: [0, 200] },
    { rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true } },
  ]) {
    const bad = structuredClone(p);
    Object.assign(bad.liveAdmission.domain, change);
    assert.notDeepEqual(featureLiveDomainRefusals(bad), []);
    assert.equal(produce(bad).admission.qualified, false);
  }
  const dev = { ...p, state: 'development_only' };
  assert.equal(produce(dev).admission.qualified, false);
  const missing = { ...p };
  delete missing.liveAdmission;
  assert.equal(produce(missing).admission.qualified, false);
});

test('separate river schemas preserve exact components and old families remain unusable', () => {
  for (const target of [
    'small_pot_near_nut_value_raise',
    'multiway_river_bluff_checkraise',
  ] as const) {
    const plan = fixture(target);
    assert.deepEqual(validateLockedFeatureAblationPlan(plan), []);
    assert.throws(() => qualificationPlan(target), /refused/);
    const wrong = structuredClone(plan);
    wrong.heldoutSeeds = [28301109, 28302231, 28303347];
    assert.ok(validateLockedFeatureAblationPlan(wrong).includes('unregistered_holdout_seeds'));
    if (target === 'multiway_river_bluff_checkraise') {
      wrong.flags.reference.riverBluffCheckRaise = false;
      assert.ok(validateLockedFeatureAblationPlan(wrong).includes('one_flag_contrast'));
    }
  }
});
