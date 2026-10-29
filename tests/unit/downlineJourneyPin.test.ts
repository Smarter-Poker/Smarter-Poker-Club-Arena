import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
  JourneyUnknown,
  qualifyStatsJourneyPin,
  statsHarnessInputs,
} from '../../scripts/ci/downline-journey-pin.mjs';
import { requireUnchangedBuildInfoSha } from '../../scripts/ci/production-e2e-provenance.mjs';

const sourceRoot = process.cwd();
const controls = [
  'scripts/ci/downline-journey-pin.mjs',
  'scripts/ci/production-e2e-provenance.mjs',
  'scripts/ci/client-runtime-retention.mjs',
  'scripts/ci/client-runtime-inputs.mjs',
  'scripts/ci/client-runtime-font-inputs.mjs',
];
function fixture(inheritedEnv = process.env) {
  const root = mkdtempSync(join(tmpdir(), 'downline-journey-'));
  const env = {
    ...Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Journey Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Journey Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  for (const path of [...statsHarnessInputs(sourceRoot), ...controls]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(sourceRoot, path), join(root, path));
  }
  git('init', '--quiet', '--initial-branch=main');
  const commit = (parent?: string) => {
    git('add', '.');
    const tree = git('write-tree').trim();
    return git(
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      'isolated actual-harness fixture'
    ).trim();
  };
  const original = commit();
  git('update-ref', 'refs/heads/main', original);
  git('update-ref', 'refs/remotes/origin/main', original);
  const forward = (path = 'src/unrelated.ts', text = 'export const changed = true;\n') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    const sha = commit(git('rev-parse', 'HEAD').trim());
    git('update-ref', 'refs/remotes/origin/main', sha);
    return sha;
  };
  const body = (sha: string) => JSON.stringify({ ca_sha: sha });
  const qualify = (sha = original, other = sha, initial = original) =>
    qualifyStatsJourneyPin({ root, originalSha: initial, bodies: [body(sha), body(other)], git });
  return {
    root,
    env,
    commit,
    git,
    original,
    forward,
    body,
    qualify,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function withFixture(run: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  try {
    run(f);
  } finally {
    f.close();
  }
}

describe('the exact downline journey is pinned at its own start', () => {
  it('isolates fixture Git from repository and config variables inherited from a hook', () => {
    const f = fixture({
      ...process.env,
      GIT_DIR: '/never-use-parent-repository/.git',
      GIT_WORK_TREE: '/never-use-parent-repository',
      GIT_INDEX_FILE: '/never-use-parent-repository/index',
      GIT_COMMON_DIR: '/never-use-parent-repository/.git',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
    });
    try {
      expect(f.git('rev-parse', '--show-toplevel').trim()).toBe(f.root);
      expect(f.qualify().journeySha).toBe(f.original);
    } finally {
      f.close();
    }
  });

  it('qualifies the actual maintained spec/global-setup/config import closure', () =>
    withFixture((f) => {
      const proof = f.qualify();
      // Required real entry points and current imports are independent of a
      // brittle cardinality: protected harness improvements may add inputs.
      expect(proof.inputs).toEqual(
        expect.arrayContaining([
          'package-lock.json',
          'package.json',
          'playwright.config.ts',
          'tsconfig.json',
          'tests/e2e/global-setup.ts',
          'tests/e2e/stats-deep.spec.ts',
          'tests/e2e/support/cashLobbyOverlays.ts',
          'tests/e2e/support/ensureAcceptedTerms.ts',
          'tests/e2e/support/ensureClubMembership.ts',
          'tests/e2e/support/ensurePlayableProfile.ts',
          'tests/e2e/support/nonVerdict.ts',
          'tests/e2e/support/setupFailureObservation.ts',
          'tests/e2e/support/staticOriginDirect.ts',
          'tests/e2e/support/staticOriginPath.ts',
          'tests/e2e/support/statsClock.ts',
        ])
      );
      expect(proof.inputs.length).toBeLessThanOrEqual(32);
      expect(proof.inputs).toContain('tests/e2e/support/ensurePlayableProfile.ts');
      expect(proof.inputs).toContain('tests/e2e/support/staticOriginPath.ts');
      expect(proof.originShas).toEqual([f.original, f.original]);
      expect(proof.fullRuntimeEquivalenceClaimed).toBe(false);
    }));

  it('reproduces the stale job pin refusal, then qualifies the later exact served source with the same canonical harness', () =>
    withFixture((f) => {
      const served = f.forward();
      expect(() => requireUnchangedBuildInfoSha(f.body(served), f.original)).toThrow(
        'Production changed'
      );
      const proof = f.qualify(served);
      expect(proof.originalSha).toBe(f.original);
      expect(proof.journeySha).toBe(served);
      expect(requireUnchangedBuildInfoSha(f.body(served), proof.journeySha)).toBe(served);
    }));

  it('refuses compiler paths shadowing a LOCKED package with changed local source', () =>
    withFixture((f) => {
      const config = JSON.parse(readFileSync(join(f.root, 'tsconfig.json'), 'utf8'));
      config.compilerOptions.paths['@axe-core/playwright'] = ['tests/e2e/support/locked-shadow.ts'];
      writeFileSync(join(f.root, 'tsconfig.json'), JSON.stringify(config));
      const original = f.forward('tests/e2e/support/locked-shadow.ts', 'export const old = true;');
      f.git('update-ref', 'refs/heads/main', original);
      const served = f.forward(
        'tests/e2e/support/locked-shadow.ts',
        'export const changed = true;'
      );
      expect(() => f.qualify(served, served, original)).toThrow('shadowed by compiler paths');
    }));

  it.each([false, true])(
    'refuses baseUrl package shadow including canonical-only source: %s',
    (canonicalOnly) =>
      withFixture((f) => {
        const path = '@axe-core/playwright.ts';
        const served = f.forward(path, 'export const shadow = true;');
        if (canonicalOnly) rmSync(join(f.root, path));
        expect(() => f.qualify(served)).toThrow('shadowed by compiler baseUrl');
      })
  );

  it('keeps a legitimate retained runtime pinned while qualifying the actual newer protected harness through existing contracts', () =>
    withFixture((f) => {
      const spec = 'tests/e2e/stats-deep.spec.ts';
      const here = f.forward(
        spec,
        readFileSync(join(f.root, spec), 'utf8') + '\n// New verification only.\n'
      );
      f.git('update-ref', 'refs/heads/main', here);
      const info = JSON.stringify({
        ca_sha: f.original,
        run_id: '99',
        built_by: 'publish-club-arena.yml',
      });
      const manifest = 'synthetic immutable fixture manifest';
      // Run the existing receipt, full build-input/backlog and two-origin
      // validators in a real isolated Git checkout, not a hand-made boolean.
      const contracts = `
        import {makeRuntimeInputs,qualifiesRuntimeInputs} from ${JSON.stringify(join(sourceRoot, 'scripts/ci/client-runtime-inputs.mjs'))};
        import {compareClientBacklog,readRetentionReceipt,assertReceiptOrigins} from ${JSON.stringify(join(sourceRoot, 'scripts/ci/client-runtime-retention.mjs'))};
        import {createHash} from 'node:crypto';
        const [root,base,here,info,manifest,attack]=process.argv.slice(1);
        const hash=x=>createHash('sha256').update(x).digest('hex');
        const inputs=makeRuntimeInputs(base,['app','diamond','prerender'].map(build=>({schema:1,build,sourceSha:base,cleanSource:true,files:[],directories:[],unknown:[]})),root);
        const {paths}=compareClientBacklog(base,here,root);
        if(attack==='inputs') inputs.complete=false;
        if(!qualifiesRuntimeInputs(inputs,base,here,paths,root)) throw Error('Unqualified full runtime inputs');
        const receipt=readRetentionReceipt({schema:1,kind:'retained-client-runtime',runtimeSha:base,verificationSha:here,sourceRunId:'123',sourceTriggerSha:here,repositoryId:'1132369872',originalPublisherRunId:'99',originalArtifactId:1,inputs,buildInfoSHA256:hash(info),manifestSHA256:hash(manifest),paths},'123',here,'1132369872');
        assertReceiptOrigins(receipt,[Buffer.from(info),Buffer.from(info)],[Buffer.from(manifest),Buffer.from(attack==='origin' ? manifest+'changed' : manifest)]);
        console.log(JSON.stringify(receipt));
      `;
      const validate = (attack = '') =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              contracts,
              f.root,
              f.original,
              here,
              info,
              manifest,
              attack,
            ],
            { env: f.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
          )
        );
      const raw = validate();
      expect(() => validate('inputs')).toThrow();
      expect(() => validate('origin')).toThrow();
      const event = { workflow_run: { id: 123, head_sha: here }, repository: { id: 1132369872 } };
      const args = { root: f.root, originalSha: f.original, bodies: [info, info], git: f.git };
      expect(() => qualifyStatsJourneyPin(args)).toThrow('canonical harness differs');
      const verifyRetention = (receipt: unknown) => expect(receipt).toEqual(validate());
      const proof = qualifyStatsJourneyPin({ ...args, retention: { raw, event }, verifyRetention });
      expect(proof.journeySha).toBe(f.original);
      expect(proof.canonicalHarnessSha).toBe(here);
      expect(proof.retainedRuntime).toBe(true);
      expect(proof.retentionAuthority).toMatchObject({
        sourceRunId: '123',
        runtimeSha: f.original,
        verificationSha: here,
      });
      expect(proof.fullRuntimeEquivalenceClaimed).toBe(false);
      expect(() => qualifyStatsJourneyPin({ ...args, retention: { raw, event } })).toThrow(
        'exact executed'
      );
      expect(() =>
        qualifyStatsJourneyPin({
          ...args,
          retention: { raw: { ...raw, sourceRunId: '124' }, event },
          verifyRetention,
        })
      ).toThrow('exact protected publisher run');
      expect(() =>
        qualifyStatsJourneyPin({
          ...args,
          retention: { raw: { ...raw, verificationSha: f.original }, event },
          verifyRetention,
        })
      ).toThrow('exact executed');
      expect(() =>
        qualifyStatsJourneyPin({
          ...args,
          retention: { raw, event },
          verifyRetention: () => {
            throw new Error('Actual retained harness refused origin manifest or runtime inputs');
          },
        })
      ).toThrow('retained harness refused');
    }));

  it('keeps disagreeing or unreadable origin reads UNKNOWN', () =>
    withFixture((f) => {
      const served = f.forward();
      expect(() => f.qualify(served, f.original)).toThrow(JourneyUnknown);
      expect(() =>
        qualifyStatsJourneyPin({
          root: f.root,
          originalSha: f.original,
          bodies: ['bad', f.body(served)],
          git: f.git,
        })
      ).toThrow(JourneyUnknown);
    }));

  it('refuses rollback, off-main and unresolved source identity', () =>
    withFixture((f) => {
      const served = f.forward();
      expect(() => f.qualify(f.original, f.original, served)).toThrow('backwards');
      f.git('update-ref', 'refs/remotes/origin/main', f.original);
      expect(() => f.qualify(served)).toThrow('protected main');
      expect(() => f.qualify('a'.repeat(40))).toThrow('protected main');
    }));

  it.each([
    'tests/e2e/stats-deep.spec.ts',
    'tests/e2e/support/ensurePlayableProfile.ts',
    'package-lock.json',
    'playwright.config.ts',
    'tsconfig.json',
  ])('refuses a changed executed canonical input: %s', (path) =>
    withFixture((f) => {
      writeFileSync(join(f.root, path), readFileSync(join(f.root, path), 'utf8') + '\n');
      expect(() => f.qualify()).toThrow('canonical harness differs');
    })
  );

  it('refuses a later changed canonical imported helper instead of reusing the old executed helper', () =>
    withFixture((f) => {
      const path = 'tests/e2e/support/ensureClubMembership.ts';
      const old = readFileSync(join(f.root, path), 'utf8');
      const served = f.forward(path, old + '\n// later canonical helper\n');
      writeFileSync(join(f.root, path), old);
      expect(() => f.qualify(served)).toThrow('canonical harness differs');
    }));

  it('refuses a new higher-priority canonical import file even when every old named input is unchanged', () =>
    withFixture((f) => {
      const spec = join(f.root, 'tests/e2e/stats-deep.spec.ts');
      writeFileSync(spec, readFileSync(spec, 'utf8') + "\nimport './support/journey-extra';\n");
      writeFileSync(
        join(f.root, 'tests/e2e/support/journey-extra.tsx'),
        'export const extra = true;\n'
      );
      const baseline = f.commit(f.original);
      f.git('update-ref', 'refs/heads/main', baseline);
      f.git('update-ref', 'refs/remotes/origin/main', baseline);
      expect(f.qualify(baseline, baseline, baseline).journeySha).toBe(baseline);
      const published = f.forward(
        'tests/e2e/support/journey-extra.ts',
        'export const extra = false;\n'
      );
      rmSync(join(f.root, 'tests/e2e/support/journey-extra.ts'));
      // Every formerly named input still matches. Canonical resolution must
      // also be checked: the new .ts shadows that unchanged .tsx.
      for (const path of statsHarnessInputs(f.root))
        expect(f.git('show', `${published}:${path}`)).toBe(
          readFileSync(join(f.root, path), 'utf8')
        );
      expect(() => f.qualify(published, published, baseline)).toThrow(
        'canonical import resolution differs'
      );
    }));

  it('compares exact source bytes rather than replacement-normalized UTF-8 text', () =>
    withFixture((f) => {
      const path = join(f.root, 'tests/e2e/support/nonVerdict.ts');
      const before = Buffer.concat([readFileSync(path), Buffer.from([47, 47, 128, 10])]);
      writeFileSync(path, before);
      const baseline = f.commit(f.original);
      f.git('update-ref', 'refs/heads/main', baseline);
      f.git('update-ref', 'refs/remotes/origin/main', baseline);
      expect(f.qualify(baseline, baseline, baseline).journeySha).toBe(baseline);
      const after = Buffer.from(before);
      after[after.length - 2] = 129;
      expect(after.toString('utf8')).toBe(before.toString('utf8'));
      writeFileSync(path, after);
      expect(() => f.qualify(baseline, baseline, baseline)).toThrow('canonical harness differs');
    }));

  it.each([controls[0], controls[2]])('refuses an uncommitted pin-control change: %s', (path) =>
    withFixture((f) => {
      writeFileSync(join(f.root, path), 'changed control');
      expect(() => f.qualify()).toThrow('pin control differs');
    })
  );

  it.each([
    'import(variablePath);',
    'require(variablePath);',
    "new Function('return 1')();",
    "import('unlocked-package');",
    "import './missing-helper';",
  ])('refuses an unqualified executable dependency: %s', (extra) =>
    withFixture((f) => {
      const path = join(f.root, 'tests/e2e/stats-deep.spec.ts');
      writeFileSync(path, readFileSync(path, 'utf8') + '\n' + extra);
      expect(() => statsHarnessInputs(f.root)).toThrow();
    })
  );

  it('refuses symlinked local imports and oversized inputs', () =>
    withFixture((f) => {
      const path = join(f.root, 'tests/e2e/support/nonVerdict.ts');
      rmSync(path);
      symlinkSync(join(sourceRoot, 'tests/e2e/support/nonVerdict.ts'), path);
      expect(() => statsHarnessInputs(f.root)).toThrow('regular file');
      rmSync(path);
      writeFileSync(path, ' '.repeat(4 * 1024 * 1024 + 1));
      expect(() => statsHarnessInputs(f.root)).toThrow('byte bound');
    }));

  it('executes the maintained Stats shell block: fresh pin is scoped, UNKNOWN cannot fall back, hard refusal stays red', () => {
    const workflow = parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
    const run = workflow.jobs['production-e2e'].steps.find(
      (step: any) => step.name === 'Run the specs that need a deployed page'
    ).run as string;
    const block = run.slice(run.indexOf('stats_pin_rc=0'), run.indexOf('# Financial Admin'));
    const execute = (program: string, exit = 0) =>
      execFileSync(
        'bash',
        [
          '-c',
          `
      export LIVE_SHA=1111111111111111111111111111111111111111
      rc=0
      node() { printf '%s\\n' 2222222222222222222222222222222222222222; return ${exit}; }
      run_suite() { bash -c 'printf "seen:%s:%s\\n" "$LIVE_SHA" "\${DOWNLINE_JOURNEY_SHA-unset}"'; }
      ${program}
      printf 'after:%s:%s:%s\\n' "$LIVE_SHA" "$rc" "\${DOWNLINE_JOURNEY_SHA-unset}"
    `,
        ],
        { encoding: 'utf8' }
      );
    // Actual predecessor invocation from protected 7bb3b99: it has no
    // journey-local pin, exactly the two observed stale LIVE_SHA skips.
    const predecessor =
      'run_suite stats.json tests/e2e/stats-deep.spec.ts --project=chromium --reporter=line,json --workers=1 --retries=0\n' +
      'stats_rc=$?; [ $stats_rc -ne 0 ] && rc=$stats_rc';
    expect(execute(predecessor)).toContain('seen:1111111111111111111111111111111111111111:unset');
    expect(execute(block)).toContain(
      'seen:1111111111111111111111111111111111111111:2222222222222222222222222222222222222222'
    );
    expect(execute(block)).toContain('after:1111111111111111111111111111111111111111:0:unset');
    expect(execute(block, 3)).toContain('seen:1111111111111111111111111111111111111111:UNKNOWN');
    expect(execute(block, 3)).toContain('after:1111111111111111111111111111111111111111:0:unset');
    expect(execute(block, 1)).toContain('seen:1111111111111111111111111111111111111111:UNKNOWN');
    expect(execute(block, 1)).toContain('after:1111111111111111111111111111111111111111:1:unset');
  });

  it('qualifies the dedicated journey after its fresh LIVE_SHA and passes only that qualified pin to the one case', () => {
    const workflow = parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
    const job = workflow.jobs['stats-pagination-proof'];
    const pin = job.steps.findIndex((step: any) => step.id === 'pin');
    const qualified = job.steps.findIndex((step: any) => step.id === 'journey_pin');
    const proof = job.steps.findIndex((step: any) => step.id === 'proof');
    expect(qualified).toBeGreaterThan(pin);
    expect(qualified).toBeLessThan(proof);
    const directory = mkdtempSync(join(tmpdir(), 'downline-dedicated-wiring-'));
    const environmentFile = join(directory, 'github-env');
    const expected = '1'.repeat(40);
    const execute = (returned: string, exit = 0) => {
      writeFileSync(environmentFile, '');
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
        node() {
          [ "$1" = scripts/ci/downline-journey-pin.mjs ] || return 99
          printf '%s\\n' '${returned}'
          return ${exit}
        }
        ${job.steps[qualified].run}
      `,
        ],
        {
          env: { ...process.env, LIVE_SHA: expected, GITHUB_ENV: environmentFile },
          encoding: 'utf8',
        }
      );
      return { status: result.status, written: readFileSync(environmentFile, 'utf8') };
    };
    try {
      // The existing pin step alone sets LIVE_SHA. The case reads the separate
      // journey variable, so this actual old route could not execute its proof.
      expect(job.steps[pin].run).not.toContain('DOWNLINE_JOURNEY_SHA=');
      expect(execute(expected)).toEqual({
        status: 0,
        written: `DOWNLINE_JOURNEY_SHA=${expected}\n`,
      });
      for (const [returned, exit] of [
        [expected, 3],
        [expected, 1],
        ['UNKNOWN', 0],
        ['2'.repeat(40), 0],
      ] as const) {
        const result = execute(returned, exit);
        expect(result.status).not.toBe(0);
        expect(result.written).toBe('');
      }
      expect(job.steps[qualified].run).not.toMatch(/(?:^|\n)\s*(?:export )?LIVE_SHA=/);
      const artifact = job.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4');
      expect(artifact.with.path).toContain('e2e-report/downline-journey-pin.json');
      expect(job.steps[proof].run).toContain('--workers=1 --retries=0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('wires only the seventh journey pin and both-origin brackets without changing the job pin', () => {
    const workflow = parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
    const step = workflow.jobs['production-e2e'].steps.find(
      (s: any) => s.name === 'Run the specs that need a deployed page'
    );
    expect(step.env.LIVE_SHA).toBe('${{ steps.live.outputs.sha }}');
    expect(step.run).toContain('DOWNLINE_JOURNEY_SHA="$stats_pin" run_suite stats.json');
    expect(step.run).toContain('[ "$stats_pin_rc" -eq 0 ] || stats_pin=UNKNOWN');
    expect(step.run).toContain(
      'if [ "$stats_pin_rc" -ne 0 ] && [ "$stats_pin_rc" -ne 3 ]; then stats_rc=$stats_pin_rc; fi'
    );
    expect(step.run).not.toMatch(/(?:^|\n)\s*LIVE_SHA=/);
    const spec = readFileSync('tests/e2e/stats-deep.spec.ts', 'utf8');
    expect(spec).toContain('const expected = process.env.DOWNLINE_JOURNEY_SHA');
    expect(spec).not.toContain('process.env.DOWNLINE_JOURNEY_SHA || process.env.LIVE_SHA');
    expect(spec).toContain("'https://ca-static.smarter.poker'");
    expect(spec).toContain("'https://smarter.poker/hub/club-arena'");
    expect(spec).toContain("await release('before')");
    expect(spec).toContain("await release('after')");
  });
});
