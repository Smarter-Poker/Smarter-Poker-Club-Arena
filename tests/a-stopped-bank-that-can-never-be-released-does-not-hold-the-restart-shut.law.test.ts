/**
 * LAW: a stopped bank that can never be released does not hold the restart
 *      certificate shut.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED (2026-09-25, from 15:59 UTC)
 * ------------------------------------------
 * Serving engine 778075b4 had 20 tournament managers quarantined after lease
 * loss. Their STOPPED (terminal) tournament engines answered
 * `hasUnretiredStoppedTimeBankCustody()` true for ever - the root cause is
 * fixed engine-side in #5254 (bc8727bc), which that process was not running -
 * and `MaintenanceBreak.unparkedTables()` counted that reason with no bound.
 * `/health.maintenance` at every break:
 *
 *   readyForRestart false, unparkedTables 154,
 *   unparkedReasons { f06_preparation_stuck: 13, stopped_bank_custody_unconfirmed: 154 }
 *
 * `maintenance_certificate()` admits a cutover past a shut certificate only
 * when EVERY unparked reason is on its allow-list and the database proves no
 * hand is in the air. The raw stopped-bank reason was not on the list, so the
 * release carrying the fix could never be admitted: every
 * `auto-deploy-hetzner` run since 15:59 UTC waited for a certificate that
 * could not open. The same file's own comment already names this as the worse
 * bug: "a stuck table never recovers ... including the restart that carried
 * the fix".
 *
 * `stopped_bank_custody_unconfirmed` is by construction raised only by a
 * TERMINAL tournament engine (first clause of
 * `ServerTableEngineBase.hasUnretiredStoppedTimeBankCustody`), which deals no
 * hands. What a restart discards is the in-memory time-bank mirror of seats
 * that already stopped; the chips live in the database. That is the class the
 * legacy checkpoint guard already classifies as DISPOSED.
 *
 * WHAT THIS PINS
 * --------------
 * 1. CORRECTED 2026-09-26 (#5267). The engine bounds the class, but past the
 *    bound it reports `stopped_bank_custody_stuck` and STILL refuses, and the
 *    release REFUSES that name too: on a build with #5255 what outlives the
 *    bound is a bank genuinely not on disk, and nothing behind this script
 *    re-checks it on an ordinary cutover. No bank or custody name is in
 *    BOUNDED_ONLY. Engine-side cases: server/src/maintenance/
 *    aStoppedBankPastItsBoundIsNamedAndStillRefuses.law.test.ts.
 * 2. RETIRED 2026-09-26. The RAW reason was admitted from exactly one serving
 *    release, the unbounded predecessor 778075b4, as a one-shot way off that
 *    build. It fired, production moved on, and a rollback to 778075b4 would
 *    have re-armed a custody reason in the allow-list. It is removed: the raw
 *    reason now refuses from EVERY serving release, 778075b4 included, and
 *    tests/noServingReleaseBuysACustodyException.law.test.ts pins that no
 *    SHA-specific exception can come back.
 * 3. `cards_in_air`, the refusing bank classes and unknown reasons still
 *    refuse, from every serving release, predecessor included.
 * 4. Every other refusal is exactly as it was: the database proof is still
 *    the only thing that proceeds, and nothing bypasses it.
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

const PREDECESSOR = '778075b419d078c58565c284c0ca7c5225bb773a';
const BOUNDED_RELEASE = 'b'.repeat(40);

const certificateHelper = TRANSACTION.slice(
  TRANSACTION.indexOf('maintenance_certificate() {'),
  TRANSACTION.indexOf("\n# Entry to the exact predecessor's checkpoint")
);

/** A stand-in for engine-release-inflight-hands.py that answers one code. */
function inflightHelper(rc: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'inflight-'));
  const path = join(dir, 'engine-release-inflight-hands.py');
  // The real helper announces its answer on stdout; the stand-in does too, so
  // a certificate that leaks it into the captured figure fails here.
  writeFileSync(
    path,
    `#!/bin/sh\necho '[engine-release-inflight-hands] answer ${rc}'\nexit ${rc}\n`
  );
  chmodSync(path, 0o755);
  return path;
}

/** Drive the REAL maintenance_certificate with a stubbed /health body. */
function certificate({
  reasons,
  releaseSha = BOUNDED_RELEASE,
  hands = 0,
  inflightRc = 0,
  remainingMs = 296_000,
}: {
  reasons: Record<string, unknown>;
  releaseSha?: unknown;
  /** `absent` leaves the field out of the body entirely. */
  hands?: number | string | 'absent';
  inflightRc?: number;
  remainingMs?: number;
}) {
  const unparked = Object.values(reasons).reduce<number>(
    (sum, n) => sum + (typeof n === 'number' ? n : 1),
    0
  );
  const body = JSON.stringify({
    running: true,
    ...(releaseSha === undefined ? {} : { releaseSha }),
    ...(hands === 'absent' ? {} : { handsInFlightTotal: hands }),
    maintenance: {
      active: true,
      phase: 'counting_down',
      durableConfirmed: true,
      readyForRestart: false,
      unparkedTables: unparked,
      unparkedReasons: reasons,
      remainingMs,
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
${certificateHelper}
maintenance_certificate`,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PROBE_BODY: body, MOCK_INFLIGHT: inflightHelper(inflightRc) },
    }
  );
}

describe('1. the stuck stopped-bank class is refused, from every serving release', () => {
  it('refuses stopped_bank_custody_stuck even with the database proof', () => {
    for (const releaseSha of [BOUNDED_RELEASE, PREDECESSOR]) {
      const result = certificate({ reasons: { stopped_bank_custody_stuck: 154 }, releaseSha });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).not.toContain('the database confirms');
    }
  });

  it('refuses it mixed with both preparation reasons, the shape production showed', () => {
    for (const reasons of [
      { f06_preparation_stuck: 13, stopped_bank_custody_stuck: 154 },
      { f06_preparation_unresolved: 1, stopped_bank_custody_stuck: 1 },
    ]) {
      const result = certificate({ reasons });
      expect(result.status, JSON.stringify(reasons)).not.toBe(0);
      expect(result.stderr).not.toContain('the database confirms');
    }
  });

  it('still admits the preparation reasons alone under the database proof', () => {
    const result = certificate({ reasons: { f06_preparation_stuck: 13 } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('296000\n');
    expect(result.stderr).toContain('the database confirms no hand is in the air');
  });
});

describe('2. the raw reason refuses from every serving release, the retired predecessor included', () => {
  it.each([BOUNDED_RELEASE, PREDECESSOR, PREDECESSOR.slice(0, 8), undefined, null, 42])(
    'refuses stopped_bank_custody_unconfirmed while %j is serving',
    (releaseSha) => {
      for (const reasons of [
        { stopped_bank_custody_unconfirmed: 154 },
        { f06_preparation_stuck: 13, stopped_bank_custody_unconfirmed: 195 },
      ]) {
        const result = certificate({ reasons, releaseSha });
        expect(result.status, JSON.stringify({ releaseSha, reasons })).not.toBe(0);
        expect(result.stderr).not.toContain('the database confirms');
        expect(result.stderr).not.toContain('can never release');
      }
    }
  );

  it('the exception is gone from the source, not merely unreachable', () => {
    expect(TRANSACTION).not.toContain('STOPPED_BANK_UNBOUNDED_PREDECESSORS');
    expect(TRANSACTION).not.toContain('RAW_STOPPED_BANK');
    expect(TRANSACTION).not.toContain('serving=d.get("releaseSha")');
    expect(TRANSACTION).toContain('    if k not in BOUNDED_ONLY: raise SystemExit(1)\n');
  });
});

describe('3. everything that refused still refuses', () => {
  it.each([
    { cards_in_air: 1 },
    { stopped_bank_custody_stuck: 154, cards_in_air: 1 },
    { stopped_bank_custody_unwritten: 1 },
    { stopped_bank_custody_unreadable: 1 },
    { bank_park_write_incomplete: 1 },
    { accounting_unconfirmed: 1 },
    { accounting_pending: 1 },
    { unknown: 1 },
    { a_reason_a_future_engine_invents: 1 },
    { stopped_bank_custody_stuck: 'many' },
    { stopped_bank_custody_stuck: true },
    { stopped_bank_custody_stuck: -1 },
  ])('refuses %j from a bounded release', (reasons) => {
    const result = certificate({ reasons });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('the database confirms');
  });

  it.each([
    { cards_in_air: 1 },
    { stopped_bank_custody_unconfirmed: 154, cards_in_air: 1 },
    { stopped_bank_custody_unconfirmed: 154, stopped_bank_custody_unwritten: 1 },
    { stopped_bank_custody_unconfirmed: 154, bank_park_write_incomplete: 1 },
    { stopped_bank_custody_unconfirmed: 154, unknown: 1 },
    { stopped_bank_custody_unconfirmed: 'many' },
  ])('refuses %j from the predecessor too', (reasons) => {
    const result = certificate({ reasons, releaseSha: PREDECESSOR });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('the database confirms');
  });

  it('a short window is still a missed opportunity, whoever is serving', () => {
    for (const releaseSha of [BOUNDED_RELEASE, PREDECESSOR]) {
      const result = certificate({
        reasons: { stopped_bank_custody_unconfirmed: 154 },
        releaseSha,
        remainingMs: 284_999,
      });
      expect(result.status).toBe(2);
      expect(result.stdout.trim()).toBe('284999');
    }
  });
});

describe('5. stdout is the verdict and nothing else', () => {
  // Run 36211686180 (2026-09-26 02:34:11Z): the first admission through the
  // database branch captured the helper's announcement as the figure and the
  // transaction died on `$(( ... / 1000 ))` before prepare.
  it('an admitted certificate prints only the remaining milliseconds, which the caller can do arithmetic on', () => {
    // (#5267 and the retired predecessor exception: the admitted shapes are
    // the preparation reasons only.)
    for (const reasons of [
      { f06_preparation_stuck: 13 },
      { f06_preparation_unresolved: 1 },
      { f06_preparation_stuck: 13, f06_preparation_unresolved: 2 },
    ]) {
      const result = certificate({ reasons });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^[0-9]+\n$/);
      expect(result.stderr).toContain('[engine-release-inflight-hands] answer 0');
    }
  });

  it('the caller evaluates the captured figure exactly as the transaction does', () => {
    const result = certificate({ reasons: { f06_preparation_stuck: 13 } });
    const arithmetic = spawnSync(
      'bash',
      ['-c', 'set -eu; BREAK_REMAINING_MS="$FIGURE"; echo $(( BREAK_REMAINING_MS / 1000 ))'],
      { encoding: 'utf8', env: { ...process.env, FIGURE: result.stdout.replace(/\n$/, '') } }
    );
    expect(arithmetic.status, arithmetic.stderr).toBe(0);
    expect(arithmetic.stdout.trim()).toBe('296');
  });

  it('the helper and the admission line are sent to stderr in the source', () => {
    expect(TRANSACTION).toContain('"$INFLIGHT_HANDS" --env-file "$ENV_FILE" >&2');
    expect(TRANSACTION).toContain(
      'admitting the cutover past the unresolved preparation named above" >&2'
    );
  });
});

describe('4. the shape of the gate is unchanged', () => {
  it('keeps the allow-list an allow-list and admits only through the database branch', () => {
    const from = TRANSACTION.indexOf('"$INFLIGHT_HANDS" --env-file');
    const admission = TRANSACTION.slice(from, TRANSACTION.indexOf('\n}', from));
    expect(admission.match(/return 0/g)).toHaveLength(1);
    expect(admission).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE/);
    // Every reason must still be a string; the bounded set stays a literal.
    expect(TRANSACTION).toContain('if not isinstance(k,str): raise SystemExit(1)');
    expect(TRANSACTION).toContain(
      'BOUNDED_ONLY={"f06_preparation_unresolved","f06_preparation_stuck"}'
    );
    const literal = TRANSACTION.match(/^BOUNDED_ONLY=\{(.*)\}$/m);
    expect(literal).toBeTruthy();
    expect(literal![1]).not.toMatch(/bank|custody/);
    // The old name is gone everywhere, so no reader keeps a stale copy.
    expect(TRANSACTION).not.toContain('PREPARATION_ONLY');
  });

  it('the engine raises the stuck reason under the shared bound, and still holds the gate', () => {
    expect(BREAK).toContain("count('stopped_bank_custody_stuck');");
    expect(BREAK).toContain(
      'private stoppedCustodyHoldsGate(tableId: string, reason: string): boolean {'
    );
    expect(BREAK).toContain('for (const tableId of [...this.stoppedCustodySince.keys()]) {');
    expect(BREAK).toMatch(/stopped_bank_custody_unwritten: \{[^}]*neverHoldsGate: true/);
  });
});
