/**
 * ===========================================================================
 *  LAW: EVERY SQL SENDER OF A PRODUCTION ALERTS EVENT ADDRESSES THE FLEET
 * ===========================================================================
 *
 * WHY THIS EXISTS (2026-09-28, incident owner-accounting-unaddressed)
 *
 * The Production Alerts fleet triages public.operational_alert_events by
 * payload.target_task_id. 20260927143752 (#5428) added a call to
 * fn_record_operational_alert() inside fn_mirror_notification_to_push_outbox()
 * whose payload had no target_task_id, and nothing checked it. 20260928032225
 * addresses that call, makes the store refuse an unaddressed row under source
 * 'owner-accounting-notifications', and records a refused recording for the
 * fleet instead of only raising a WARNING.
 *
 * This law runs inside Client Unit Tests (vitest), which is required and runs
 * on every pull request that touches supabase/migrations/, scripts/dev/ or
 * tests/. It holds four things:
 *
 *   - the rule (tests/helpers/operational-sender-addressing.mjs) over the whole
 *     migration corpus, both readings, with its one reviewed assumption pinned;
 *   - the owning layer's invariant: the migration's store rule, which no later
 *     migration may drop;
 *   - the regression's bytes (sha256) and its wiring into
 *     scripts/dev/test-accounting-push-bridge.sh, including the step that runs
 *     it against any later body of the function;
 *   - the routing: scripts/ci/classify-ci-changes.mjs itself must send a change
 *     to the rule, its cases or its SQL regression to a required check.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
import {
  FLEET_TASK_ID,
  SUPERSEDED_HISTORY,
  audit,
  check,
  readMigrations,
} from './helpers/operational-sender-addressing.mjs';
import { codeOnly } from './helpers/sql-reader.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const PRE_FIX = '20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql';
const FIX = '20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql';
const HARNESS = 'scripts/dev/test-accounting-push-bridge.sh';
const STORE = 'scripts/dev/fixtures/owner-accounting-alerts/operational-alert-store.sql';
const REGRESSION = 'scripts/dev/fixtures/owner-accounting-alerts/owner-routing-regression.sql';
const RULE = 'operational_alert_events_owner_accounting_addressed';
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const hash = (algorithm: string, text: string) =>
  createHash(algorithm).update(text, 'utf8').digest('hex');
// The corpus is about 4,800 files and 57 MB; a shared runner reads it slowly.
const CORPUS_TIMEOUT = 30_000;

describe('every SQL sender of a Production Alerts event addresses the fleet', () => {
  const files = readMigrations(MIGRATIONS);

  it(
    'no migration installs a sender whose payload does not prove the fleet address',
    () => {
      const result = check(files, { repo: ROOT });
      expect(result.code, result.lines.join('\n')).toBe(0);
      // A new assumption is a new hole in the proof: it must be reviewed here.
      expect(
        result.assumed.map(
          (a: { name: string; file: string; assumption: string }) =>
            `${a.name} ${a.file}: ${a.assumption}`
        )
      ).toEqual([
        "operational_source_intake.record_strict(text,jsonb,text,uuid) 20260917062322_direct_operational_source_intake.sql: removes the key (m->>'field'), computed at run time, and is assumed not to remove target_task_id",
      ]);
    },
    CORPUS_TIMEOUT
  );

  it('the rule still refuses the body it was written for', () => {
    const verdict = audit([{ file: PRE_FIX, sql: read(`supabase/migrations/${PRE_FIX}`) }]);
    expect(verdict.unaddressed.map((u: { name: string }) => u.name)).toEqual([
      'fn_mirror_notification_to_push_outbox()',
    ]);
  });

  it(
    'the superseded history is closed, and each entry is one file whose body is no longer the latest',
    () => {
      expect(SUPERSEDED_HISTORY.map((h: { fn: string }) => h.fn)).toEqual([
        'fn_mirror_notification_to_push_outbox()',
      ]);
      const latest = audit(files).senders as Array<{ name: string; file: string }>;
      for (const h of SUPERSEDED_HISTORY as Array<{ md5: string; file: string; fn: string }>) {
        const carriers = files.filter((f) => hash('md5', f.sql) === h.md5).map((f) => f.file);
        expect(carriers, `${h.file}: exactly one migration carries md5 ${h.md5}`).toHaveLength(1);
        const current = latest.find((s) => s.name === h.fn);
        expect(current?.file, `${h.fn} must still be superseded by a later body`).not.toBe(
          carriers[0]
        );
      }
    },
    CORPUS_TIMEOUT
  );
});

describe('the store refuses an unaddressed owner accounting row', () => {
  it('the fix installs the rule with IS NOT DISTINCT FROM, validated, beside the failure record', () => {
    const fix = read(`supabase/migrations/${FIX}`);
    expect(fix).toContain(
      `ADD CONSTRAINT ${RULE}\n CHECK (source<>'owner-accounting-notifications'\n  OR (payload->>'target_task_id') IS NOT DISTINCT FROM '${FLEET_TASK_ID}');`
    );
    expect(fix).toContain(
      `jsonb_build_object('target_task_id','${FLEET_TASK_ID}','unstored_event_key',`
    );
    expect(fix).toMatch(/NOT FOUND OR NOT con\.convalidated OR con\.condeferrable/);
  });

  it(
    'no other migration drops, renames or re-adds the rule, or drops the table that holds it',
    () => {
      const undoes = new RegExp(
        `(?:drop|rename)\\s+constraint\\s+(?:if\\s+exists\\s+)?"?${RULE}"?|add\\s+constraint\\s+"?${RULE}"?|drop\\s+table[^;]*\\boperational_alert_events\\b`,
        'i'
      );
      const touching = readMigrations(MIGRATIONS)
        .filter((f) => f.file !== FIX && /operational_alert_events/i.test(f.sql))
        .filter((f) => undoes.test(codeOnly(f.sql)))
        .map((f) => f.file);
      expect(touching).toEqual([]);
    },
    CORPUS_TIMEOUT
  );
});

describe('the regression the fix shipped with stays whole and wired', () => {
  it('the store and regression fixtures are the reviewed bytes (edit them together with this pin)', () => {
    expect(hash('sha256', read(STORE))).toBe(
      '252ea94806b232ebaf8c8b0a544b5496a739447d9bee22de4d75f9c79ce8fe3b'
    );
    expect(hash('sha256', read(REGRESSION))).toBe(
      '4912adfadacb08586ed2ba3f4c8ba1f99c6a8b3132489b11d873d1acf312a5b0'
    );
  });

  it('the harness installs the store, then #5428, the fix, every later body of the mirror, and the regression', () => {
    const harness = read(HARNESS);
    const at = (text: string) => harness.indexOf(text);
    expect(at('-f "$alerts/operational-alert-store.sql"')).toBeGreaterThan(-1);
    expect(at(`-f "$root/supabase/migrations/${PRE_FIX}"`)).toBeGreaterThan(
      at('-f "$alerts/operational-alert-store.sql"')
    );
    expect(at(`-f "$root/supabase/migrations/${FIX}"`)).toBeGreaterThan(
      at(`-f "$root/supabase/migrations/${PRE_FIX}"`)
    );
    expect(at('${later[@]+"${later[@]}"}')).toBeGreaterThan(
      at(`-f "$root/supabase/migrations/${FIX}"`)
    );
    expect(at('-f "$alerts/owner-routing-regression.sql"')).toBeGreaterThan(
      at('${later[@]+"${later[@]}"}')
    );
    expect(harness).toContain("grep -li 'fn_mirror_notification_to_push_outbox'");
    expect(harness).toContain('[[ "$b" > "${mirrors[0]}" ]] || continue');
  });
});

describe('a change to the rule, its cases or its regression reaches a required check', () => {
  it('scripts/ci/classify-ci-changes.mjs sends each of them, alone, to the checks that run them', () => {
    for (const path of [
      'tests/helpers/operational-sender-addressing.mjs',
      'tests/helpers/sql-reader.mjs',
      'tests/an-operational-alert-sender-addresses-the-fleet.decisions.test.ts',
      'tests/an-operational-alert-sender-addresses-the-fleet.law.test.ts',
    ]) {
      expect(classifyChangedPaths([path]).tests, `${path} -> Client Unit Tests`).toBe(true);
    }
    for (const path of [STORE, REGRESSION, HARNESS]) {
      const flags = classifyChangedPaths([path]);
      expect([flags.server, flags.tests], `${path} -> accounting job and vitest`).toEqual([
        true,
        true,
      ]);
    }
  });
});
