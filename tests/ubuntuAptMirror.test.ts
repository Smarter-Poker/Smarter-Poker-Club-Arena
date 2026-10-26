import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Ubuntu browser dependency mirror', () => {
  it('selects the primary mirror before both browser and native package installs', () => {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const native = workflow.jobs.accounting_postgres.steps.find(
      (step: { name?: string }) =>
        step.name === 'Install PostgreSQL 17 tools without a default database service'
    ).run;
    const selection = 'sudo python3 scripts/ci/ubuntu-apt-mirror.py';
    expect(native).toContain(selection);
    expect(native.indexOf(selection)).toBeLessThan(
      native.indexOf('cp /etc/apt/sources.list.d/ubuntu.sources')
    );
    const browsers = workflow.jobs['css-beats-e2e'].steps;
    const selected = browsers.findIndex((step: { run?: string }) => step.run === selection);
    const install = browsers.findIndex(
      (step: { run?: string }) => step.run === 'npx playwright install chromium webkit --with-deps'
    );
    expect(selected).toBeGreaterThanOrEqual(0);
    expect(selected).toBeLessThan(install);
  });

  // EVERY BROWSER SYSTEM-PACKAGE INSTALL, NOT THE TWO THAT HIT IT FIRST
  // (2026-10-26). The mirror selection reached ci.yml's CSS beats and
  // accounting jobs on 2026-10-22, and nowhere else. Post-deploy E2E kept the
  // Azure mirror: on 2026-10-26 its browser install fetched 97 MB at 27 kB/s
  // for 59 minutes, and the client certificate hit its 80-minute cap before
  // the sweep. Any step that lets Playwright pull Ubuntu packages selects the
  // primary mirror first, in that step or an earlier one of the same job.
  it('selects the primary mirror before every Playwright system-package install in every workflow', () => {
    const selection = 'sudo python3 scripts/ci/ubuntu-apt-mirror.py';
    const installsPackages = /npx playwright (?:install-deps\b|install\b[^\n]*--with-deps)/;
    const missing: string[] = [];
    let installs = 0;
    for (const file of readdirSync('.github/workflows').filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8'));
      for (const [jobId, job] of Object.entries(
        (workflow?.jobs ?? {}) as Record<string, { steps?: { name?: string; run?: string }[] }>
      )) {
        let selected = false;
        for (const step of job.steps ?? []) {
          const run = typeof step.run === 'string' ? step.run : '';
          const install = run.search(installsPackages);
          if (install >= 0) {
            installs += 1;
            const before = run.slice(0, install).includes(selection);
            if (!selected && !before) missing.push(`${file} ${jobId}: ${step.name ?? run.trim()}`);
          }
          if (run.includes(selection)) selected = true;
        }
      }
    }
    expect(installs).toBeGreaterThanOrEqual(11);
    expect(missing).toEqual([]);
  });

  it('bounds client browser installation before any production identity can be created', () => {
    const workflow = parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
    const job = workflow.jobs['production-e2e'];
    const installIndex = job.steps.findIndex(
      (step: { name?: string }) => step.name === 'Install Chromium and WebKit'
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    const install = job.steps[installIndex];
    // Successful job121591382452 installed in49s; job121619175020 took
    // 49m32s, then created a fixture before hitting its80m job ceiling.
    // Ten minutes allows >12x the successful install without spending the
    // suite's proof and cleanup budget on dependency setup.
    expect(install['timeout-minutes']).toBeGreaterThan(0);
    expect(install['timeout-minutes']).toBeLessThanOrEqual(10);
    expect(install['continue-on-error']).not.toBe(true);
    expect(job['timeout-minutes']).toBe(80);
    const liveIndex = job.steps.findIndex((step: { id?: string }) => step.id === 'live');
    expect(liveIndex).toBeGreaterThan(installIndex);
    expect(job.steps[liveIndex].if).toBeUndefined();
    const creates = job.steps.filter((step: { run?: string }) =>
      /production-e2e-account\.mjs create/.test(step.run ?? '')
    );
    expect(creates.length).toBeGreaterThanOrEqual(2);
    for (const step of creates) {
      expect(job.steps.indexOf(step)).toBeGreaterThan(liveIndex);
      expect(step.if).toContain("steps.live.outputs.ready == 'true'");
    }
  });

  it('changes only active Azure Ubuntu URIs, preserves trust and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ca-apt-mirror-'));
    try {
      mkdirSync(join(root, 'sources.list.d'));
      const legacy = join(root, 'sources.list');
      const modern = join(root, 'sources.list.d', 'ubuntu.sources');
      const unrelated = join(root, 'sources.list.d', 'other.list');
      writeFileSync(
        legacy,
        '# http://azure.archive.ubuntu.com/ubuntu\ndeb [signed-by=/key] http://azure.archive.ubuntu.com/ubuntu/ noble main\n'
      );
      writeFileSync(
        modern,
        'Types: deb\nURIs: https://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
      );
      const other =
        'deb https://example.com/ubuntu noble main\ndeb https://azure.archive.ubuntu.com/ubuntu-extra noble main\n';
      writeFileSync(unrelated, other);
      const run = () =>
        execFileSync('python3', ['scripts/ci/ubuntu-apt-mirror.py', '--root', root], {
          encoding: 'utf8',
        });
      expect(run()).toContain('updated 2 source files');
      expect(readFileSync(legacy, 'utf8')).toBe(
        '# http://azure.archive.ubuntu.com/ubuntu\ndeb [signed-by=/key] https://archive.ubuntu.com/ubuntu/ noble main\n'
      );
      expect(readFileSync(modern, 'utf8')).toBe(
        'Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
      );
      expect(readFileSync(unrelated, 'utf8')).toBe(other);
      expect(run()).toContain('updated 0 source files');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites referenced hosted mirrorlists while preserving weights, comments and trust', () => {
    const root = mkdtempSync(join(tmpdir(), 'ca-apt-mirror-'));
    try {
      mkdirSync(join(root, 'sources.list.d'));
      const source = join(root, 'sources.list.d', 'ubuntu.sources');
      const definition =
        'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\nComponents: main\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n# mirror+file:/etc/apt/unused.txt\n';
      writeFileSync(source, definition);
      const mirror = join(root, 'apt-mirrors.txt');
      writeFileSync(
        mirror,
        'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n# http://azure.archive.ubuntu.com/ubuntu\nhttps://example.com/ubuntu\tpriority:3 # http://azure.archive.ubuntu.com/ubuntu\n'
      );
      const unused = 'http://azure.archive.ubuntu.com/ubuntu\n';
      writeFileSync(join(root, 'unused.txt'), unused);
      const run = () =>
        execFileSync('python3', ['scripts/ci/ubuntu-apt-mirror.py', '--root', root], {
          encoding: 'utf8',
        });
      expect(run()).toContain('updated 1 source files');
      expect(readFileSync(source, 'utf8')).toBe(definition);
      expect(readFileSync(mirror, 'utf8')).toBe(
        'https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n# http://azure.archive.ubuntu.com/ubuntu\nhttps://example.com/ubuntu\tpriority:3 # http://azure.archive.ubuntu.com/ubuntu\n'
      );
      expect(readFileSync(join(root, 'unused.txt'), 'utf8')).toBe(unused);
      expect(run()).toContain('updated 0 source files');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing source directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ca-apt-mirror-'));
    try {
      expect(() =>
        execFileSync('python3', ['scripts/ci/ubuntu-apt-mirror.py', '--root', root], {
          stdio: 'pipe',
        })
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
