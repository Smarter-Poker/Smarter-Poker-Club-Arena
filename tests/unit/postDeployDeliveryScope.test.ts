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
import { describe, expect, it } from 'vitest';
import { gitEnvironmentForCwd } from '../../scripts/ci/classify-ci-changes.mjs';

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
        const resolved = spawnSync('bash', ['-c', resolver.run], {
          cwd,
          env: common,
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(resolved.status, resolved.stderr).toBe(0);
        const sha = readFileSync(output, 'utf8').match(/^sha=(.+)$/m)?.[1];
        expect(sha).toBe(event === 'repository_dispatch' ? pending : serving);
        const ready = spawnSync('bash', ['-c', admission.run], {
          cwd,
          env: { ...common, EXPECTED_ENGINE_SHA: sha },
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(ready.status, ready.stderr).toBe(event === 'repository_dispatch' ? 1 : 0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  );
});
