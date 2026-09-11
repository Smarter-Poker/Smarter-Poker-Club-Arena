import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const VERIFIER = resolve(ROOT, 'server/scripts/verify-restart-certificate.sh');
const VERIFIER_SOURCE = readFileSync(VERIFIER, 'utf8');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8');

const completeCertificate = {
  running: true,
  maintenance: {
    active: true,
    phase: 'counting_down',
    durableConfirmed: true,
    readyForRestart: true,
    unparkedTables: 0,
    remainingMs: 296_000,
  },
};

describe('restart certificates survive degraded HTTP health', () => {
  let sandbox = '';
  let fakeBin = '';

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'restart-certificate-'));
    fakeBin = join(sandbox, 'curl');
    writeFileSync(
      fakeBin,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'OUTPUT=',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) OUTPUT="$2"; shift 2 ;;',
        '    --write-out) shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        '[ -n "$OUTPUT" ]',
        'printf \'%s\' "$FAKE_HEALTH_BODY" > "$OUTPUT"',
        'printf \'%s\' "$FAKE_HTTP_STATUS"',
        'exit "$FAKE_CURL_EXIT"',
        '',
      ].join('\n')
    );
    chmodSync(fakeBin, 0o755);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const verify = (httpStatus: string, body: unknown, curlExit = '0') =>
    spawnSync(VERIFIER, ['https://engine.invalid/health'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [sandbox, process.env.PATH ?? ''].join(':'),
        FAKE_HTTP_STATUS: httpStatus,
        FAKE_HEALTH_BODY: typeof body === 'string' ? body : JSON.stringify(body),
        FAKE_CURL_EXIT: curlExit,
      },
    });

  it('captures the body without curl fail-mode and admits only HTTP 200 or 503', () => {
    const executable = VERIFIER_SOURCE.split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(executable).toContain('--output "$BODY_FILE"');
    expect(executable).toContain("--write-out '%{http_code}'");
    expect(executable).toMatch(/case "\$HTTP_STATUS" in[\s\S]*200\|503/);
    expect(executable).not.toMatch(/curl[^\n]*(?:--fail(?:-with-body)?|\s-f(?:\s|$))/);
  });

  it.each(['200', '503'])('accepts a complete certificate carried by HTTP %s', (status) => {
    const result = verify(status, completeCertificate);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('READY\n');
  });

  it.each([
    ['running', { running: false }],
    ['active', { maintenance: { active: false } }],
    ['counting-down phase', { maintenance: { phase: 'idle' } }],
    ['durability', { maintenance: { durableConfirmed: false } }],
    ['restart readiness', { maintenance: { readyForRestart: false } }],
    ['zero unparked tables', { maintenance: { unparkedTables: 1 } }],
    ['three-minute remainder', { maintenance: { remainingMs: 179_999 } }],
  ])('rejects HTTP 503 when the %s predicate is absent', (_name, override) => {
    const certificate = structuredClone(completeCertificate);
    if ('maintenance' in override) {
      Object.assign(certificate.maintenance, override.maintenance);
    } else {
      Object.assign(certificate, override);
    }
    const result = verify('503', certificate);
    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('READY');
  });

  it('rejects HTTP 503 with no certificate or invalid JSON', () => {
    const missing = verify('503', { running: true });
    expect(missing.status).toBe(75);
    const invalid = verify('503', '{not-json');
    expect(invalid.status).toBe(65);
  });

  it('fails closed on network errors and unexpected HTTP statuses', () => {
    const network = verify('000', completeCertificate, '7');
    expect(network.status).toBe(69);
    const unexpected = verify('500', completeCertificate);
    expect(unexpected.status).toBe(69);
    expect(network.stdout).not.toContain('READY');
    expect(unexpected.stdout).not.toContain('READY');
  });

  it('guards both the public poll and locked localhost recheck with the same verifier', () => {
    const gate = WORKFLOW.slice(
      WORKFLOW.indexOf('name: Wait for the maintenance break to park every table'),
      WORKFLOW.indexOf('name: Prepare one-use sealed cutover authority')
    );
    const cutover = WORKFLOW.slice(
      WORKFLOW.indexOf('name: Cut over to the new image'),
      WORKFLOW.indexOf("echo '$MUTATION_MARKER'")
    );

    expect(gate).toContain('"$ENGINE_RESTART_CERTIFICATE_SCRIPT" "$ENGINE_URL/health"');
    expect(cutover).toContain('server/scripts/verify-restart-certificate.sh');
    expect(cutover).toContain('http://127.0.0.1:8080/health');
    expect(gate).not.toMatch(/curl\s+-sf[^\n]*\/health/);
    expect(cutover).not.toMatch(/curl\s+-sf[^\n]*\/health/);
    expect(WORKFLOW).toMatch(
      /server\/scripts\/verify-restart-certificate\.sh \\\n\s+server\/scripts\/verify-recovery-stack\.sh/
    );
  });
});
