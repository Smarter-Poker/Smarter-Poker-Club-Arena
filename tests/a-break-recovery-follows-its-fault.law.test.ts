/**
 * LAW: an engine break recovery follows its fault.
 * ===========================================================================
 * Production Alerts, lane PRIMARY-CHAT, 2026-09-28. The hourly break scorecard
 * (fn_ca_record_break_scorecard, called with no argument by the :12 pg_cron
 * job) sent engine_break_failed through fn_ca_break_scorecard_push when an
 * hour's break failed, and nothing when a later hour passed: its only
 * notification branch was `IF v_verdict = 'fail'`. Read from production that
 * day: 34 firing engine_break_failed receipts for the Production Alerts task,
 * none ever followed by a recovery, while every hour of the last seven days
 * passed.
 *
 * 20260928155739 makes the hourly job's pass send one engine_break_recovered
 * per route for every notice sent since 2026-09-28 that no recovery names yet.
 * A recovery is owed to the NOTICE, not to a verdict history, so no re-score
 * or backfill can hide one (an independent review broke the first version,
 * which read an episode from the scorecard, exactly that way). Every error on
 * the recovery path is caught and every lock wait there gives up (lock_timeout)
 * before the hourly job's statement timeout, so the recovery cannot cost the
 * scorecard its pass; for the owner account only a resolved receipt addressed
 * to the task recovers a fault (a recovery in his personal inbox does not, and
 * one the classifier would not file with the task is never written); what is
 * not delivered is accounted for in the pass row and held for the task by ONE
 * firing NotifiedFaultWithoutRecovery that recovers on its own key; and
 * scripts/ci/check-engine-break-recoveries.mjs reads the same contract from
 * production after each hourly Production Integrity Audit, knowing the hourly
 * job's passes from pg_cron's own run log. The classifier side - that the
 * newest classifier still files engine_break_recovered with the task - is held
 * by tests/the-owner-classifier-keeps-its-operational-kinds.law.test.ts (the
 * held classifier change, 20260928171444); this law does not duplicate it.
 *
 * These pins read the NEWEST migration that defines each function, found in
 * any case, with the schema and name quoted or not, and inside EXECUTE
 * strings, but never in a comment. Migrations are append-only: a later
 * migration that redefines the recorder from an older copy would otherwise
 * drop the recovery without a word. What text cannot show - a later migration
 * that rewrites a body it reads at run time, with replace() over
 * pg_get_functiondef as #5512 does - the probe executes: it applies every
 * later migration that names the recorder, the push or the recovery, and
 * .github/workflows/engine-break-recovery.yml runs it on every pull request
 * that adds one. A migration that never spells the name at all is seen by the
 * audit in production, at the next pass.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FLEET_TASK_ID,
  OVERDUE_SQL,
  OWNED_FROM,
  OWNER_ACCOUNT,
  SOURCE as AUDIT_SOURCE,
} from '../scripts/ci/check-engine-break-recoveries.mjs';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS_DIR = resolve(ROOT, 'supabase/migrations');
const TASK = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
const FIX = '20260928155739_engine_break_recoveries_follow_their_fault.sql';
const STORE_ONLY =
  '20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql';
const PRE_FIX = '20260910132747_the_break_scorecard_names_why_a_break_never_started.sql';
const RECORDER = 'fn_ca_record_break_scorecard';
const PUSH = 'fn_ca_break_scorecard_push';
const RECOVERED = 'fn_ca_break_scorecard_recovered';

const read = (file: string): string => readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
const migrations: string[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** SQL without comments. String literals stay: a definition can live in an EXECUTE string. */
const withoutComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** CREATE [OR REPLACE] FUNCTION [public.]<name>(, in any case, quoted or not. */
const definitionOf = (name: string): RegExp =>
  new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+(?:"?public"?\\s*\\.\\s*)?"?${name}"?\\s*\\(`,
    'gi'
  );
const defines = (sql: string, name: string): boolean =>
  definitionOf(name).test(withoutComments(sql));

/** The last definition of <name> in `sql`, comments removed: its header and its dollar-quoted body. */
const bodyOf = (sql: string, name: string): string => {
  const clean = withoutComments(sql);
  const found = [...clean.matchAll(definitionOf(name))];
  expect(found.length, `${name} is not defined here`).toBeGreaterThan(0);
  const start = found[found.length - 1].index ?? 0;
  const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(clean.slice(start));
  expect(as, `${name} is not dollar-quoted, so its body cannot be read`).not.toBeNull();
  const open = start + (as?.index ?? 0) + (as?.[0].length ?? 0);
  const close = clean.indexOf(as?.[1] ?? '$$', open);
  expect(close, `${name}'s ${as?.[1]} is never closed`).toBeGreaterThan(open);
  return clean.slice(start, close);
};

/** The newest definition of <name> among [file, sql] pairs in migration order. */
const governing = (name: string, texts: [string, string][]): [string, string] => {
  const defining = texts.filter(([, sql]) => defines(sql, name));
  expect(defining.length, `no migration defines ${name}`).toBeGreaterThan(0);
  const [file, sql] = defining[defining.length - 1];
  return [file, bodyOf(sql, name)];
};
const repo = (): [string, string][] => migrations.map((f) => [f, read(f)]);
/** SQL in lowercase except its string literals, which are data. */
const lowerCode = (sql: string): string =>
  sql.replace(/('(?:[^']|'')*')|[^']+/g, (m: string, lit?: string) =>
    lit ? lit : m.toLowerCase()
  );

// -- The recorder's contract -------------------------------------------------
const RECOVERY_BRANCH =
  /ELSIF\s+v_verdict\s*=\s*'pass'\s+AND\s+p_end\s+IS\s+NULL\s+THEN\s+BEGIN\s+v_recovery\s*:=\s*public\.fn_ca_break_scorecard_recovered\s*\(\s*v_row\s*\)\s*;\s*EXCEPTION\s+WHEN\s+OTHERS\s+THEN\s+v_recovery\s*:=/i;
const recorderHolds = (body: string): string[] => {
  const broken: string[] = [];
  if (!RECOVERY_BRANCH.test(body))
    broken.push("the hourly job's pass (no p_end) calls the recovery inside its own handler");
  if (
    !/IF\s+v_verdict\s*=\s*'fail'\s+THEN\s+PERFORM\s+public\.fn_ca_break_scorecard_push\s*\(\s*v_row\s*\)/i.test(
      body
    )
  )
    broken.push('a fail still sends the push');
  if (
    !/UPDATE\s+public\.ca_break_scorecards\s+SET\s+detail\s*=\s*detail\s*\|\|\s*jsonb_build_object\s*\(\s*'recovery'\s*,\s*v_recovery\s*\)/i.test(
      body
    )
  )
    broken.push("the pass row keeps the recovery's account");
  if (
    !/detail\s*=\s*EXCLUDED\.detail\s*\|\|\s*CASE\s+WHEN\s+s\.detail\s*\?\s*'recovery'/i.test(body)
  )
    broken.push('a re-score keeps that account');
  if (!/SET\s+"?timezone"?\s+(?:TO|=)\s+'UTC'[\s\S]*\bAS\s+\$/i.test(body))
    broken.push('the recorder runs in UTC, so the push it calls keys every fault in UTC');
  return broken;
};

// -- The recovery's contract -------------------------------------------------
const recoveryHolds = (body: string): string[] => {
  const broken: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) broken.push(what);
  };
  const owned = /c_owned_from\s+CONSTANT\s+TIMESTAMPTZ\s*:=\s*'([^']+)'/i.exec(body);
  need(
    owned?.[1] === OWNED_FROM,
    `faults are owned from ${OWNED_FROM}, the instant the audit reads from`
  );
  need(
    /n\.created_at\s*>=\s*c_owned_from/i.test(body) &&
      /d\.captured_at\s*>=\s*c_owned_from/i.test(body),
    'what is owed is read from the notices on both routes'
  );
  need(
    !/JOIN\s+public\.ca_break_scorecards/i.test(body) && !/v_since/i.test(body),
    'what is owed never depends on the verdict history (a re-score or backfill cannot hide a fault)'
  );
  need(
    /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.ca_break_scorecards\s+s\s+WHERE\s+s\.break_ended_at\s*=\s*p_row\.break_ended_at\s+AND\s+s\.verdict\s*=\s*'pass'\s*\)/i.test(
      body
    ),
    'only a pass the scorecard recorded acts'
  );
  const raises = body.match(/RAISE\s+EXCEPTION(?:'(?:[^']|'')*'|[^';])*;/gi) ?? [];
  need(
    raises.length === 1 && /ERRCODE\s*=\s*'22023'/i.test(raises[0] ?? ''),
    'it raises only for a pass that was never recorded, never for a delivery'
  );
  need(
    /EXCEPTION\s+WHEN\s+OTHERS\s+THEN\s+v_failed\s*:=/i.test(body),
    "a route's delivery error is caught and kept"
  );
  need(
    /EXCEPTION\s+WHEN\s+OTHERS\s+THEN\s+v_error\s*:=/i.test(body),
    'an error sending is caught and kept'
  );
  need(
    /EXCEPTION\s+WHEN\s+OTHERS\s+THEN\s+v_record_error\s*:=/i.test(body),
    'an error recording is caught and kept'
  );
  need(!/WHEN\s+OTHERS\s+THEN\s+NULL\b/i.test(body), 'no handler swallows what it caught');
  need(/RAISE\s+WARNING/i.test(body), 'a record the store refused is warned about');
  need(
    /INSERT\s+INTO\s+public\.notifications/i.test(body) &&
      body.includes("'engine_break_recovered'"),
    'the recovery is written like the fault it follows'
  );
  need(
    body.includes("'resolves',") && body.includes("'resolves_notification_ids',"),
    'it names what it resolves'
  );
  need(
    /'break-recovered:'\s*\|\|\s*to_char\s*\(\s*p_row\.break_ended_at\s+AT\s+TIME\s+ZONE\s+'UTC'/i.test(
      body
    ) && /SET\s+"?timezone"?\s+(?:TO|=)\s+'UTC'/i.test(body),
    'its keys are UTC'
  );
  need(
    new RegExp(`c_task\\s+CONSTANT\\s+TEXT\\s*:=\\s*'${TASK}'`, 'i').test(body) &&
      /'target_task_id'\s*,\s*c_task/i.test(body),
    'what it records is addressed to the task'
  );
  need(
    body.includes("'NotifiedFaultWithoutRecovery'") &&
      body.includes("'break-scorecard-recovery-guard'"),
    'it records NotifiedFaultWithoutRecovery'
  );
  need(
    /fn_record_operational_alert\s*\(\s*c_guard\s*,\s*v_recorded\s*,\s*c_alert\s*,\s*'firing'/i.test(
      body
    ) &&
      /WHEN\s+v_prev_status\s*=\s*'firing'\s+AND\s+NOT\s+v_prev_closed\s+THEN\s+v_prev_key/i.test(
        body
      ),
    'one firing record per episode, reused while it is open'
  );
  need(
    /fn_record_operational_alert\s*\(\s*c_guard\s*,\s*v_prev_key\s*\|\|\s*':resolved'\s*,\s*c_alert\s*,\s*'resolved'/i.test(
      body
    ),
    'which recovers on its own key'
  );
  need(
    /IN\s*\(\s*'verified_fixed'\s*,\s*'historical'\s*\)/i.test(body),
    'a record the task closed is never reused'
  );
  need(
    /SET\s+lock_timeout\s+(?:TO|=)\s+'[1-9][0-9]?s'[\s\S]*\bAS\s+\$/i.test(body),
    "a lock wait on the recovery path gives up (lock_timeout, caught) before the job's statement timeout"
  );
  need(
    new RegExp(`c_owner\\s+CONSTANT\\s+UUID\\s*:=\\s*'${OWNER_ACCOUNT}'`, 'i').test(body) &&
      /IF\s+r\.route\s*=\s*c_owner\s+AND\s+public\.fn_is_owner_operational_notification\s*\(\s*r\.route\s*,\s*'engine_break_recovered'[\s\S]*?IS\s+NOT\s+TRUE\s+THEN[\s\S]*?CONTINUE\s*;/i.test(
        body
      ),
    "the owner account's recovery is written only when the classifier files it with the task"
  );
  need(
    /NOT\s+CASE\s+WHEN\s+f0\.route\s*=\s*c_owner\s+THEN\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.operational_notification_destinations\s+x\s+JOIN\s+public\.operational_alert_events\s+e/i.test(
      body
    ),
    'for the owner account only a resolved receipt addressed to the task recovers a fault'
  );
  return broken;
};

describe('an engine break recovery follows its fault', () => {
  it("the newest recorder sends the recovery on the hourly job's pass, never at the cost of that pass", () => {
    const [file, body] = governing(RECORDER, repo());
    expect(recorderHolds(body), `${file} (the newest definition of ${RECORDER})`).toEqual([]);
  });

  it('the newest recovery is owed to the notice, delivered like its fault, and accounts for what it cannot deliver', () => {
    const [file, body] = governing(RECOVERED, repo());
    expect(recoveryHolds(body), `${file} (the newest definition of ${RECOVERED})`).toEqual([]);
  });

  it('no role but its owner may call the recovery', () => {
    expect(withoutComments(read(FIX))).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.fn_ca_break_scorecard_recovered\s*\(\s*public\.ca_break_scorecards\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*;/i
    );
    for (const f of migrations.filter((m) => m >= FIX)) {
      expect(
        withoutComments(read(f)),
        `${f} grants EXECUTE on ${RECOVERED}: only the recorder (its owner) may call it`
      ).not.toMatch(/GRANT\s+[^;]*\bON\s+FUNCTION\s+[^;]*fn_ca_break_scorecard_recovered/i);
    }
  });

  it('every @live-proof is about what this migration installs, so none holds before it', () => {
    const proofs = declaredProofs(read(FIX));
    expect(proofs.length).toBeGreaterThanOrEqual(3);
    for (const p of proofs)
      expect(p, 'a proof of something that was already true').toMatch(
        /fn_ca_record_break_scorecard|fn_ca_break_scorecard_recovered/
      );
    expect(proofs.some((p) => /NOT\s+has_function_privilege\('service_role'/i.test(p))).toBe(true);
  });

  it("it cannot install before store-only delivery, which keeps the owner account's copy out of his inbox", () => {
    const fix = read(FIX);
    const proofs = declaredProofs(read(STORE_ONLY));
    expect(proofs.length, `${STORE_ONLY} declares no @live-proof`).toBeGreaterThanOrEqual(7);
    for (const proof of proofs) {
      expect(
        fix.includes(`IF ${proof} IS NOT TRUE THEN`),
        `${FIX} does not re-check: ${proof}`
      ).toBe(true);
    }
    expect(fix).toContain('ENGINE_BREAK_RECOVERY_NEEDS_STORE_ONLY_DELIVERY');
  });

  it('it leaves the push that #5512 pins untouched', () => {
    expect(defines(read(FIX), PUSH)).toBe(false);
  });

  it('the audit reads production for the same contract after every hourly Production Integrity Audit', () => {
    expect(FLEET_TASK_ID).toBe(TASK);
    expect(AUDIT_SOURCE).not.toBe('break-scorecard-recovery-guard');
    const wf = readFileSync(resolve(ROOT, '.github/workflows/engine-break-recovery.yml'), 'utf8');
    expect(wf).toMatch(/workflow_run:\s+workflows:\s+\['Production Integrity Audit'\]/);
    expect(wf).toContain('run: node scripts/ci/check-engine-break-recoveries.mjs');
    expect(wf).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(wf).toContain('run: node --test scripts/ci/check-engine-break-recoveries.test.mjs');
    expect(wf).not.toMatch(/\bschedule:/);
    // It knows the hourly job's pass from pg_cron's own log, not from the code it audits.
    expect(OVERDUE_SQL).toMatch(/FROM cron\.job_run_details d/);
  });

  it('the probe runs on every pull request adding a migration that names what it guards, and applies it', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/engine-break-recovery.yml'), 'utf8');
    expect(wf).toContain('- supabase/migrations/**');
    expect(wf).toContain('bash scripts/dev/probe-engine-break-recovery.sh --touches $migrations');
    expect(wf).toContain('run: bash scripts/dev/probe-engine-break-recovery.sh');
    const probe = readFileSync(resolve(ROOT, 'scripts/dev/probe-engine-break-recovery.sh'), 'utf8');
    expect(probe).toContain(`GUARDED='${RECORDER}|${PUSH}|${RECOVERED}'`);
    expect(probe).toContain('grep -Eic "$GUARDED"');
    expect(probe).toMatch(/touches "\$f"; then later\+=\("\$f"\)/);
    expect(probe).toContain('psql -f "$f"');
    // Every later definition this law reads is one the probe applies (it names them outside a comment).
    for (const f of migrations.filter((m) => m > FIX)) {
      if (defines(read(f), RECORDER) || defines(read(f), RECOVERED))
        expect(read(f).replace(/--[^\n]*/g, ''), f).toMatch(
          new RegExp(`${RECORDER}|${RECOVERED}`, 'i')
        );
    }
  });

  it('the finder cannot be evaded by case, quotes or an EXECUTE string, and ignores comments and grants', () => {
    for (const sql of [
      'create or replace function public.fn_ca_record_break_scorecard(p timestamptz) returns int as $$ begin return 1; end $$;',
      'CREATE FUNCTION "public"."fn_ca_record_break_scorecard"(p timestamptz) RETURNS int AS $f$ BEGIN RETURN 1; END $f$;',
      'DO $d$ BEGIN EXECUTE $x$Create Or Replace Function fn_ca_record_break_scorecard(p timestamptz) returns int as $b$ begin return 1; end $b$$x$; END $d$;',
    ])
      expect(defines(sql, RECORDER), sql).toBe(true);
    for (const sql of [
      '-- CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard(p timestamptz)',
      '/* create function public.fn_ca_record_break_scorecard( */ select 1;',
      'GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(timestamptz) TO service_role;',
    ])
      expect(defines(sql, RECORDER), sql).toBe(false);
  });

  it('both directions: the pins fail on the pre-fix recorder and on a newer lowercase copy of it, and hold on the fix in any case', () => {
    const pre = bodyOf(read(PRE_FIX), RECORDER);
    expect(recorderHolds(pre).length).toBeGreaterThan(0);
    expect(recorderHolds(bodyOf(read(FIX), RECORDER))).toEqual([]);
    expect(recorderHolds(lowerCode(bodyOf(read(FIX), RECORDER)))).toEqual([]);
    expect(recoveryHolds(lowerCode(bodyOf(read(FIX), RECOVERED)))).toEqual([]);
    // A later migration that redefines the recorder from the pre-image, in lowercase, governs - and fails.
    const copy = read(PRE_FIX).toLowerCase();
    const [file, body] = governing(RECORDER, [
      ...repo(),
      ['29990101000000_a_later_copy.sql', copy],
    ]);
    expect(file).toBe('29990101000000_a_later_copy.sql');
    expect(recorderHolds(body)).toContain(
      "the hourly job's pass (no p_end) calls the recovery inside its own handler"
    );
    // And a recovery that reads an episode from the scorecard again, as the first version did, fails.
    const episode = bodyOf(read(FIX), RECOVERED).replace(
      'FROM public.notifications n',
      'FROM public.notifications n JOIN public.ca_break_scorecards s ON true'
    );
    expect(recoveryHolds(episode)).toContain(
      'what is owed never depends on the verdict history (a re-score or backfill cannot hide a fault)'
    );
    // The second review's shapes: no lock_timeout, a personal row counted for the
    // owner account, and no classifier check before his recovery is written.
    const fix = bodyOf(read(FIX), RECOVERED);
    expect(recoveryHolds(fix.replace(/SET lock_timeout TO '5s'\n/, ''))).toContain(
      "a lock wait on the recovery path gives up (lock_timeout, caught) before the job's statement timeout"
    );
    expect(
      recoveryHolds(fix.replace('NOT CASE WHEN f0.route = c_owner', 'NOT CASE WHEN false'))
    ).toContain(
      'for the owner account only a resolved receipt addressed to the task recovers a fault'
    );
    expect(recoveryHolds(fix.replace('IF r.route = c_owner', 'IF false'))).toContain(
      "the owner account's recovery is written only when the classifier files it with the task"
    );
  });
});
