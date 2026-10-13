import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { parse } from 'yaml';
import {
  admitReleaseVerdict,
  makeReleaseVerdict,
  inspectPublisherJobs,
} from '../../scripts/ci/client-publication-verdict.mjs';

const root = resolve(__dirname, '../..');
const publisherText = readFileSync(join(root, '.github/workflows/publish-club-arena.yml'), 'utf8');
const publisher = parse(publisherText);
const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);
const certification = parse(workflow);
const realtimeCertification = readFileSync(
  resolve(__dirname, '../e2e/production-customization-realtime.spec.ts'),
  'utf8'
);
const gameplayCertification = readFileSync(
  resolve(__dirname, '../e2e/gameplay-customization-runtime.spec.ts'),
  'utf8'
);
const appearanceObservation = readFileSync(
  resolve(__dirname, '../e2e/support/appearanceRealtimeObservation.ts'),
  'utf8'
);
const oneShotRequestGate = readFileSync(
  resolve(__dirname, '../e2e/support/oneShotRequestGate.ts'),
  'utf8'
);

describe('post-deploy E2E concurrency', () => {
  it('requires the source-bound verdict receipt without using aggregate source success', () => {
    expect(workflow).toContain('client-publication-verdict.mjs select');
    expect(workflow).toContain('client-publication-verdict.mjs admit');
    expect(workflow).toContain('/attempts/$SOURCE_RUN_ATTEMPT/jobs?per_page=100');
    expect(workflow).not.toContain('SOURCE_CONCLUSION:');
    expect(workflow).not.toContain('should_run=false');
    expect(workflow).toContain('needs: publication-gate');
    expect(workflow).toContain("if: needs.publication-gate.outputs.should_run == 'true'");
  });

  it('still serializes genuine production checks so authenticated writes cannot overlap', () => {
    const productionJob = workflow.slice(workflow.indexOf('  production-e2e:'));
    const concurrency = productionJob.match(/concurrency:\n([\s\S]*?)\n\s+steps:/)?.[1] ?? '';

    expect(concurrency).toContain('cancel-in-progress: false');
    expect(concurrency).toContain('group: post-deploy-e2e-production');
    expect(concurrency).not.toContain('manual-');
  });

  it('fails closed on malformed, unknown, or divergent live provenance', () => {
    expect(workflow).toContain('production-e2e-provenance.mjs build-info');
    expect(workflow).toContain('[[ "$LIVE" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('git fetch --no-tags origin "$LIVE" --depth=1');
    expect(workflow).toContain('production-e2e-provenance.mjs lineage "$LIVE" "$HERE"');
    expect(workflow).not.toContain(
      'git fetch --no-tags origin "$LIVE" --depth=1 2>/dev/null || true'
    );
    expect(workflow).not.toContain('::warning::deployed sha');
    expect(workflow).not.toContain('specs left at $HERE');
  });

  it('runs stateful production contracts alone and never hides a first-attempt failure', () => {
    expect(workflow).not.toContain('--retries=1');
    expect(workflow.match(/--retries=0/g)?.length).toBeGreaterThanOrEqual(5);

    for (const spec of [
      'club-lobby.spec.ts',
      'production-customization-realtime.spec.ts',
      'production-customization-commerce.spec.ts',
      'production-daily-missions.spec.ts',
    ]) {
      expect(workflow).toMatch(
        new RegExp(`${spec.replaceAll('.', '\\.')}[\\s\\S]{0,120}--workers=1 --retries=0`)
      );
    }
    expect(workflow).toContain('--reporter=line,json --workers=2 --retries=0');
  });

  it('hard-deletes disposable realtime fixtures without restoring cosmetics first', () => {
    expect(realtimeCertification).not.toContain('restoreState(');
    expect(realtimeCertification).toContain(
      'cleanupTemporaryCustomizationAccount(environment, primaryAccount)'
    );
    expect(realtimeCertification).toContain(
      'cleanupTemporaryCustomizationAccount(environment, otherAccount)'
    );
    expect(realtimeCertification).toContain(
      '[customization-realtime] second player remained isolated'
    );
  });

  // Hosted client shards deliberately have shallow history. Qualify real Git
  // ancestry in a disposable two-commit repository, never in checkout history.
  const ancestryRoot = mkdtempSync(join(tmpdir(), 'publication-verdict-ancestry-'));
  const fixtureGit = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: ancestryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Publication qualification',
        GIT_AUTHOR_EMAIL: 'publication-qualification@example.invalid',
        GIT_COMMITTER_NAME: 'Publication qualification',
        GIT_COMMITTER_EMAIL: 'publication-qualification@example.invalid',
      },
    }).trim();
  fixtureGit('init', '--quiet', '--initial-branch=main');
  fixtureGit('commit', '--quiet', '--allow-empty', '-m', 'Protected trigger fixture');
  const triggerSha = fixtureGit('rev-parse', 'HEAD');
  fixtureGit('commit', '--quiet', '--allow-empty', '-m', 'Protected selected fixture');
  const selectedSha = fixtureGit('rev-parse', 'HEAD');
  fixtureGit('update-ref', 'refs/remotes/origin/main', selectedSha);
  cpSync(join(root, 'scripts/ci'), join(ancestryRoot, 'scripts/ci'), { recursive: true });
  afterAll(() => rmSync(ancestryRoot, { recursive: true, force: true }));

  const source = {
    runId: '34567',
    attempt: '2',
    repositoryId: '1132369872',
    triggerSha,
    branch: 'main',
    workflow: '.github/workflows/publish-club-arena.yml',
  };
  const resultStep = (status: string) => ({ outcome: status, conclusion: status });
  const sourceRun = () => ({
    id: Number(source.runId),
    run_attempt: 2,
    head_sha: source.triggerSha,
    head_branch: 'main',
    path: source.workflow,
    repository: { id: Number(source.repositoryId) },
    head_repository: { id: Number(source.repositoryId) },
  });
  const artifact = (name: string) => ({
    id: 76543,
    name,
    expired: false,
    workflow_run: {
      id: Number(source.runId),
      head_sha: source.triggerSha,
      head_branch: 'main',
      repository_id: Number(source.repositoryId),
      head_repository_id: Number(source.repositoryId),
    },
  });
  function input(mode = 'publish') {
    const retained = mode === 'retained';
    const runtimeSha = retained ? source.triggerSha : selectedSha;
    const selected = mode === 'standdown' ? source.triggerSha : selectedSha;
    const retention = JSON.stringify({
      schema: 1,
      kind: 'retained-client-runtime',
      sourceRunId: source.runId,
      sourceTriggerSha: source.triggerSha,
      repositoryId: source.repositoryId,
      runtimeSha,
      verificationSha: selectedSha,
      originalPublisherRunId: '12345',
      originalArtifactId: 54321,
      inputs: { complete: true, sourceSha: runtimeSha },
      buildInfoSHA256: 'a'.repeat(64),
      manifestSHA256: 'b'.repeat(64),
      paths: ['scripts/ci/example.mjs'],
    });
    const steps = retained
      ? { finalized: resultStep('success'), recorded: resultStep('success') }
      : {
          verdict: resultStep('success'),
          published: resultStep(mode === 'publish' ? 'success' : 'skipped'),
          verified: resultStep(mode === 'publish' ? 'success' : 'skipped'),
        };
    const receipt = makeReleaseVerdict({
      source,
      producerJob: retained ? 'retain-runtime' : 'publish-to-origin',
      mode,
      selectedSha: selected,
      runtimeSha,
      steps,
      verifiedSha: mode === 'publish' ? selected : undefined,
      buildInfo: JSON.stringify({ ca_sha: selected }),
      manifest: 'immutable bytes',
      retention,
    });
    const jobs = {
      total_count: 2,
      jobs: [
        {
          id: 123,
          run_id: Number(source.runId),
          run_attempt: 2,
          head_sha: source.triggerSha,
          name: 'publish-to-origin',
          status: 'completed',
          conclusion: retained ? 'skipped' : 'success',
          steps: [],
        },
        {
          id: 124,
          run_id: Number(source.runId),
          run_attempt: 2,
          head_sha: source.triggerSha,
          name: 'retain-runtime',
          status: 'completed',
          conclusion: retained ? 'success' : 'skipped',
          steps: [],
        },
      ],
    };
    const artifacts = {
      total_count: 2,
      artifacts: [
        artifact('club-arena-release-verdict-2'),
        artifact(retained ? 'club-arena-retained-runtime' : 'club-arena-dist-' + selected),
      ],
    };
    return {
      source,
      run: sourceRun(),
      jobs,
      artifacts,
      receipt,
      retention,
      isProtected: () => true,
      isAncestor: () => true,
    };
  }

  function nativeGate(value: ReturnType<typeof input>, command?: string) {
    const directory = mkdtempSync(join(tmpdir(), 'publication-verdict-native-'));
    try {
      for (const [name, body] of Object.entries({
        run: value.run,
        jobs: value.jobs,
        artifacts: value.artifacts,
        receipt: value.receipt,
      })) {
        writeFileSync(join(directory, name + '.json'), JSON.stringify(body));
      }
      writeFileSync(join(directory, 'retained-runtime.json'), value.retention);
      const output = join(directory, 'output');
      writeFileSync(output, '');
      const body =
        command ??
        certification.jobs['publication-gate'].steps.find(
          (entry: { name: string }) => entry.name === 'Read The Origin Job Verdict'
        ).run;
      // Only the authenticated transport is substituted. The maintained shell,
      // artifact/run validators, receipt reader and real Git ancestry all execute.
      const transport = `
timeout() { shift; "$@"; }
gh() {
  if [ "$1" = api ]; then
    case "$2" in
      */jobs*) cat "$FIXTURE_DIR/jobs.json" ;;
      */artifacts*) cat "$FIXTURE_DIR/artifacts.json" ;;
      *) cat "$FIXTURE_DIR/run.json" ;;
    esac
  elif [ "$1" = run ] && [ "$2" = download ]; then
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in --dir) DIR="$2";shift 2;; --name) NAME="$2";shift 2;; *) shift;; esac
    done
    mkdir -p "$DIR"
    if [ "$NAME" = club-arena-retained-runtime ]; then
      cp "$FIXTURE_DIR/retained-runtime.json" "$DIR/retained-runtime.json"
    else
      cp "$FIXTURE_DIR/receipt.json" "$DIR/release-verdict.json"
    fi
  else return 99; fi
}
`;
      const result = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          transport +
            body.replaceAll('${{ github.repository }}', 'Smarter-Poker/Smarter-Poker-Club-Arena'),
        ],
        {
          cwd: ancestryRoot,
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            EVENT_NAME: 'workflow_run',
            SOURCE_RUN_ID: source.runId,
            SOURCE_RUN_ATTEMPT: source.attempt,
            SOURCE_TRIGGER_SHA: source.triggerSha,
            REPOSITORY_ID: source.repositoryId,
            GITHUB_OUTPUT: output,
            FIXTURE_DIR: directory,
          },
        }
      );
      return { status: result.status, stderr: result.stderr, output: readFileSync(output, 'utf8') };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function assertVerdictWiring(publisherSource: string, consumerSource: string) {
    const publisher = parse(publisherSource),
      consumer = parse(consumerSource);
    const origin = publisher.jobs['publish-to-origin'].steps;
    const retained = publisher.jobs['retain-runtime'].steps;
    for (const [steps, writerName, command, ids] of [
      [
        origin,
        'Write the exact origin release verdict',
        'produce-origin',
        ['verdict', 'published', 'verified'],
      ],
      [
        retained,
        'Write the exact retained release verdict',
        'produce-retained',
        ['finalized', 'recorded'],
      ],
    ] as const) {
      const writer = steps.find((step: { name: string }) => step.name === writerName);
      expect(writer).toBeDefined();
      expect(writer.run).toContain('node scripts/ci/client-publication-verdict.mjs ' + command);
      expect(writer.if).toBeUndefined(); // Ordinary success(), never always()/continue-on-error.
      expect(writer['continue-on-error']).toBeUndefined();
      if (command === 'produce-origin') {
        expect(writer.env.VERIFIED_SHA).toBe('${{ steps.verified.outputs.sha }}');
        expect(writer.env.SELECTED_SHA).toBe('${{ steps.verdict.outputs.ours }}');
        expect(writer.env.RELEASE_VERDICT).toBe('${{ steps.verdict.outputs.verdict }}');
      }
      for (const id of ids) {
        expect(steps.filter((step: { id?: string }) => step.id === id)).toHaveLength(1);
        expect(writer.env.RELEASE_STEP_RESULTS).toContain('${{ steps.' + id + '.outcome }}');
        expect(writer.env.RELEASE_STEP_RESULTS).toContain('${{ steps.' + id + '.conclusion }}');
      }
      const upload = steps.find(
        (step: { name: string }) => step.name === 'Upload the immutable release verdict'
      );
      expect(upload?.uses).toBe('actions/upload-artifact@v4');
      expect(upload?.with).toEqual({
        name: 'club-arena-release-verdict-${{ github.run_attempt }}',
        path: 'release-verdict.json',
        'if-no-files-found': 'error',
        'retention-days': 7,
      });
      expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(writer));
      for (const id of ids)
        expect(steps.indexOf(writer)).toBeGreaterThan(
          steps.findIndex((step: { id?: string }) => step.id === id)
        );
    }
    const gate = consumer.jobs['publication-gate'].steps.find(
      (step: { name: string }) => step.name === 'Read The Origin Job Verdict'
    );
    expect(gate.env.SOURCE_RUN_ATTEMPT).toBe("${{ github.event.workflow_run.run_attempt || '' }}");
    expect(gate.run).toContain('client-publication-verdict.mjs select');
    expect(gate.run.match(/client-publication-verdict\.mjs admit/g)).toHaveLength(2);
    expect(gate.run).toContain('--name "$ARTIFACT_NAME"');
    expect(gate.run).toContain('client-runtime-retention.mjs receipt-artifact');
    expect(gate.run).not.toContain('origin.conclusion');
    expect(gate.run).not.toContain('|| true');
  }

  describe('actual source-bound release verdicts', () => {
    it.each(['publish', 'standdown', 'retained'])(
      'admits exact %s evidence despite empty provider steps',
      (mode) => {
        const value = input(mode);
        expect(admitReleaseVerdict(value)).toEqual({
          shouldRun: true,
          retained: mode === 'retained',
        });
        const result = nativeGate(value);
        expect(result.status, result.stderr).toBe(0);
        expect(result.output).toBe(
          'engine_trigger_sha=\nshould_run=true\n' + (mode === 'retained' ? 'retained=true\n' : '')
        );
      }
    );

    it.each(['failure', 'cancelled', 'skipped', ''])(
      'refuses actual publish outcome %s under successful conclusion',
      (state) => {
        const value = input();
        value.receipt.steps.published.outcome = state;
        expect(() => admitReleaseVerdict(value)).toThrow();
        const result = nativeGate(value);
        expect(result.status).not.toBe(0);
        expect(result.output).not.toContain('should_run=true');
      }
    );

    it.each([
      'missing receipt',
      'wrong run',
      'wrong attempt',
      'wrong repository',
      'wrong trigger',
      'wrong selected SHA',
      'missing verify output',
      'expired artifact',
      'duplicate receipt',
      'partial pagination',
      'wrong artifact run',
      'wrong producer',
      'failed job',
      'cancelled job',
      'unprotected revision',
      'wrong lineage',
      'masked verify failure',
      'wrong job run',
      'wrong job attempt',
    ])('refuses %s', (kind) => {
      const value = input();
      if (kind === 'missing receipt') value.receipt = null as never;
      if (kind === 'wrong run') value.receipt.source = { ...source, runId: '99999' };
      if (kind === 'wrong attempt') value.receipt.source = { ...source, attempt: '1' };
      if (kind === 'wrong repository') value.receipt.source = { ...source, repositoryId: '99999' };
      if (kind === 'wrong trigger')
        value.receipt.source = { ...source, triggerSha: 'f'.repeat(40) };
      if (kind === 'wrong selected SHA') value.receipt.selectedSha = source.triggerSha;
      if (kind === 'missing verify output') value.receipt.verifiedSha = null;
      if (kind === 'expired artifact') value.artifacts.artifacts[0].expired = true;
      if (kind === 'duplicate receipt') {
        value.artifacts.artifacts.push(value.artifacts.artifacts[0]);
        value.artifacts.total_count++;
      }
      if (kind === 'partial pagination') value.artifacts.total_count++;
      if (kind === 'wrong artifact run') value.artifacts.artifacts[0].workflow_run.id++;
      if (kind === 'wrong producer') value.receipt.producerJob = 'build-and-store';
      if (kind === 'failed job') value.jobs.jobs[0].conclusion = 'failure';
      if (kind === 'cancelled job') value.jobs.jobs[0].conclusion = 'cancelled';
      if (kind === 'unprotected revision') value.isProtected = () => false;
      if (kind === 'wrong lineage') value.isAncestor = () => false;
      if (kind === 'masked verify failure') value.receipt.steps.verified.outcome = 'failure';
      if (kind === 'wrong job run') value.jobs.jobs[0].run_id++;
      if (kind === 'wrong job attempt') value.jobs.jobs[0].run_attempt++;
      expect(() => admitReleaseVerdict(value)).toThrow();
    });

    it.each(['missing proof', 'wrong digest', 'origin also ran', 'masked finalize failure'])(
      'refuses retained %s',
      (kind) => {
        const value = input('retained');
        if (kind === 'missing proof') value.retention = '';
        if (kind === 'wrong digest') value.receipt.retentionSHA256 = '0'.repeat(64);
        if (kind === 'origin also ran') value.jobs.jobs[0].conclusion = 'success';
        if (kind === 'masked finalize failure') value.receipt.steps.finalized.outcome = 'failure';
        expect(() => admitReleaseVerdict(value)).toThrow();
      }
    );

    it('keeps superseded-before-origin runs as non-verdicts and refuses unknown jobs', () => {
      expect(inspectPublisherJobs({ total_count: 0, jobs: [] })).toBeNull();
      expect(
        inspectPublisherJobs({
          total_count: 2,
          jobs: [{ conclusion: 'cancelled' }, { conclusion: 'skipped' }],
        })
      ).toBeNull();
      expect(() =>
        inspectPublisherJobs({
          total_count: 1,
          jobs: [{ name: 'renamed-origin', conclusion: 'success' }],
        })
      ).toThrow();
      expect(() => inspectPublisherJobs({ total_count: 2, jobs: [] })).toThrow();
      expect(() => inspectPublisherJobs({ message: 'unreadable' })).toThrow();
    });

    it.each(['publish', 'standdown', 'retained'])(
      'executes the real %s producer and refuses masked failure before writing',
      (mode) => {
        const desired = input(mode);
        const retained = mode === 'retained';
        const steps = publisher.jobs[retained ? 'retain-runtime' : 'publish-to-origin'].steps;
        const writer = steps.find(
          (entry: { name: string }) =>
            entry.name ===
            (retained
              ? 'Write the exact retained release verdict'
              : 'Write the exact origin release verdict')
        );
        const directory = mkdtempSync(join(tmpdir(), 'publication-verdict-producer-'));
        try {
          mkdirSync(join(directory, 'dist'));
          writeFileSync(
            join(directory, 'dist/build-info.json'),
            JSON.stringify({ ca_sha: desired.receipt.selectedSha })
          );
          writeFileSync(join(directory, 'dist/.release-manifest.sha256'), 'immutable bytes');
          writeFileSync(join(directory, 'retained-runtime.json'), desired.retention);
          const values: Record<string, string> = {
            'steps.verdict.outputs.verdict': mode,
            'steps.verdict.outputs.ours': desired.receipt.selectedSha,
            'steps.verdict.outputs.theirs': desired.receipt.runtimeSha,
            'steps.verified.outputs.sha': mode === 'publish' ? desired.receipt.selectedSha : '',
            'steps.verdict.outcome': 'success',
            'steps.verdict.conclusion': 'success',
            'steps.published.outcome': mode === 'publish' ? 'success' : 'skipped',
            'steps.published.conclusion': mode === 'publish' ? 'success' : 'skipped',
            'steps.verified.outcome': mode === 'publish' ? 'success' : 'skipped',
            'steps.verified.conclusion': mode === 'publish' ? 'success' : 'skipped',
            'steps.finalized.outcome': 'success',
            'steps.finalized.conclusion': 'success',
            'steps.recorded.outcome': 'success',
            'steps.recorded.conclusion': 'success',
            "steps.verdict.outputs.verdict == 'publish' && steps.verdict.outputs.ours || steps.verdict.outputs.theirs":
              desired.receipt.runtimeSha,
          };
          const run = (filename: string) => {
            const env = Object.fromEntries(
              Object.entries(writer.env).map(([key, value]) => [
                key,
                String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_all, expression: string) => {
                  if (!(expression in values))
                    throw new Error('Unreviewed producer context: ' + expression);
                  return values[expression];
                }),
              ])
            );
            const command = writer.run
              .replace(
                'scripts/ci/client-publication-verdict.mjs',
                join(root, 'scripts/ci/client-publication-verdict.mjs')
              )
              .replace('release-verdict.json', filename);
            return spawnSync('bash', ['-c', command], {
              cwd: directory,
              encoding: 'utf8',
              env: {
                ...process.env,
                ...env,
                GITHUB_REF: 'refs/heads/main',
                GITHUB_JOB: retained ? 'retain-runtime' : 'publish-to-origin',
                GITHUB_RUN_ID: source.runId,
                GITHUB_RUN_ATTEMPT: source.attempt,
                GITHUB_SHA: source.triggerSha,
                GITHUB_REPOSITORY_ID: source.repositoryId,
              },
            });
          };
          const passed = run('good.json');
          expect(passed.status, passed.stderr).toBe(0);
          expect(JSON.parse(readFileSync(join(directory, 'good.json'), 'utf8')).mode).toBe(mode);
          values[retained ? 'steps.finalized.outcome' : 'steps.published.outcome'] = 'failure';
          const refused = run('masked.json');
          expect(refused.status).not.toBe(0);
          expect(existsSync(join(directory, 'masked.json'))).toBe(false);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    );

    it('enforces the actual producer and consumer calls, including removal mutations', () => {
      assertVerdictWiring(publisherText, workflow);
      expect(() =>
        assertVerdictWiring(
          publisherText.replace(
            'produce-origin release-verdict.json',
            'removed release-verdict.json'
          ),
          workflow
        )
      ).toThrow();
      expect(() =>
        assertVerdictWiring(
          publisherText.replace(
            'produce-retained release-verdict.json',
            'removed release-verdict.json'
          ),
          workflow
        )
      ).toThrow();
      expect(() =>
        assertVerdictWiring(
          publisherText,
          workflow.replaceAll(
            'client-publication-verdict.mjs admit',
            'client-publication-verdict.mjs omitted'
          )
        )
      ).toThrow();
      expect(() =>
        assertVerdictWiring(
          publisherText.replace('steps.published.outcome', 'steps.published.conclusion'),
          workflow
        )
      ).toThrow();
    });
  });

  it('rehydrates realtime settings with one bounded Studio navigation', () => {
    expect(realtimeCertification).not.toContain(
      "mobilePage.reload({ waitUntil: 'domcontentloaded' })"
    );
    expect(realtimeCertification).toContain('mobileStudio = await openStudio(mobilePage)');
    expect(realtimeCertification).toContain(
      "page.goto('./', { waitUntil: 'domcontentloaded', timeout: 60_000 })"
    );
    expect(realtimeCertification).toContain(
      '[customization-realtime] persisted appearance survived a device reload'
    );
    expect(realtimeCertification).toContain("pathname.endsWith('/rest/v1/user_theme_settings')");
    expect(realtimeCertification.indexOf('const hydrated = page.waitForResponse')).toBeLessThan(
      realtimeCertification.indexOf('await Promise.all([hydrated, open.click()])')
    );
    expect(realtimeCertification).toContain('await Promise.all([hydrated, open.click()])');
    expect(realtimeCertification).toContain("{ expectedLook: 'custom' }");
    expect(realtimeCertification).toContain(".getByText('Custom Mix', { exact: true })");
    expect(realtimeCertification).toContain(
      'await expectSelectedAppearanceTiles(mobileStudio, finalPrimary)'
    );
    expect(realtimeCertification).toContain('observeAppearanceRealtime(page, account.id)');
    expect(realtimeCertification).toContain(
      'The primary appearance channel never completed its private join.'
    );
    expect(appearanceObservation).toContain("frame.event === 'phx_join' && frame.ref");
    expect(appearanceObservation).toContain('socketState.pendingJoinRefs.has(frame.ref)');
    expect(appearanceObservation).toContain("page.on('request'");
    expect(appearanceObservation).toContain('request.isNavigationRequest()');
  });

  it('projects routed gameplay without depending on a currently live production game', () => {
    expect(gameplayCertification).toContain(
      "getByRole('button', { name: 'Open Table Studio', exact: true })"
    );
    expect(gameplayCertification).not.toContain("getByRole('button', { name: 'Open Studio' })");
    expect(gameplayCertification).toContain('readable table authorization anchor');
    expect(gameplayCertification).toContain(
      'arena:clubs!fk_tables_club_id(id,asset,is_platform,union_id)'
    );
    expect(gameplayCertification).toContain("is_deleted: 'eq.false'");
    expect(gameplayCertification).toContain("deleted_at: 'is.null'");
    expect(gameplayCertification).toContain("order: 'created_at.asc,id.asc'");
    expect(gameplayCertification).not.toContain("order: 'created_at.desc'");
    expect(gameplayCertification).toContain("name: 'Customization Certification Table'");
    expect(gameplayCertification).toContain("status: 'running'");
    expect(gameplayCertification).not.toContain("status: 'in.(waiting,running,active)'");
    expect(gameplayCertification).not.toContain("game_type: 'eq.cash'");
    expect(gameplayCertification).not.toContain("tournament_id: 'is.null'");
    expect(gameplayCertification).not.toContain(
      'The certification club has no readable live cash table for routed proof.'
    );
  });

  it('releases a held appearance write before expecting another browser to reconcile it', () => {
    const chooseStart = gameplayCertification.indexOf('async function chooseAppearance');
    const chooseEnd = gameplayCertification.indexOf('\nasync function readTheme', chooseStart);
    const chooseAppearance = gameplayCertification.slice(chooseStart, chooseEnd);

    expect(chooseStart).toBeGreaterThanOrEqual(0);
    expect(chooseEnd).toBeGreaterThan(chooseStart);
    expect(chooseAppearance).toContain('runWithOneShotRequestGate({');
    expect(chooseAppearance.indexOf('runWithOneShotRequestGate({')).toBeLessThan(
      chooseAppearance.indexOf('await expect(readerRoot)')
    );
    expect(oneShotRequestGate.indexOf('const persistedOutcome')).toBeLessThan(
      oneShotRequestGate.indexOf('gate.arm();')
    );
    expect(oneShotRequestGate).toContain('finally {');
    expect(oneShotRequestGate).toContain('gate.release();');
    expect(oneShotRequestGate.indexOf('await verifyImmediate();')).toBeLessThan(
      oneShotRequestGate.indexOf('gate.release();')
    );
    expect(oneShotRequestGate.indexOf('gate.release();')).toBeLessThan(
      oneShotRequestGate.indexOf('const outcome = await persistedOutcome;')
    );
    expect(gameplayCertification.match(/runWithOneShotRequestGate\(\{/g)).toHaveLength(3);
    expect(gameplayCertification).not.toContain('writerProfileGate.arm()');
    expect(gameplayCertification).not.toContain('writerProfileGate.release()');
  });
});
