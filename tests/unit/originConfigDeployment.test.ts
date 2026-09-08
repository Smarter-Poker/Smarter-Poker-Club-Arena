import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
);

function deploy(validationExit = 0, dryRun = false) {
  const dir = mkdtempSync(join(tmpdir(), 'ca-origin-deploy-'));
  temporary.push(dir);
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  const executable = (name: string, body: string) =>
    writeFileSync(join(dir, name), '#!/usr/bin/env bash\n' + body, { mode: 0o755 });
  executable(
    'ssh',
    `
command="\${!#}"
echo "ssh: $command" >> "$DEPLOY_TEST_LOG"
case "$command" in
  cat*) echo '# previous live config';;
  mktemp*) echo '/etc/caddy/Caddyfile.staged.ABC12345';;
  'caddy validate'*) exit "$DEPLOY_TEST_VALIDATION_EXIT";;
esac
`
  );
  executable('scp', 'echo "scp: $*" >> "$DEPLOY_TEST_LOG"\n');
  executable(
    'curl',
    `
if [[ "$*" == *http_code* ]]; then
  echo 200
else
  echo '{"ca_sha":"abcdef123456"}'
fi
`
  );
  const result = spawnSync('bash', [resolve('infra/ca-origin/deploy-origin-config.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir + ':' + process.env.PATH,
      CA_ORIGIN_HOST: 'test-origin.invalid',
      CA_ORIGIN_SSH_KEY_PATH: join(dir, 'unused-test-key'),
      DEPLOY_TEST_LOG: log,
      DEPLOY_TEST_VALIDATION_EXIT: String(validationExit),
      DRY_RUN: dryRun ? '1' : '0',
    },
  });
  return { ...result, calls: readFileSync(log, 'utf8') };
}

describe('origin config deployment', () => {
  it('refuses an invalid candidate without replacing or restarting the live config', () => {
    const result = deploy(1);
    expect(result.status, result.stderr).toBe(2);
    expect(result.calls).toContain('root@test-origin.invalid:/etc/caddy/Caddyfile.staged.ABC12345');
    expect(result.calls).toContain(
      'caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.staged.ABC12345'
    );
    expect(result.calls).not.toContain('mv --');
    expect(result.calls).not.toContain('systemctl');
    expect(result.calls).toContain('rm -f -- /etc/caddy/Caddyfile.staged.ABC12345');
  });

  it('installs the exact validated candidate before reloading', () => {
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);
    const validated = result.calls.indexOf('caddy validate');
    const installed = result.calls.indexOf(
      'mv -- /etc/caddy/Caddyfile.staged.ABC12345 /etc/caddy/Caddyfile'
    );
    const reloaded = result.calls.indexOf('systemctl reload caddy');
    expect(validated).toBeGreaterThan(0);
    expect(installed).toBeGreaterThan(validated);
    expect(reloaded).toBeGreaterThan(installed);
  });

  it('keeps the dry run read-only', () => {
    const result = deploy(0, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain('cat /etc/caddy/Caddyfile');
    expect(result.calls).not.toMatch(/scp:|mktemp|mv --|systemctl/);
  });

  it('bounds healthy stale HTML while preserving outage fallback and immutable chunks', () => {
    const config = readFileSync(resolve('infra/ca-origin/Caddyfile'), 'utf8');
    const shell = config.split('\n').find((line) => line.includes('header @shell Cache-Control'))!;
    expect(shell).toContain(
      'max-age=0, s-maxage=60, stale-while-revalidate=60, stale-if-error=86400'
    );
    expect(config).toContain(
      'header @immutable Cache-Control "public, max-age=31536000, immutable"'
    );
    expect(config).toContain(
      'header /build-info.json Cache-Control "no-store, no-cache, must-revalidate"'
    );
  });
});
