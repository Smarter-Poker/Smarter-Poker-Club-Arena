import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
const workflow = (name: string) =>
  parse(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const ci = workflow('ci.yml');

describe('Hetzner CI uses qualified tools with bounded test workers', () => {
  it('routes accounting separately and never installs host packages on estate runners', () => {
    const job = ci.jobs.accounting_postgres;
    expect(job['runs-on']).toBe("${{ vars.ACCOUNTING_RUNNER || 'ubuntu-latest' }}");
    const install = job.steps.find((s: { name: string }) =>
      s.name.startsWith('Install PostgreSQL')
    );
    expect(install.if).toBe("runner.environment == 'github-hosted'");
    const verify = job.steps.find(
      (s: { name: string }) => s.name === 'Require the installed PostgreSQL 17 toolchain'
    );
    expect(verify.if).toBeUndefined();
    expect(verify.run).toBe('bash scripts/ci/verify-postgres17-tools.sh');
    expect(job.steps.indexOf(verify)).toBeLessThan(
      job.steps.findIndex((s: { name: string }) => s.name === 'Install server test dependencies')
    );
  });

  it('only the inert proposal signal moves to the PR runner pool', () => {
    const proposal = workflow('agent-branch-proposal.yml');
    expect(proposal.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(proposal.jobs)).toEqual(['signal']);
    expect(proposal.jobs.signal['runs-on']).toBe("${{ vars.CI_RUNNER || 'ubuntu-latest' }}");
    expect(proposal.jobs.signal.steps).toEqual([
      {
        name: 'Record the proposal signal',
        run: 'echo "Branch proposal signal accepted for $GITHUB_REF_NAME at $GITHUB_SHA."',
      },
    ]);
    expect(workflow('agent-open-pr.yml').jobs['open-pr']['runs-on']).toBe('ubuntu-latest');
  });

  for (const fault of ['none', 'missing', 'old-version', 'invalid-version', 'not-executable']) {
    it(`executes the read-only PostgreSQL prerequisite for ${fault}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ca-pg-tools-'));
      try {
        const tools = join(dir, 'bin');
        mkdirSync(tools);
        for (const name of ['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_config']) {
          if (name === 'psql' && fault === 'missing') continue;
          const version =
            fault === 'old-version' ? '16.9' : fault === 'invalid-version' ? '17x11' : '17.11';
          const label =
            name === 'pg_config' ? `PostgreSQL ${version}` : `${name} (PostgreSQL) ${version}`;
          writeFileSync(
            join(tools, name),
            `#!/bin/sh\ntest "$1" = --version || exit 2\nprintf '%s\\n' '${label}'\n`,
            { mode: fault === 'not-executable' && name === 'psql' ? 0o600 : 0o700 }
          );
        }
        const marker = join(dir, 'attempted-mutation');
        for (const name of ['sudo', 'apt-get', 'systemctl']) {
          writeFileSync(join(tools, name), '#!/bin/sh\n: > "$MUTATION_MARKER"\nexit 99\n', {
            mode: 0o700,
          });
        }
        const run = spawnSync(
          'bash',
          [join(root, 'scripts/ci/verify-postgres17-tools.sh'), tools],
          {
            encoding: 'utf8',
            timeout: 3000,
            env: { PATH: tools + ':' + process.env.PATH, MUTATION_MARKER: marker },
          }
        );
        expect(run.error).toBeUndefined();
        expect(run.status, run.stderr).toBe(fault === 'none' ? 0 : 1);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('the workflow budget actually limits concurrent Vitest child work', () => {
    expect(ci.env.VITEST_MAX_WORKERS).toBe('2');
    const dir = mkdtempSync(join(root, 'work/ci-workers-native-'));
    try {
      const log = join(dir, 'workers.jsonl');
      const config = join(dir, 'vitest.config.mjs');
      writeFileSync(
        config,
        `export default { test: { root: ${JSON.stringify(dir)}, include: ['case-*.test.mjs'], environment: 'node', pool: 'forks', fileParallelism: true } };\n`
      );
      const vitest = pathToFileURL(join(root, 'node_modules/vitest/dist/index.js')).href;
      for (let i = 0; i < 6; i++) {
        writeFileSync(
          join(dir, `case-${i}.test.mjs`),
          `import { test } from ${JSON.stringify(vitest)};\nimport { appendFileSync } from 'node:fs';\ntest('bounded ${i}', async () => {\n appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:'start', id:${i}})+'\\n');\n await new Promise(r => setTimeout(r, 150));\n appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:'end', id:${i}})+'\\n');\n});\n`
        );
      }
      const run = spawnSync(
        process.execPath,
        [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, CI: 'true', VITEST_MAX_WORKERS: ci.env.VITEST_MAX_WORKERS },
        }
      );
      expect(run.error).toBeUndefined();
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const events = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(12);
      const active = new Set<number>();
      let peak = 0;
      for (const event of events) {
        if (event.kind === 'start') {
          active.add(event.id);
          peak = Math.max(peak, active.size);
        } else {
          expect(active.delete(event.id)).toBe(true);
        }
      }
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(2);
      expect(active.size).toBe(0);
      expect(new Set(events.filter((e) => e.kind === 'end').map((e) => e.id)).size).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
