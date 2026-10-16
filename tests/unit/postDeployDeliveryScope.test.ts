import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

// Subprocess contract suite: these tests drive REAL child processes, so their
// wall time scales with machine load, not with the code under test. vitest's
// 5000ms default is a UNIT-test budget: the slowest test here measures 507ms
// solo, and the pre-push hook runs this file in a 90-file suite at full width,
// where contention has been measured to stretch these runs by 7.1x and time
// them out. 90s is 177x the measured solo runtime - past anything observed,
// and still a real bound, so a genuinely hung child still fails the suite.
// File-scoped on purpose: no global testTimeout, no --no-file-parallelism.
vi.setConfig({ testTimeout: 90_000 });
import { gitEnvironmentForCwd } from '../../scripts/ci/classify-ci-changes.mjs';

/**
 * Point the shipped step at a fixture engine without editing the step. A
 * `data:` URL is a real fetch with a real 200 through the real reader, and it
 * needs no server - which matters here, because spawnSync blocks this
 * process's event loop and an in-process server could never answer the child.
 */
const onFixtureEngine = (script: string, health: string) =>
  script.replaceAll(
    '"https://engine.smarter.poker/health?certificate=$GITHUB_RUN_ID"',
    `"data:application/json,${encodeURIComponent(health)}"`
  );

const root = resolve(__dirname, '../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/post-deploy-e2e.yml'), 'utf8'));
const client = workflow.jobs['production-e2e'];
const engine = workflow.jobs['live-table-e2e'];
const engineSteps = engine?.steps ?? client.steps;
const resolver = engineSteps.find((step: any) => step.id === 'engine');
const admission = engineSteps.find(
  (step: any) => step.name === 'Require the exact engine before opening production browser fixtures'
);

describe('post-publication verification belongs to its delivered component', () => {
  it('retains the inbox verdict before unrelated suites and refuses missing execution', () => {
    const steps = client.steps;
    const inboxAt = steps.findIndex((entry: any) => entry.id === 'notification_inbox');
    const retainedAt = steps.findIndex(
      (entry: any) => entry.with?.name === 'post-deploy-notification-report'
    );
    const broadAt = steps.findIndex(
      (entry: any) => entry.name === 'Run the specs that need a deployed page'
    );
    expect(inboxAt).toBeGreaterThan(-1);
    expect(retainedAt).toBeGreaterThan(inboxAt);
    expect(retainedAt).toBeLessThan(broadAt);
    expect(steps[retainedAt].if).toContain('always()');
    expect(steps[retainedAt].with['if-no-files-found']).toBe('error');
    expect(steps[retainedAt].with.path).toContain('e2e-report/notifications.json');
    for (const reader of ['annotate-e2e-failures.mjs', 'assert-e2e-actually-ran.mjs']) {
      const entry = steps.find((entry: any) => entry.run?.includes(reader));
      expect(entry.run).toContain('e2e-report/notifications.json');
      expect(entry.if).toContain('always()');
    }
  });

  it('lets the live-table spectator read the union boards before certifying them', () => {
    const steps = engine.steps;
    const accountAt = steps.findIndex((step: any) => step.id === 'account');
    const spectatorAt = steps.findIndex((step: any) => step.id === 'spectator');
    const certifyAt = steps.findIndex(
      (step: any) => step.name === 'Certify live-table continuity against the exact serving engine'
    );
    expect(accountAt).toBeGreaterThan(-1);
    expect(spectatorAt).toBeGreaterThan(accountAt);
    expect(certifyAt).toBeGreaterThan(spectatorAt);
    expect(steps[spectatorAt].run).toBe(
      'node scripts/ci/production-e2e-account.mjs prepare-spectator'
    );
    // A union club: SPIN and SNG run only inside the union's scope.
    expect(steps[spectatorAt].env.E2E_SPECTATOR_CLUB_ID).toBe(
      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
    );
    expect(steps[certifyAt].if).toContain("steps.spectator.outcome == 'success'");
    // Never staff authority for a spectator certificate.
    expect(JSON.stringify(steps)).not.toContain('production-e2e-account.mjs prepare-staff');
  });

  it('gives the client its own result without an engine or live-table prerequisite', () => {
    expect(client.needs).toBe('publication-gate');
    expect(client.if).toBe("needs.publication-gate.outputs.should_run == 'true'");
    expect(JSON.stringify(client)).not.toMatch(
      /EXPECTED_ENGINE_SHA|engine-ready|ENGINE_TRIGGER_SHA|live-table-realtime/
    );
    expect(engine.needs).toBe('publication-gate');
    expect(engine.concurrency.group).not.toBe(client.concurrency.group);
    expect(engine.concurrency['cancel-in-progress']).toBe(false);
    expect(JSON.stringify(engine)).toContain('production-live-table-realtime.spec.ts');
    expect(JSON.stringify(engine)).toContain('assert-e2e-actually-ran.mjs');
    expect(JSON.stringify(engine)).toContain('production-e2e-account.mjs cleanup');
    for (const job of [client, engine]) {
      const accountAt = job.steps.findIndex((step: any) => step.id === 'account');
      for (const command of [
        'check-club-fk-indexes.mjs',
        'check-phantom-tables.mjs',
        'check-phantom-columns.mjs',
        'check-embed-relationships.mjs',
      ]) {
        const auditAt = job.steps.findIndex((step: any) => step.run?.includes(command));
        expect(auditAt).toBeGreaterThan(-1);
        expect(auditAt).toBeLessThan(accountAt);
        expect(job.steps[auditAt]['continue-on-error']).not.toBe(true);
      }
    }
  });

  it.each(['workflow_run', 'repository_dispatch'])(
    'executes the maintained resolver and admission for %s with an older healthy live engine',
    (event) => {
      const cwd = mkdtempSync(join(tmpdir(), 'ca-post-deploy-scope-'));
      const env = {
        ...gitEnvironmentForCwd(),
        GIT_AUTHOR_NAME: 'Scope fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Scope fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      };
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
      try {
        git('init', '-q');
        mkdirSync(join(cwd, 'server'), { recursive: true });
        writeFileSync(join(cwd, 'server/runtime.ts'), 'serving');
        git('add', '.');
        git('commit', '-qm', 'serving engine');
        const serving = git('rev-parse', 'HEAD');
        writeFileSync(join(cwd, 'server/runtime.ts'), 'unrelated pending engine');
        git('add', '.');
        git('commit', '-qm', 'pending engine');
        const pending = git('rev-parse', 'HEAD');
        git('update-ref', 'refs/remotes/origin/main', pending);
        git('remote', 'add', 'origin', cwd);
        git('branch', '-M', 'main');
        mkdirSync(join(cwd, 'scripts/ci'), { recursive: true });
        copyFileSync(
          join(root, 'scripts/ci/production-e2e-provenance.mjs'),
          join(cwd, 'scripts/ci/production-e2e-provenance.mjs')
        );
        // The resolver reads the engine through scripts/ci/read-engine-release.mjs
        // so a scheduled :55 restart is a wait rather than a red (run
        // 36717851302). Copy the real reader and serve the fixture over HTTP,
        // so this exercises the shipped transport instead of a stub of it.
        for (const script of ['read-engine-release.mjs', 'await-engine-gameplay.mjs']) {
          copyFileSync(join(root, 'scripts/ci', script), join(cwd, 'scripts/ci', script));
        }
        mkdirSync(join(cwd, 'bin'));
        writeFileSync(join(cwd, 'bin/curl'), '#!/bin/sh\nprintf "%s" "$FIXTURE_HEALTH"\n');
        chmodSync(join(cwd, 'bin/curl'), 0o755);
        const output = join(cwd, 'output');
        const common = {
          ...env,
          PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
          EVENT_NAME: event,
          ENGINE_TRIGGER_SHA: event === 'repository_dispatch' ? pending : '',
          FIXTURE_HEALTH: JSON.stringify({ releaseSha: serving, running: true, liveness: 'ok' }),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: join(cwd, 'summary'),
          GITHUB_RUN_ID: '123',
        };
        const resolved = spawnSync(
          'bash',
          ['-c', onFixtureEngine(resolver.run, common.FIXTURE_HEALTH)],
          {
            cwd,
            env: common,
            encoding: 'utf8',
            timeout: 10000,
          }
        );
        expect(resolved.status, resolved.stderr).toBe(0);
        const sha = readFileSync(output, 'utf8').match(/^sha=(.+)$/m)?.[1];
        expect(sha).toBe(event === 'repository_dispatch' ? pending : serving);
        const ready = spawnSync(
          'bash',
          ['-c', onFixtureEngine(admission.run, common.FIXTURE_HEALTH)],
          {
            cwd,
            env: { ...common, EXPECTED_ENGINE_SHA: sha },
            encoding: 'utf8',
            timeout: 10000,
          }
        );
        expect(ready.status, ready.stderr).toBe(event === 'repository_dispatch' ? 1 : 0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  );

  it('requires steps.engine_gate.outputs.current == "true" on both browser steps', () => {
    const chromium = engineSteps.find((s: any) => s.name === "Install Chromium and WebKit");
    const live = engineSteps.find((s: any) => s.id === "live");
    expect(chromium).toBeDefined();
    expect(chromium.if).toBe("steps.engine_gate.outputs.current == 'true'");
    expect(live).toBeDefined();
    expect(live.if).toBe("steps.engine_gate.outputs.current == 'true'");
  });

  it('gives current=false with exit 0 when a later protected-main release supersedes EXPECTED', () => {
    const cwd = mkdtempSync(join(tmpdir(), "ca-post-deploy-superseded-"));
    const env = {
      ...gitEnvironmentForCwd(),
      GIT_AUTHOR_NAME: "Scope fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Scope fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      mkdirSync(join(cwd, "server"), { recursive: true });
      writeFileSync(join(cwd, "server/runtime.ts"), "base engine");
      git("add", ".");
      git("commit", "-qm", "base engine");
      const baseSha = git("rev-parse", "HEAD");

      writeFileSync(join(cwd, "server/runtime.ts"), "newer main engine");
      git("add", ".");
      git("commit", "-qm", "newer main engine");
      const newerSha = git("rev-parse", "HEAD");

      git("update-ref", "refs/remotes/origin/main", newerSha);
      git("remote", "add", "origin", cwd);
      git("branch", "-M", "main");

      mkdirSync(join(cwd, "scripts/ci"), { recursive: true });
      copyFileSync(
        join(root, "scripts/ci/read-engine-release.mjs"),
        join(cwd, "scripts/ci/read-engine-release.mjs")
      );
      copyFileSync(
        join(root, "scripts/ci/await-engine-gameplay.mjs"),
        join(cwd, "scripts/ci/await-engine-gameplay.mjs")
      );
      copyFileSync(
        join(root, "scripts/ci/production-e2e-provenance.mjs"),
        join(cwd, "scripts/ci/production-e2e-provenance.mjs")
      );
      mkdirSync(join(cwd, "bin"));
      writeFileSync(join(cwd, "bin/curl"), '#!/bin/sh\nprintf "%s" "$FIXTURE_HEALTH"\n');
      chmodSync(join(cwd, "bin/curl"), 0o755);

      const output = join(cwd, "output");
      const summary = join(cwd, "summary");
      const common = {
        ...env,
        PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
        EXPECTED_ENGINE_SHA: baseSha,
        FIXTURE_HEALTH: JSON.stringify({ releaseSha: newerSha, running: true, liveness: "ok" }),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_RUN_ID: "123",
      };

      const ready = spawnSync(
        "bash",
        ["-c", onFixtureEngine(admission.run, common.FIXTURE_HEALTH)],
        {
          cwd,
          env: common,
          encoding: "utf8",
          timeout: 10000,
        }
      );
      expect(ready.status, ready.stderr).toBe(0);
      const outputContent = readFileSync(output, "utf8");
      expect(outputContent).toContain("current=false");
      const summaryContent = readFileSync(summary, "utf8");
      expect(summaryContent).toContain("NON-VERDICT");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('gives exit 1 when READY_SHA is a descendant not on origin/main', () => {
    const cwd = mkdtempSync(join(tmpdir(), "ca-post-deploy-notonmain-"));
    const env = {
      ...gitEnvironmentForCwd(),
      GIT_AUTHOR_NAME: "Scope fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Scope fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      mkdirSync(join(cwd, "server"), { recursive: true });
      writeFileSync(join(cwd, "server/runtime.ts"), "base engine");
      git("add", ".");
      git("commit", "-qm", "base engine");
      const baseSha = git("rev-parse", "HEAD");

      git("update-ref", "refs/remotes/origin/main", baseSha);
      git("remote", "add", "origin", cwd);
      git("branch", "-M", "main");

      // Now create a descendant commit on a side branch / unmerged commit (not on origin/main)
      writeFileSync(join(cwd, "server/runtime.ts"), "unmerged engine descendant");
      git("add", ".");
      git("commit", "-qm", "unmerged engine descendant");
      const descendantSha = git("rev-parse", "HEAD");

      mkdirSync(join(cwd, "scripts/ci"), { recursive: true });
      copyFileSync(
        join(root, "scripts/ci/read-engine-release.mjs"),
        join(cwd, "scripts/ci/read-engine-release.mjs")
      );
      copyFileSync(
        join(root, "scripts/ci/await-engine-gameplay.mjs"),
        join(cwd, "scripts/ci/await-engine-gameplay.mjs")
      );
      copyFileSync(
        join(root, "scripts/ci/production-e2e-provenance.mjs"),
        join(cwd, "scripts/ci/production-e2e-provenance.mjs")
      );
      mkdirSync(join(cwd, "bin"));
      writeFileSync(join(cwd, "bin/curl"), '#!/bin/sh\nprintf "%s" "$FIXTURE_HEALTH"\n');
      chmodSync(join(cwd, "bin/curl"), 0o755);

      const output = join(cwd, "output");
      const summary = join(cwd, "summary");
      const common = {
        ...env,
        PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
        EXPECTED_ENGINE_SHA: baseSha,
        FIXTURE_HEALTH: JSON.stringify({ releaseSha: descendantSha, running: true, liveness: "ok" }),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_RUN_ID: "123",
      };

      const ready = spawnSync(
        "bash",
        ["-c", onFixtureEngine(admission.run, common.FIXTURE_HEALTH)],
        {
          cwd,
          env: common,
          encoding: "utf8",
          timeout: 10000,
        }
      );
      expect(ready.status).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
