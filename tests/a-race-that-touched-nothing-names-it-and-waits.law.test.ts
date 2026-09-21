/**
 * LAW: a checkpoint refusal NAMES what moved, and a race that provably touched
 *      nothing waits for the next break instead of ending the release.
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-21, run 35623804237 on 91fcf87e44 - the release that carried #5026's
 * timing ladder, so it finally arrived inside its window. It died anyway:
 *
 *   {"ok":false,"reason":"mixed_owner_changed","checkpoint":{
 *     "stage":"preflight","attemptedTables":0,"completedCalls":0,
 *     "checkpointOutcome":"not_started","restartAuthorized":false,
 *     "failedCheck":"manager.captureDrainedF06Originals()","failedTable":"none"},
 *    "retryAllowed":false,"inspectorClosed":true,"cleanupConnections":0}
 *
 * TWO separate defects sit in that one line, and each is a rule here.
 *
 * 1. IT CANNOT NAME ITS OWN CAUSE. `captureDrainedF06Originals()` is a
 *    fourteen-term conjunction inside the predecessor that answers a bare
 *    `null` for every one of them, so `failedCheck` names the CALL and never
 *    the term. Worse, `checkpointSummary`'s allow-list then dropped
 *    `failedMap`, `failedSet` and both seat-move revisions, which the guard had
 *    already computed - so the receipt that reached the runner named a function
 *    and nothing else. CLAUDE.md 10.86 rule 1: "I could not tell" must not wear
 *    the same name as an answer; rule 2: an unreadable answer must never be
 *    coerced into an empty one.
 *
 * 2. IT KILLED A RELEASE IT HAD NOT TOUCHED. `stage: preflight`,
 *    `attemptedTables: 0`, `completedCalls: 0`, `checkpointOutcome:
 *    "not_started"` - the guard read the fleet, something moved between the
 *    capture and the re-verification a page of Supabase reads later, and it
 *    refused having written nothing. #5026 established the shape of the answer:
 *    `defer()` (exit 75) for an attempt that provably did not act. That
 *    deferral was reachable only ABOVE the O_EXCL intent, which is right for a
 *    disconnect and wrong here, because here the guard ANSWERED.
 *
 * WHAT THIS DOES NOT DO. It does not widen a tolerance. The four race refusals
 * still refuse, nothing is retired, and the next attempt re-proves every one of
 * them from scratch against a fresh break. `insufficient_reserve`, every
 * `maintenance_*` code and `bank_park_write_incomplete` are deliberately OUTSIDE
 * the list: those guard the freeze, the restart certificate and real durable
 * time-bank state, and a refusal that is not on the list still ends the release.
 * No cutover is ever certified with a hand in the air.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CHECKPOINT_DEFERRABLE_REFUSALS,
  deferrableCheckpointRefusal,
} from '../server/scripts/legacy-engine-checkpoint.mjs';

vi.setConfig({ testTimeout: 90_000 });

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const checkpointShell = read('server/scripts/legacy-engine-checkpoint.sh');
const checkpointModule = read('server/scripts/legacy-engine-checkpoint.mjs');
const guard = read('server/scripts/legacy-engine-checkpoint-guard.mjs');
const managerBase = read('server/src/tournament/TournamentManagerBase.ts');

/** The receipt run 35623804237 actually produced, verbatim. */
const RECEIPT = {
  ok: false,
  reason: 'mixed_owner_changed',
  checkpoint: {
    schema: 'legacy-engine-checkpoint/v1',
    ok: false,
    reason: 'mixed_owner_changed',
    stage: 'preflight',
    attemptedTables: 0,
    completedCalls: 0,
    verifiedTables: 0,
    bankCount: 0,
    uninitializedSeats: 0,
    readyForRestart: false,
    checkpointOutcome: 'not_started',
    paidAccountingQualification: 'native_pending_registry_unqualified',
    restartAuthorized: false,
    failedCheck: 'manager.captureDrainedF06Originals()',
    failedTable: 'none',
  },
  retryAllowed: false,
  checkpointInvoked: true,
  inspectorClosed: true,
  cleanupConnections: 0,
} as const;

const withReceipt = (mutate: (draft: Record<string, any>) => void) => {
  const draft = JSON.parse(JSON.stringify(RECEIPT));
  mutate(draft);
  return draft;
};

describe('LAW: a race that touched nothing names it and waits', () => {
  describe('the refusal names the term that moved', () => {
    it('walks every field the predecessor method reads, so a bare null is never the answer', () => {
      const signature = 'protected captureDrainedF06Originals()';
      const at = managerBase.indexOf(signature);
      expect(at).toBeGreaterThan(0);
      const body = managerBase.slice(at, managerBase.indexOf('\n  }', at));
      const fields = [...new Set([...body.matchAll(/this\.(\w+)/g)].map((m) => m[1]))];
      // a real coupling, not a word count: 13 distinct fields today, and if the
      // engine method ever grows a fifteenth term the diagnosis must learn it
      // or this fails. The guard may be WIDER than the method (it runs against
      // a sealed predecessor build, which can lag main) but never narrower.
      expect(fields.length).toBeGreaterThanOrEqual(13);
      const at2 = guard.indexOf('const failedDrain = () => {');
      expect(at2).toBeGreaterThan(0);
      const diagnosis = guard.slice(at2, guard.indexOf('\n          };', at2));
      for (const field of fields)
        expect(diagnosis, `failedDrain must name ${field}`).toContain(field);
      // and the three per-engine terms the same method reads
      for (const method of ['isRunning', 'hasReleasedProcessOwnership', 'hasSettlementInFlight'])
        expect(diagnosis).toContain(method);
      // it distinguishes "every term still holds" from "I could not read it"
      expect(diagnosis).toContain("return 'unnamed'");
      expect(diagnosis).toContain("return 'unreadable'");
    });

    it('is observability only: computed in extra(), never in the predicate list', () => {
      // `witness` evaluates the predicate list to DECIDE and calls extra() only
      // on a path that is already refusing. failedDrain must live in the latter,
      // or a diagnostic would start moving an outcome.
      const at = guard.indexOf("witness(\n            'mixed_owner_changed',");
      expect(at).toBeGreaterThan(0);
      const call = guard.slice(at, guard.indexOf('\n          return vector();', at));
      const predicates = call.slice(0, call.indexOf('() => ({'));
      expect(predicates).not.toContain('failedDrain');
      expect(call).toContain('failedDrain: failedDrain(),');
      // the helper itself is declared ABOVE the witness call, beside its peers
      expect(guard.indexOf('const failedDrain = () => {')).toBeLessThan(at);
    });

    it('the summary carries the sub-condition fields instead of silently dropping them', () => {
      const at = checkpointModule.indexOf('function checkpointSummary(');
      const body = checkpointModule.slice(at, checkpointModule.indexOf('\n}', at));
      for (const field of [
        'failedCheck',
        'failedTable',
        'failedMap',
        'failedSet',
        'failedDrain',
        'seatMoveRevision',
        'capturedSeatMoveRevision',
      ])
        expect(body, `checkpointSummary must carry ${field}`).toContain(`'${field}'`);
    });
  });

  describe('the deferrable predicate reads the receipt and never infers', () => {
    it('defers the exact receipt that ended run 35623804237', () => {
      expect(deferrableCheckpointRefusal(RECEIPT)).toBe(true);
    });

    it('defers arriving late and being overtaken, and nothing else', () => {
      expect([...CHECKPOINT_DEFERRABLE_REFUSALS].sort()).toEqual([
        'fleet_identity_changed',
        // arrived late: the guard found less than its reserve left. This does
        // NOT move the 285000ms floor - the guard refuses on the identical
        // reading at the identical threshold - it stops one mistimed arrival
        // consuming the operation. Run 35625997626 died on it at 16:30 on
        // 2026-09-21, twenty minutes after #5026's ladder shipped, with the
        // same preflight/attemptedTables-0 receipt as the races below.
        'insufficient_reserve',
        'mixed_local_custody_changed',
        'mixed_owner_changed',
        'server_changed',
      ]);
      for (const reason of CHECKPOINT_DEFERRABLE_REFUSALS)
        expect(
          deferrableCheckpointRefusal(
            withReceipt((d) => {
              d.reason = d.checkpoint.reason = reason;
            })
          ),
          reason
        ).toBe(true);
    });

    it('never defers the freeze, the reserve, or durable time-bank state', () => {
      // These are the refusals that must keep ending a release: the
      // maintenance codes are what stop a cutover being certified over a hand
      // in the air, and bank_park_write_incomplete is real durable time-bank
      // state, not a timing finding. A safety refusal is never a deferral.
      for (const reason of [
        'maintenance_not_durable_countdown',
        'maintenance_changed',
        'maintenance_shape',
        'maintenance_receipt_mismatch',
        'bank_park_write_incomplete',
        'mixed_bank_readback_unknown',
        'unexpected_tournament_context',
        'server_not_unique',
      ]) {
        expect(CHECKPOINT_DEFERRABLE_REFUSALS).not.toContain(reason);
        expect(
          deferrableCheckpointRefusal(
            withReceipt((d) => {
              d.reason = d.checkpoint.reason = reason;
            })
          ),
          reason
        ).toBe(false);
      }
    });

    it('never defers a receipt that says, or cannot rule out, that work began', () => {
      const denied: [string, (d: Record<string, any>) => void][] = [
        ['a table was attempted', (d) => (d.checkpoint.attemptedTables = 1)],
        ['a call completed', (d) => (d.checkpoint.completedCalls = 1)],
        ['a table was verified', (d) => (d.checkpoint.verifiedTables = 1)],
        ['a bank was read', (d) => (d.checkpoint.bankCount = 1)],
        ['the outcome is unconfirmed', (d) => (d.checkpoint.checkpointOutcome = 'unconfirmed')],
        ['it refused past preflight', (d) => (d.checkpoint.stage = 'checkpoint')],
        ['the inspector is still open', (d) => (d.inspectorClosed = false)],
        ['a cleanup connection remains', (d) => (d.cleanupConnections = 1)],
        ['a retry was already allowed', (d) => (d.retryAllowed = true)],
        ['it says it is ready', (d) => (d.checkpoint.readyForRestart = true)],
        ['a restart was authorised', (d) => (d.checkpoint.restartAuthorized = true)],
        ['the guard reported success', (d) => (d.checkpoint.ok = true)],
        [
          'cleanup failed under a race reason',
          (d) => (d.reason = 'inspector cleanup not verified'),
        ],
        ['the schema is unknown', (d) => (d.checkpoint.schema = 'legacy-engine-checkpoint/v2')],
        ['the schema is missing', (d) => delete d.checkpoint.schema],
        ['the stage is missing', (d) => delete d.checkpoint.stage],
        ['the counters are missing', (d) => delete d.checkpoint.attemptedTables],
        ['the reason is not a string', (d) => (d.reason = d.checkpoint.reason = 42)],
      ];
      for (const [name, mutate] of denied)
        expect(deferrableCheckpointRefusal(withReceipt(mutate)), name).toBe(false);
      // and every shape that is not a receipt at all
      for (const value of [null, undefined, 0, '', 'mixed_owner_changed', [], [RECEIPT], {}])
        expect(deferrableCheckpointRefusal(value as never)).toBe(false);
      // the fallback the helper builds when the invocation itself refused
      expect(
        deferrableCheckpointRefusal({
          ok: false,
          reason: 'legacy checkpoint invocation refused',
          retryAllowed: false,
        } as never)
      ).toBe(false);
    });

    it('defers a late arrival WITHOUT moving the reserve it arrived late for', () => {
      // the floor is #5026's and stays: what changes is only the consequence
      const guardSource = read('server/scripts/legacy-engine-checkpoint-guard.mjs');
      expect(guardSource).toContain('const reserveMs = 285000;');
      expect(
        deferrableCheckpointRefusal(
          withReceipt((d) => {
            d.reason = d.checkpoint.reason = 'insufficient_reserve';
          })
        )
      ).toBe(true);
      // and a late arrival that got PAST preflight is still fatal, because by
      // then it is no longer true that nothing was attempted
      expect(
        deferrableCheckpointRefusal(
          withReceipt((d) => {
            d.reason = d.checkpoint.reason = 'insufficient_reserve';
            d.checkpoint.stage = 'checkpoint';
            d.checkpoint.attemptedTables = 3;
            d.checkpoint.checkpointOutcome = 'unconfirmed';
          })
        )
      ).toBe(false);
    });

    it('is the only thing that can turn the helper 1 into a 75', () => {
      expect(checkpointModule).toContain(
        'process.exit(deferrableCheckpointRefusal(checkpointResult) ? 75 : 1);'
      );
      expect(checkpointModule.match(/process\.exit\(/g)).toHaveLength(1);
    });
  });

  describe('the shell retires its OWN intent, by bytes, or it dies', () => {
    // Behaviour, not text: drive the real below-intent block as a subprocess.
    const block = checkpointShell.slice(
      checkpointShell.indexOf('if [ "$CHECKPOINT_RC" = 75 ]; then'),
      checkpointShell.indexOf(
        "|| die 'checkpoint or inspector cleanup refused; do not retry this operation'"
      ) + "|| die 'checkpoint or inspector cleanup refused; do not retry this operation'".length
    );
    const INTENT = '{"instance":"1-3846b8bb","runId":"35623804237-1","retryAllowed":false}';

    const run = (rc: number, onDisk: string | null) => {
      const root = mkdtempSync(join(tmpdir(), 'checkpoint-defer-'));
      const path = join(root, '35623804237-1.legacy-checkpoint-intent');
      if (onDisk !== null) writeFileSync(path, onDisk);
      try {
        const result = spawnSync(
          'bash',
          [
            '-c',
            `set -euo pipefail
die() { echo "$*" >&2; exit 1; }
defer_proved_not_started() { echo "$*" >&2; exit 75; }
timeout() { shift; "$@"; }
REQUEST_ROOT="$PROBE_ROOT"
RUN_ID=35623804237-1
CHECKPOINT_INTENT="$PROBE_INTENT"
CHECKPOINT_RC=${rc}
${block}
printf '%s' checkpoint-accepted
`,
          ],
          {
            encoding: 'utf8',
            timeout: 20_000,
            env: { ...process.env, PROBE_ROOT: root, PROBE_INTENT: INTENT },
          }
        );
        return { ...result, retired: !existsSync(path), root };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it('defers and retires the intent when the bytes are the ones it wrote', () => {
      const deferred = run(75, `${INTENT}\n`);
      expect(deferred.status, deferred.stderr).toBe(75);
      expect(deferred.retired).toBe(true);
      expect(deferred.stdout).not.toContain('checkpoint-accepted');
    });

    it('DIES and preserves an intent that is not byte-for-byte its own', () => {
      // the decisive case: another entry's intent, or a truncated one, is not
      // a licence to retry - and it must survive so the transaction still sees it
      for (const foreign of [
        `${INTENT.replace('35623804237-1', '35613147982-1')}\n`,
        INTENT,
        `${INTENT}\n\n`,
        '',
      ]) {
        const died = run(75, foreign);
        expect(died.status, `foreign intent ${JSON.stringify(foreign)}`).toBe(1);
        expect(died.retired).toBe(false);
      }
    });

    it('DIES when there is no intent at all, and creates none', () => {
      const died = run(75, null);
      expect(died.status).toBe(1);
      expect(died.retired).toBe(true); // still absent: nothing was written
      expect(died.stdout).not.toContain('checkpoint-accepted');
    });

    it('leaves a success and an ordinary refusal exactly as they were', () => {
      const ok = run(0, `${INTENT}\n`);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('checkpoint-accepted');
      expect(ok.retired).toBe(false);

      const refused = run(1, `${INTENT}\n`);
      expect(refused.status).toBe(1);
      expect(refused.stdout).not.toContain('checkpoint-accepted');
      expect(refused.retired).toBe(false);
    });
  });

  it('the transaction still proves the absence for itself', () => {
    // This law removes the intent; it does NOT remove the transaction's own
    // filesystem proof, which stays the final arbiter of whether 75 is honoured
    // (#5026). If that proof ever disappears, the two halves stop checking
    // each other and one edit can authorise a retry on its own.
    const transaction = read('server/scripts/engine-release-transaction.sh');
    expect(transaction).toContain('[ ! -e "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" ]');
    expect(transaction).toContain(
      "die 'legacy checkpoint deferred but its durable intent exists; refusing a retry'"
    );
  });
});
