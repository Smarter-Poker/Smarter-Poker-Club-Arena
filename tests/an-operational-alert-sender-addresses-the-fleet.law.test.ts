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
 *     migration may drop, and which keeps only the unaddressed rows already
 *     stored when it is added (production held row 176726 by 2026-09-29), each
 *     listed under the table lock by id and payload digest;
 *   - the regression's bytes (sha256) and its wiring into
 *     scripts/dev/test-accounting-push-bridge.sh, including the step that runs
 *     it against any later body of the function, and the second run that
 *     applies the fix over rows the pre-image stored first;
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
const ROWS_BEFORE =
  'scripts/dev/fixtures/owner-accounting-alerts/unaddressed-rows-before-the-fix.sql';
const ROWS_KEPT =
  'scripts/dev/fixtures/owner-accounting-alerts/unaddressed-rows-kept-after-the-fix.sql';
const RULE = 'operational_alert_events_owner_accounting_addressed';
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const hash = (algorithm: string, text: string) =>
  createHash(algorithm).update(text, 'utf8').digest('hex');
/** Each of `parts` occurs in `text` after the one before it. */
const inOrder = (text: string, parts: string[]) => {
  let at = -1;
  for (const part of parts) {
    const next = text.indexOf(part, at + 1);
    expect(next, `${part} after position ${at}`).toBeGreaterThan(at);
    at = next;
  }
};
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
      `ADD CONSTRAINT ${RULE}\n CHECK (source<>'owner-accounting-notifications'\n  OR (payload->>'target_task_id') IS NOT DISTINCT FROM '${FLEET_TASK_ID}'\n  OR (id::text||':'||md5(payload::text))=ANY(%L::text[]))$ddl$,kept);`
    );
    expect(fix).toContain(
      `jsonb_build_object('target_task_id','${FLEET_TASK_ID}','unstored_event_key',`
    );
    expect(fix).toMatch(/NOT FOUND OR NOT con\.convalidated OR con\.condeferrable/);
    expect(fix).toContain(`|| md5((payload)::text)) = ANY (%L::text[]))))',kept)`);
  });

  it('it keeps the unaddressed rows already stored, listed under the lock by id and payload digest, and no others', () => {
    const fix = read(`supabase/migrations/${FIX}`);
    const list =
      `SELECT COALESCE(array_agg(e.id::text||':'||md5(e.payload::text) ORDER BY e.id),'{}') INTO kept\n` +
      ` FROM public.operational_alert_events e WHERE e.source='owner-accounting-notifications'\n` +
      `  AND (e.payload->>'target_task_id') IS DISTINCT FROM '${FLEET_TASK_ID}';`;
    // Replace the function, lock the table, list the rows, add the rule; the
    // post-check lists them again and compares the rule's text with them.
    inOrder(fix, [
      'CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox()',
      '\nLOCK TABLE public.operational_alert_events IN ACCESS EXCLUSIVE MODE;\n',
      list,
      `EXECUTE format($ddl$ALTER TABLE public.operational_alert_events\n ADD CONSTRAINT ${RULE}`,
      'DO $post$',
      list,
    ]);
    // Not NOT VALID (checked on every update of a kept row) and not a range
    // of ids (it would exempt rows that were never kept).
    const code = codeOnly(fix);
    expect(code).not.toMatch(/\bNOT\s+VALID\b/i);
    expect(code).not.toMatch(/\bid\s*<=?\s*\d/i);
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
    expect(hash('sha256', read(ROWS_BEFORE))).toBe(
      'e55d8417f376af04c5ee506d82c7f89a1be527888c26d2eb0a31a21b2c42c14d'
    );
    expect(hash('sha256', read(ROWS_KEPT))).toBe(
      '7e8614a4eec6c1935ad9cbce94363ae14bf0402f6f4cada1c40b02470a243f30'
    );
  });

  it('the harness runs both shapes: the store, #5428, the fix, every later body of the mirror, then the regression; and with rows stored before the fix', () => {
    const harness = read(HARNESS);
    const store = '-f "$alerts/operational-alert-store.sql"';
    const preFix = `-f "$root/supabase/migrations/${PRE_FIX}")`;
    const fix = `-f "$root/supabase/migrations/${FIX}"`;
    const later = '${later[@]+"${later[@]}"}';
    inOrder(harness, [
      'before_fix=(',
      store,
      preFix,
      'run clean "${before_fix[@]}"',
      fix,
      later,
      '-f "$alerts/owner-routing-regression.sql"',
      'run rows-before-the-fix "${before_fix[@]}"',
      '-f "$alerts/unaddressed-rows-before-the-fix.sql"',
      fix,
      later,
      '-f "$alerts/unaddressed-rows-kept-after-the-fix.sql"',
    ]);
    // Neither shape gets the fix before its rows are in place.
    expect(harness.slice(harness.indexOf('before_fix=('), harness.indexOf(preFix))).not.toContain(
      FIX
    );
    expect(harness.split(fix)).toHaveLength(3);
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
    for (const path of [STORE, REGRESSION, ROWS_BEFORE, ROWS_KEPT, HARNESS]) {
      const flags = classifyChangedPaths([path]);
      expect([flags.server, flags.tests], `${path} -> accounting job and vitest`).toEqual([
        true,
        true,
      ]);
    }
  });
});
