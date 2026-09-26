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
 * 1. The engine bounds the class exactly like the F06 class (the engine-side
 *    cases live in server/src/maintenance/theGateSaysWhyItIsShut.law.test.ts)
 *    and the release admits the BOUNDED reason, `stopped_bank_custody_stuck`,
 *    under the same database in-flight proof as the preparation reasons.
 * 2. The RAW reason is admitted from exactly one serving release: the exact
 *    predecessor profile that can never present the bounded class because the
 *    bound is not in that build. An allow-list of full SHAs, like the
 *    checkpoint predecessor profiles. Any other serving release keeps refusing
 *    it, so the exception retires itself with the first bounded engine.
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
  writeFileSync(path, `#!/bin/sh\nexit ${rc}\n`);
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

describe('1. the bounded stopped-bank class is admitted like the bounded preparation class', () => {
  it('admits stopped_bank_custody_stuck with the database proof, from any serving release', () => {
    const result = certificate({ reasons: { stopped_bank_custody_stuck: 154 } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('296000');
    expect(result.stdout).toContain('the database confirms no hand is in the air');
    expect(result.stderr).toContain("held shut only by {'stopped_bank_custody_stuck': 154}");
    // Never the predecessor sentence: this is the ordinary bounded path.
    expect(result.stderr).not.toContain('can never release');
  });

  it('admits it mixed with both preparation reasons, which is the shape production showed', () => {
    const result = certificate({
      reasons: { f06_preparation_stuck: 13, stopped_bank_custody_stuck: 154 },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      certificate({
        reasons: { f06_preparation_unresolved: 1, stopped_bank_custody_stuck: 1 },
      }).status
    ).toBe(0);
  });

  it('refuses it without the database proof, on every one of the helper answers', () => {
    for (const rc of [1, 3, 126, 127, 9]) {
      const result = certificate({ reasons: { stopped_bank_custody_stuck: 154 }, inflightRc: rc });
      expect(result.status, `helper rc ${rc}`).not.toBe(0);
      expect(result.stdout).not.toContain('the database confirms');
    }
  });

  it("refuses it when the engine's own hands-in-flight witness is absent or non-zero", () => {
    expect(certificate({ reasons: { stopped_bank_custody_stuck: 1 }, hands: 1 }).status).not.toBe(
      0
    );
    expect(
      certificate({ reasons: { stopped_bank_custody_stuck: 1 }, hands: 'absent' }).status
    ).not.toBe(0);
    expect(certificate({ reasons: { stopped_bank_custody_stuck: 1 }, hands: '0' }).status).not.toBe(
      0
    );
  });
});

describe('2. the raw reason is admitted from the exact predecessor only', () => {
  it('admits stopped_bank_custody_unconfirmed when the serving release is the pinned predecessor', () => {
    const result = certificate({
      reasons: { f06_preparation_stuck: 13, stopped_bank_custody_unconfirmed: 154 },
      releaseSha: PREDECESSOR,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('the database confirms no hand is in the air');
    expect(result.stderr).toContain(
      'restart certificate is held shut by stopped-bank custody the predecessor 778075b4 can never release; ' +
        'the bound that retires it is not in that release; consulting the database for hands actually in the air'
    );
  });

  it('still requires the database proof from the predecessor', () => {
    for (const rc of [1, 3, 127]) {
      expect(
        certificate({
          reasons: { stopped_bank_custody_unconfirmed: 154 },
          releaseSha: PREDECESSOR,
          inflightRc: rc,
        }).status,
        `helper rc ${rc}`
      ).not.toBe(0);
    }
    expect(
      certificate({
        reasons: { stopped_bank_custody_unconfirmed: 154 },
        releaseSha: PREDECESSOR,
        hands: 1,
      }).status
    ).not.toBe(0);
  });

  it.each([
    BOUNDED_RELEASE,
    PREDECESSOR.slice(0, 8),
    PREDECESSOR.toUpperCase(),
    `${PREDECESSOR} `,
    undefined,
    null,
    42,
    true,
    {},
    // A mixed case list is not spread by it.each, so this arrives as an array.
    [PREDECESSOR],
  ])('refuses the raw reason from any other serving identity: %j', (releaseSha) => {
    const result = certificate({
      reasons: { stopped_bank_custody_unconfirmed: 154 },
      releaseSha,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('the database confirms');
    expect(result.stderr).not.toContain('can never release');
  });

  it('the predecessor allow-list is a literal set of exact full SHAs', () => {
    const literal = TRANSACTION.slice(
      TRANSACTION.indexOf('STOPPED_BANK_UNBOUNDED_PREDECESSORS={'),
      TRANSACTION.indexOf('}', TRANSACTION.indexOf('STOPPED_BANK_UNBOUNDED_PREDECESSORS={')) + 1
    );
    const shas = [...literal.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(shas).toEqual([PREDECESSOR]);
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Membership is exact string membership, on a string, with no prefix,
    // pattern or case relaxation anywhere near it.
    expect(TRANSACTION).toContain(
      'predecessor=isinstance(serving,str) and serving in STOPPED_BANK_UNBOUNDED_PREDECESSORS'
    );
    expect(TRANSACTION).toContain('serving=d.get("releaseSha")');
    expect(TRANSACTION).toContain(
      'if k not in BOUNDED_ONLY and not (k==RAW_STOPPED_BANK and predecessor): raise SystemExit(1)'
    );
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
    expect(result.stdout).not.toContain('the database confirms');
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
    expect(result.stdout).not.toContain('the database confirms');
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

describe('4. the shape of the gate is unchanged', () => {
  it('keeps the allow-list an allow-list and admits only through the database branch', () => {
    const from = TRANSACTION.indexOf('"$INFLIGHT_HANDS" --env-file');
    const admission = TRANSACTION.slice(from, TRANSACTION.indexOf('\n}', from));
    expect(admission.match(/return 0/g)).toHaveLength(1);
    expect(admission).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE/);
    // Every reason must still be a string; the bounded set stays a literal.
    expect(TRANSACTION).toContain('if not isinstance(k,str): raise SystemExit(1)');
    expect(TRANSACTION).toContain(
      'BOUNDED_ONLY={"f06_preparation_unresolved","f06_preparation_stuck","stopped_bank_custody_stuck"}'
    );
    // The old name is gone everywhere, so no reader keeps a stale copy.
    expect(TRANSACTION).not.toContain('PREPARATION_ONLY');
  });

  it('the engine raises the bounded reason it admits, under the shared bound', () => {
    expect(BREAK).toContain("count('stopped_bank_custody_stuck');");
    expect(BREAK).toContain('private stoppedBankCustodyHoldsGate(tableId: string): boolean {');
    expect(BREAK).toContain(
      'for (const tableId of [...this.stoppedBankUnconfirmedSince.keys()]) {'
    );
  });
});
