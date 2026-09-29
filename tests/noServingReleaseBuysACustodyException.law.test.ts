/**
 * LAW: no serving release buys a custody exception from the restart
 *      certificate.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `maintenance_certificate()` in server/scripts/engine-release-transaction.sh
 * is the only thing that lets a cutover proceed past a shut
 * `readyForRestart`. Its allow-list holds exactly the two F06 preparation
 * reasons, which hold no money, and admits them only under the database proof
 * that no hand is in the air. The binding rule is that NO bank or custody
 * reason may ever enter it.
 *
 * On 2026-09-25 (#5266) the certificate gained a one-shot exception: when the
 * serving release was exactly 778075b4 - a build with no bound on
 * `stopped_bank_custody_unconfirmed` - that raw custody reason was admitted.
 * It fired once and got production off 778075b4. It was also a trap: a
 * rollback to 778075b4 would have re-armed a custody reason in the release
 * allow-list, and the next wedged predecessor would have been "fixed" by
 * adding its SHA to the set. Removed 2026-09-26.
 *
 * WHAT THIS PINS
 * 1. The certificate never reads who is serving (`releaseSha`) and holds no
 *    40-hex SHA literal. A SHA-shaped exception needs one or the other.
 * 2. Its allow-list is exactly the two F06 preparation reasons, and every
 *    bank or custody reason the engine can report refuses, from every
 *    serving identity, even with the database proof answering "no hand".
 * 3. NEGATIVE PROOF: the detector in (1) and the behaviour in (2) both fail
 *    on a copy of the certificate with the 778075b4 exception re-inserted,
 *    so this law cannot pass vacuously.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const TRANSACTION = readFileSync(
  join(ROOT, 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);
const BREAK = readFileSync(join(ROOT, 'server/src/maintenance/MaintenanceBreak.ts'), 'utf8');

const CERTIFICATE = TRANSACTION.slice(
  TRANSACTION.indexOf('maintenance_certificate() {'),
  TRANSACTION.indexOf("\n# Entry to the exact predecessor's checkpoint")
);

const RETIRED = '778075b419d078c58565c284c0ca7c5225bb773a';

/** Every bank or custody reason the engine can put in unparkedReasons. */
const CUSTODY_REASONS = [
  ...new Set([
    ...[...BREAK.matchAll(/['"`]((?:stopped_bank|bank)_[a-z_]*[a-z])['"`]/g)].map((m) => m[1]),
    // Raised by the table engine rather than named in MaintenanceBreak.ts.
    'bank_park_write_incomplete',
  ]),
].sort();

/** The code lines of the certificate: shell and embedded python, comments dropped. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** The static detector. Returns every way the source reads or names a serving release. */
function servingIdentityFindings(source: string): string[] {
  const findings: string[] = [];
  for (const line of codeLines(source)) {
    if (/releaseSha/.test(line)) findings.push(`reads releaseSha: ${line}`);
    if (/\b[0-9a-f]{40}\b/.test(line)) findings.push(`holds a SHA literal: ${line}`);
  }
  return findings;
}

function inflightHelper(rc: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'inflight-'));
  const path = join(dir, 'engine-release-inflight-hands.py');
  writeFileSync(
    path,
    `#!/bin/sh\necho '[engine-release-inflight-hands] answer ${rc}'\nexit ${rc}\n`
  );
  chmodSync(path, 0o755);
  return path;
}

function run(certificateSource: string, reasons: Record<string, number>, releaseSha: unknown) {
  const unparked = Object.values(reasons).reduce((a, b) => a + b, 0);
  const body = JSON.stringify({
    running: true,
    ...(releaseSha === undefined ? {} : { releaseSha }),
    handsInFlightTotal: 0,
    maintenance: {
      active: true,
      phase: 'counting_down',
      durableConfirmed: true,
      readyForRestart: false,
      unparkedTables: unparked,
      unparkedReasons: reasons,
      remainingMs: 296_000,
    },
  });
  return spawnSync(
    'bash',
    [
      '-c',
      `set -u
MIN_BREAK_REMAINING_MS=285000
ENV_FILE=/dev/null
INFLIGHT_HANDS="$MOCK_INFLIGHT"
curl() { printf '%s\\n%s' "$PROBE_BODY" "200"; }
${certificateSource}
maintenance_certificate`,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PROBE_BODY: body, MOCK_INFLIGHT: inflightHelper(0) },
    }
  );
}

/** The #5266 exception, re-inserted into a copy of today's certificate. */
function withRetiredException(source: string): string {
  const anchor = 'BOUNDED_ONLY={"f06_preparation_unresolved","f06_preparation_stuck"}\n';
  const guard = '    if k not in BOUNDED_ONLY: raise SystemExit(1)\n';
  expect(source).toContain(anchor);
  expect(source).toContain(guard);
  return source
    .replace(
      anchor,
      anchor +
        `STOPPED_BANK_UNBOUNDED_PREDECESSORS={"${RETIRED}"}\n` +
        'RAW_STOPPED_BANK="stopped_bank_custody_unconfirmed"\n' +
        'serving=d.get("releaseSha")\n' +
        'predecessor=isinstance(serving,str) and serving in STOPPED_BANK_UNBOUNDED_PREDECESSORS\n'
    )
    .replace(
      guard,
      '    if k not in BOUNDED_ONLY and not (k==RAW_STOPPED_BANK and predecessor): raise SystemExit(1)\n'
    );
}

const SERVING = [RETIRED, 'b'.repeat(40), RETIRED.slice(0, 8), undefined, null];

describe('1. the certificate never asks who is serving', () => {
  it('found the certificate', () => {
    expect(CERTIFICATE).toContain('maintenance_certificate() {');
    expect(CERTIFICATE).toContain('BOUNDED_ONLY=');
  });

  it('reads no releaseSha and holds no SHA literal', () => {
    expect(servingIdentityFindings(CERTIFICATE)).toEqual([]);
  });

  it('admits exactly the two F06 preparation reasons', () => {
    const literal = CERTIFICATE.match(/^BOUNDED_ONLY=\{(.*)\}$/m);
    expect(literal).toBeTruthy();
    const admitted = [...literal![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(admitted).toEqual(['f06_preparation_stuck', 'f06_preparation_unresolved']);
    expect(CERTIFICATE).toContain('    if k not in BOUNDED_ONLY: raise SystemExit(1)\n');
  });
});

describe('2. every bank or custody reason refuses, whoever is serving', () => {
  it('derived the custody reasons from the engine', () => {
    expect(CUSTODY_REASONS).toEqual(
      expect.arrayContaining([
        'stopped_bank_custody_unconfirmed',
        'stopped_bank_custody_stuck',
        'bank_park_write_incomplete',
      ])
    );
  });

  it('refuses each one alone and beside a preparation reason, with the database proof saying no hand', () => {
    for (const reason of CUSTODY_REASONS) {
      for (const releaseSha of SERVING) {
        for (const reasons of [{ [reason]: 1 }, { f06_preparation_stuck: 13, [reason]: 1 }]) {
          const result = run(CERTIFICATE, reasons, releaseSha);
          expect(
            result.status,
            `${reason} serving ${String(releaseSha)}: ${result.stderr}`
          ).not.toBe(0);
          expect(result.stderr).not.toContain('the database confirms');
        }
      }
    }
  });

  it('still admits the preparation reasons alone, so the refusals above are not a broken harness', () => {
    const result = run(CERTIFICATE, { f06_preparation_stuck: 13 }, RETIRED);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('296000\n');
  });
});

describe('3. negative proof: the retired exception, re-inserted, is caught both ways', () => {
  const mutated = withRetiredException(CERTIFICATE);

  it('the static detector names it', () => {
    const findings = servingIdentityFindings(mutated);
    expect(findings.some((f) => f.startsWith('reads releaseSha'))).toBe(true);
    expect(findings.some((f) => f.startsWith('holds a SHA literal'))).toBe(true);
  });

  it('the behaviour check sees it admit a custody reason', () => {
    const result = run(mutated, { stopped_bank_custody_unconfirmed: 154 }, RETIRED);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('the database confirms');
  });
});
