import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const transaction = readFileSync(
  resolve(process.cwd(), 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);
const helperStart = transaction.indexOf('maintenance_certificate() {');
const helperEnd = transaction.indexOf('\npersist_break_deadline() {', helperStart);
const helper = transaction.slice(helperStart, helperEnd);

const validCertificate = {
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

function runCertificate({
  body = JSON.stringify(validCertificate),
  httpCode = '200',
  curlExit = 0,
}: {
  body?: string;
  httpCode?: string;
  curlExit?: number;
} = {}) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -u
MIN_BREAK_REMAINING_MS=285000
curl() {
  printf '%s\\n%s' "$MOCK_BODY" "$MOCK_HTTP_CODE"
  return "$MOCK_CURL_EXIT"
}
${helper}
maintenance_certificate`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        MOCK_BODY: body,
        MOCK_HTTP_CODE: httpCode,
        MOCK_CURL_EXIT: String(curlExit),
      },
    }
  );
}

describe('the release transaction can read only an explicit maintenance health response', () => {
  it.each(['200', '503'])(
    'accepts a complete restart certificate carried by HTTP %s',
    (httpCode) => {
      const result = runCertificate({ httpCode });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('296000');
    }
  );

  it('fails closed on transport failure, unexpected status, invalid JSON, or a false predicate', () => {
    expect(runCertificate({ curlExit: 7 }).status).not.toBe(0);
    expect(runCertificate({ httpCode: '500' }).status).not.toBe(0);
    expect(runCertificate({ httpCode: '503', body: 'not-json' }).status).not.toBe(0);
    expect(
      runCertificate({
        httpCode: '503',
        body: JSON.stringify({
          ...validCertificate,
          maintenance: { ...validCertificate.maintenance, readyForRestart: false },
        }),
      }).status
    ).not.toBe(0);
  });

  it('retains the distinct insufficient-proof result without touching strict post-cutover health', () => {
    const result = runCertificate({
      httpCode: '503',
      body: JSON.stringify({
        ...validCertificate,
        maintenance: { ...validCertificate.maintenance, remainingMs: 284_999 },
      }),
    });
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe('284999');

    expect(helper).toContain('case "$http_code" in\n    200|503)');
    expect(helper).not.toMatch(/curl\s+-[^\n]*f/);
    const strictHealth = transaction.slice(
      transaction.indexOf('health_instance_for_sha() {'),
      transaction.indexOf('\nhealth_instance() {')
    );
    expect(strictHealth).toContain('curl -fsS');
  });
});
