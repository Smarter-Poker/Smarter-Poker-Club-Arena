import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);
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
  it('runs only after exact publish proof or a successful safe stand-down', () => {
    expect(workflow).toContain('publication-gate:');
    expect(workflow).toContain('/actions/runs/$SOURCE_RUN_ID/jobs?filter=latest&per_page=100');
    expect(workflow).toContain("entry?.name === 'publish-to-origin'");
    expect(workflow).toContain(
      "entry?.name === 'Stand down if the origin already serves a newer bundle'"
    );
    expect(workflow).toContain(
      "entry?.name === 'Publish through the host-owned immutable transaction'"
    );
    expect(workflow).toContain("entry?.name === 'Verify the origin serves this bundle'");
    expect(workflow).toContain("origin.conclusion === 'success'");
    expect(workflow).toContain("proofs[0].conclusion === 'success'");
    expect(workflow).toContain("publishes[0].conclusion === 'skipped'");
    expect(workflow).toContain("proofs[0].conclusion === 'skipped'");
    expect(workflow).not.toContain('SOURCE_CONCLUSION:');
    expect(workflow).not.toContain('should_run=false');
    expect(workflow).toContain(
      'The source run neither proved a Hetzner web publish nor completed a safe forward stand-down.'
    );
    expect(workflow).toContain("fs.appendFileSync(output, 'should_run=true\\n')");
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

  // A PUBLISHER THAT NEVER PUBLISHED IS NOT A DEFECT ON PRODUCTION.
  //
  // publish-club-arena cancels in progress when a newer merge arrives. Run
  // 36749429418 was cancelled while still queued and produced ZERO jobs, so
  // this gate read `Expected one latest publish-to-origin job, received 0`
  // and the certificate went red twice in thirty seconds (36749436277,
  // 36749498583) before a single browser started. These execute the gate's
  // ACTUAL node block against the payload shapes that produce each verdict.
  describe('the gate block itself, executed', () => {
    const script = (() => {
      const start = workflow.indexOf('node - "$JOBS_JSON"');
      const body = workflow.slice(
        workflow.indexOf('\n', start) + 1,
        workflow.indexOf('\n          NODE', start)
      );
      return body.replace(/^ {10}/gm, '');
    })();

    const verdict = (payload: unknown) => {
      const directory = mkdtempSync(join(tmpdir(), 'post-deploy-gate-'));
      const jobsFile = join(directory, 'jobs.json');
      const output = join(directory, 'output');
      writeFileSync(jobsFile, JSON.stringify(payload));
      writeFileSync(output, '');
      const run = spawnSync(process.execPath, ['-', jobsFile, output], {
        input: script,
        encoding: 'utf8',
      });
      const result = {
        status: run.status,
        output: readFileSync(output, 'utf8'),
        stderr: run.stderr,
      };
      rmSync(directory, { recursive: true, force: true });
      return result;
    };

    const originJob = (publish: string, proof: string, standDown = 'success') => ({
      name: 'publish-to-origin',
      status: 'completed',
      conclusion: 'success',
      steps: [
        {
          name: 'Stand down if the origin already serves a newer bundle',
          status: 'completed',
          conclusion: standDown,
        },
        {
          name: 'Publish through the host-owned immutable transaction',
          status: 'completed',
          conclusion: publish,
        },
        { name: 'Verify the origin serves this bundle', status: 'completed', conclusion: proof },
      ],
    });

    it.each([
      ['a publisher cancelled before any job started', { total_count: 0, jobs: [] }],
      [
        'a publisher whose every job was cancelled or skipped',
        {
          total_count: 2,
          jobs: [
            { name: 'tests', conclusion: 'cancelled' },
            { name: 'x', conclusion: 'skipped' },
          ],
        },
      ],
    ])('stands down without a verdict for %s', (_label, payload) => {
      const result = verdict(payload);
      expect(result.status, result.stderr).toBe(0);
      // No should_run at all, so every downstream job skips and this run takes
      // no production lock. It is a non-event, not a pass and not a failure.
      expect(result.output).toBe('');
    });

    it('still certifies a real publish and a safe forward stand-down', () => {
      for (const payload of [
        { total_count: 1, jobs: [originJob('success', 'success')] },
        { total_count: 1, jobs: [originJob('skipped', 'skipped')] },
      ]) {
        const result = verdict(payload);
        expect(result.status, result.stderr).toBe(0);
        expect(result.output).toBe('should_run=true\n');
      }
    });

    it('admits only complete successful runtime qualification with no origin transaction', () => {
      const retention = {
        name: 'retain-runtime',
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Verify both origins still serve the qualified immutable runtime',
            status: 'completed',
            conclusion: 'success',
          },
          { name: 'Record qualified retained runtime', status: 'completed', conclusion: 'success' },
        ],
      };
      const skipped = {
        name: 'publish-to-origin',
        status: 'completed',
        conclusion: 'skipped',
        steps: [],
      };
      const valid = verdict({ total_count: 2, jobs: [retention, skipped] });
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.output).toBe('should_run=true\nretained=true\n');
      for (const payload of [
        { total_count: 3, jobs: [retention, skipped] },
        { jobs: [retention, skipped] },
        { total_count: 2, jobs: [retention, originJob('success', 'success')] },
        { total_count: 2, jobs: [{ ...retention, steps: retention.steps.slice(0, 1) }, skipped] },
      ])
        expect(verdict(payload).status).toBe(1);
    });

    // The stand-down must never become a way to skip certification when a
    // publish really happened. A source run holding jobs that actually ran,
    // with no publish-to-origin among them, is the renamed-job hole.
    it.each([
      [
        'jobs ran but none is publish-to-origin',
        {
          total_count: 1,
          jobs: [{ name: 'publish-to-hetzner', status: 'completed', conclusion: 'success' }],
        },
      ],
      ['the origin job failed', { total_count: 1, jobs: [originJob('failure', 'failure')] }],
      ['the jobs response is malformed', { total_count: 1 }],
    ])('still refuses %s', (_label, payload) => {
      expect(verdict(payload).status).toBe(1);
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
