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
const identityParserStart = transaction.indexOf('parse_health_instance_for_sha() {');
const identityParserEnd = transaction.indexOf('\nhealth_instance_for_sha() {', identityParserStart);
const identityParser = transaction.slice(identityParserStart, identityParserEnd);
const strictIdentityStart = transaction.indexOf('health_instance_for_sha() {');
const strictIdentityEnd = transaction.indexOf('\nsource_instance_for_sha() {', strictIdentityStart);
const strictIdentity = transaction.slice(strictIdentityStart, strictIdentityEnd);
const sourceIdentityStart = transaction.indexOf('source_instance_for_sha() {');
const sourceIdentityEnd = transaction.indexOf('\nhealth_instance() {', sourceIdentityStart);
const sourceIdentity = transaction.slice(sourceIdentityStart, sourceIdentityEnd);

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

const sourceSha = 'a'.repeat(40);
const validSourceIdentity = {
  running: true,
  releaseSha: sourceSha,
  liveness: 'ok',
  instanceId: '12345-deadbeef',
};

function runSourceIdentity({
  body = JSON.stringify(validSourceIdentity),
  httpCode = '503',
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
BREAK_END_EPOCH=0
curl() {
  printf '%s\\n%s' "$MOCK_BODY" "$MOCK_HTTP_CODE"
  return "$MOCK_CURL_EXIT"
}
${identityParser}
${sourceIdentity}
source_instance_for_sha 'https://engine.example.invalid/health' "$MOCK_EXPECTED_SHA"`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        MOCK_BODY: body,
        MOCK_HTTP_CODE: httpCode,
        MOCK_CURL_EXIT: String(curlExit),
        MOCK_EXPECTED_SHA: sourceSha,
      },
    }
  );
}

function runStrictIdentity(httpCode: string) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -u
BREAK_END_EPOCH=0
curl() {
  printf '%s\\n%s' "$MOCK_BODY" "$MOCK_HTTP_CODE"
}
${identityParser}
${strictIdentity}
health_instance_for_sha 'https://engine.example.invalid/health' "$MOCK_EXPECTED_SHA"`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        MOCK_BODY: JSON.stringify(validSourceIdentity),
        MOCK_HTTP_CODE: httpCode,
        MOCK_EXPECTED_SHA: sourceSha,
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
      transaction.indexOf('\nsource_instance_for_sha() {')
    );
    expect(strictHealth).toContain("--write-out $'\\n%{http_code}'");
    expect(strictHealth).toContain('[ "$http_code" = 200 ]');
  });
});

describe('the already-sealed source remains replaceable when routing readiness is degraded', () => {
  it.each(['200', '503'])('accepts exact live source identity carried by HTTP %s', (httpCode) => {
    const result = runSourceIdentity({ httpCode });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('12345-deadbeef');
  });

  it('fails closed on an incomplete transfer, another status, or false identity', () => {
    expect(runSourceIdentity({ curlExit: 7 }).status).not.toBe(0);
    expect(runSourceIdentity({ httpCode: '500' }).status).not.toBe(0);
    expect(runSourceIdentity({ httpCode: '503', body: 'not-json' }).status).not.toBe(0);
    expect(
      runSourceIdentity({
        httpCode: '503',
        body: JSON.stringify({ ...validSourceIdentity, releaseSha: 'b'.repeat(40) }),
      }).status
    ).not.toBe(0);
    expect(
      runSourceIdentity({
        httpCode: '503',
        body: JSON.stringify({ ...validSourceIdentity, liveness: 'dead' }),
      }).status
    ).not.toBe(0);
  });

  it('keeps the source exception separate from strict candidate health', () => {
    expect(sourceIdentity).toContain('case "$http_code" in\n    200|503)');
    expect(sourceIdentity).not.toMatch(/curl\s+-[^\n]*f/);
    const strictHealth = transaction.slice(
      transaction.indexOf('health_instance_for_sha() {'),
      transaction.indexOf('\nsource_instance_for_sha() {')
    );
    expect(strictHealth).toContain("--write-out $'\\n%{http_code}'");
    expect(strictHealth).toContain('[ "$http_code" = 200 ]');
    expect(strictHealth).not.toContain('200|503');
  });

  it('requires HTTP 200 for the strict candidate, pre-commit, and final helper', () => {
    const accepted = runStrictIdentity('200');
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout.trim()).toBe('12345-deadbeef');
    expect(runStrictIdentity('201').status).not.toBe(0);
    expect(runStrictIdentity('503').status).not.toBe(0);
  });
});
