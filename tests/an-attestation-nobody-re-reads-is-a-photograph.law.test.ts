/**
 * AN ATTESTATION NOBODY RE-READS IS A PHOTOGRAPH, NOT A GUARD.
 *
 * `ca_ledger_day_manifests` hashes each day of `chip_ledger`. Roadmap 9.2 says
 * the sha proves nothing because it is stored in the same database as the
 * journal it hashes. Measuring it on 2026-09-07 found something sharper: the
 * attestation for **2026-08-31 had been wrong for six days and nothing had
 * noticed**. Seven of the eight retained days matched to the row; that one said
 * 56,893 rows against 56,327 present.
 *
 * The journal was fine. 566 legs were removed at 2026-09-01 14:34 through the
 * sanctioned maintenance path (`ca_ledger_mutation_log`, reason
 * `dan-2026-09-01-deep-stack-clean-funding-redo`), ten hours after the manifest
 * for that day was written. What failed was everything after:
 * `fn_ca_ledger_day_manifest` only ever examines `CURRENT_DATE - 1`, nothing
 * restates a manifest when history legitimately changes, and
 * `ca_drift_incidents` had recorded zero manifest mismatches ever.
 *
 * What this pins:
 *
 *   1. every retained day is re-read, not just yesterday;
 *   2. the verification uses the SAME hash expression as the writer, or the two
 *      would disagree about a journal neither had touched;
 *   3. a restatement is a record with the old value kept, never a silent edit,
 *      and the migration refuses to restate a difference the mutation log
 *      cannot account for;
 *   4. the daily job still writes yesterday's manifest as well as verifying;
 *   5. the anchor file is append-only and FAILS on an unexplained change,
 *      rather than quietly rewriting itself to match the database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .find((f) => f.includes('every_attested_day_is_re_read'));
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';

const anchorScript = join(ROOT, 'scripts', 'ci', 'anchor-ledger-days.mjs');
const anchorFile = join(ROOT, 'docs', 'attestation', 'chip-ledger-days.tsv');
const workflow = join(ROOT, '.github', 'workflows', 'schema-manifest-refresh.yml');

/** The exact hash expression both the writer and the verifier must use. */
const HASH_FINGERPRINT = "extract(epoch from created_at)::text || '|' || COALESCE(row_hash,'')";

describe('an attestation nobody re-reads is a photograph, not a guard', () => {
  it('the migration exists', () => {
    expect(file, 'the verify-all migration must not be deleted').toBeTruthy();
  });

  it('every retained day is re-read, not just yesterday', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_verify_all');
    expect(sql).toMatch(
      /FOR r IN SELECT day, row_count, sha256 FROM public\.ca_ledger_day_manifests/
    );
    expect(sql).toMatch(/VERIFY FAILED: only % day\(s\) were checked/);
  });

  it('the verifier hashes exactly what the writer hashes', () => {
    expect(sql).toContain(HASH_FINGERPRINT);
    expect(sql).toMatch(/ORDER BY created_at, id/);
  });

  it('a restatement keeps the old value and is refused if unaccounted for', () => {
    expect(sql).toContain('ca_ledger_day_manifest_restatements');
    expect(sql).toMatch(/old_sha256/);
    expect(sql).toMatch(
      /ABORT: the manifest is short by % rows but the mutation log accounts for %/
    );
  });

  it('extending the daily job did not drop the manifest write it already did', () => {
    expect(sql).toMatch(/VERIFY FAILED: the daily job does not call the all-days verification/);
    expect(sql).toMatch(
      /VERIFY FAILED: extending the job dropped the manifest write it already did/
    );
  });

  it('no new scheduled trigger was added anywhere', () => {
    // CLAUDE.md 10.85: scheduled work never goes on a new trigger without cause.
    // The verification rides the cron that already existed; the anchor rides a
    // workflow schedule that already existed.
    expect(sql).toContain('cron.alter_job');
    expect(sql).not.toMatch(/cron\.schedule\s*\(/);
    const wf = readFileSync(workflow, 'utf8');
    const crons = [...wf.matchAll(/- cron:/g)].length;
    expect(crons, 'the anchor must ride the existing schedule, not add one').toBeLessThanOrEqual(2);
  });

  it('the anchor exists, is append-only, and fails rather than rewriting itself', () => {
    expect(existsSync(anchorScript), 'the anchor script must exist').toBe(true);
    const js = readFileSync(anchorScript, 'utf8');
    expect(js).toMatch(/A DAY THAT IS ALREADY ANCHORED NOW HASHES DIFFERENTLY/);
    expect(js).toMatch(/process\.exit\(1\)/);
    expect(js).toMatch(/Do not "fix" this file/);
    // it must never coerce an unreadable answer into an empty one
    expect(js).toMatch(/refusing to treat that as "no rows"/);
  });

  it('the anchored file carries a line per day and a header', () => {
    expect(existsSync(anchorFile), 'the anchor file must exist').toBe(true);
    const lines = readFileSync(anchorFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines[0].startsWith('#')).toBe(true);
    for (const l of lines.slice(1)) {
      const cols = l.split('\t');
      expect(cols).toHaveLength(7);
      expect(cols[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(cols[5]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

/**
 * AND THE ATTESTATION COVERS THE JOURNAL, NOT THE LAST EIGHT DAYS.
 *
 * The deep dive over the work above, the same day. Both halves of the guard
 * answered confidently about a scope nobody had stated:
 *
 *   1. `verify_all` iterated the MANIFESTS, so a day of real money movement
 *      with no manifest was not an unchecked day to it - it was not a day at
 *      all. Measured: 35 days of legs before today, 8 attested, and the
 *      remaining 27 (2026-03-19..2026-08-29, 176,140 legs, 8.8% of the
 *      journal) outside every guard on this platform, while the function
 *      returned {"checked": 8, "drifted": 0}.
 *   2. It opened one sequential scan per day - 9,463 ms for eight days,
 *      1.18 s each - so its cost was O(days x journal) against a journal Dan
 *      ruled is kept for ever. That does not fail loudly. It gets slower until
 *      something kills it, and a verification that stops running looks exactly
 *      like one that finds nothing.
 *   3. The anchor's failure - "a day already anchored now hashes differently
 *      and nothing explains it", the strongest signal in the whole system -
 *      had no reader of its own. It reached a person only via
 *      `check-main-is-green` as "Schema Manifest Refresh red", which matches on
 *      the WORKFLOW name, so any open issue naming that workflow masked it
 *      entirely. The definer-exposure job in the same file already did this
 *      correctly.
 *
 * What this pins: coverage follows the journal, the recompute is one pass, the
 * answer carries what it could not check, and the alarm has a named reader.
 */
describe('the attestation covers the journal, not the last eight days', () => {
  const cover = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .find((f) => f.includes('the_attestation_covers_the_journal'));
  const csql = cover ? readFileSync(join(MIGRATIONS, cover), 'utf8') : '';
  const wf = readFileSync(workflow, 'utf8');

  it('the migration exists', () => {
    expect(cover, 'the coverage migration must not be deleted').toBeTruthy();
  });

  it('coverage follows the journal, not the date the cron started', () => {
    expect(csql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_backfill');
    // Finished days only: a partial day attested today disagrees with itself at midnight.
    expect(csql).toMatch(/WHERE created_at < CURRENT_DATE/);
    expect(csql).toMatch(
      /VERIFY FAILED: % finished day\(s\) still carry no manifest after the backfill/
    );
  });

  it('the backfill adds no third copy of the hash expression', () => {
    // It calls the writer. Two places know how to hash a day, and the
    // migration re-proves from the catalogue that those two still agree.
    expect(csql).toMatch(/v_res\s*:=\s*public\.fn_ca_ledger_day_manifest\(r\.day\)/);
    expect(csql).toMatch(
      /VERIFY FAILED: the writer and the verifier no longer hash the same thing/
    );
  });

  it('the recompute is one pass, so its cost stops multiplying by the days retained', () => {
    const body = csql.slice(
      csql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_verify_all')
    );
    expect(body).toMatch(/WITH actual AS \(/);
    expect(body).toMatch(/GROUP BY 1/);
    // Both directions are failures: a day whose rows changed, and a manifest
    // whose day has lost all its rows.
    expect(body).toMatch(/FULL JOIN public\.ca_ledger_day_manifests/);
    // The old shape - one scan per manifest row - must not come back.
    expect(body).not.toMatch(
      /FOR r IN SELECT day, row_count, sha256 FROM public\.ca_ledger_day_manifests/
    );
  });

  it('the answer carries what it could NOT check', () => {
    expect(csql).toMatch(/'unattested', v_unattested/);
    expect(csql).toMatch(/'unattested_days', v_missing/);
    expect(csql).toContain('manifest-unattested-days');
    expect(csql).toMatch(/VERIFY FAILED: the verifier answer carries no coverage/);
  });

  it('the daily job backfills as well as writing and verifying, on the schedule it already had', () => {
    expect(csql).toContain('cron.alter_job');
    expect(csql).not.toMatch(/cron\.schedule\s*\(/);
    expect(csql).toMatch(/VERIFY FAILED: the daily job does not call the backfill/);
    expect(csql).toMatch(
      /VERIFY FAILED: extending the job dropped the verification it already did/
    );
    expect(csql).toMatch(
      /VERIFY FAILED: extending the job dropped the manifest write it already did/
    );
  });

  it('neither function is reachable from a browser', () => {
    expect(csql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_ledger_day_manifest_backfill\(date\) FROM PUBLIC, anon, authenticated/
    );
    expect(csql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_ledger_day_manifest_verify_all\(\) FROM PUBLIC, anon, authenticated/
    );
    expect(csql).toMatch(/VERIFY FAILED: a manifest function is executable by a browser role/);
  });

  it('the anchor alarm has a reader of its own, not a red job in a scheduled workflow', () => {
    // The alarm keys off the read-only comparison step itself.
    expect(wf).toMatch(/id: anchor/);
    expect(wf).toMatch(/Ledger attestation: an anchored day now hashes differently/);
    expect(wf).toMatch(/if: failure\(\) && steps\.anchor\.outcome == 'failure'/);
    expect(wf).toMatch(/gh issue create --repo "\$REPO" --title "\$TITLE"/);
    // and it closes itself, or the next person learns to ignore a stale alarm
    expect(wf).toMatch(/Close the alarm when the anchor agrees again/);
    // the log has to reach the reader; an issue with no evidence is a rumour
    expect(wf).toMatch(/tee \/tmp\/anchor-ledger-days\.log/);
  });

  it('the anchor still rides schedules that already existed', () => {
    const crons = [...wf.matchAll(/- cron:/g)].length;
    expect(crons, 'no new scheduled trigger (CLAUDE.md 10.85)').toBeLessThanOrEqual(2);
  });
});

/**
 * AND THE ATTESTATION RESTATES ITSELF, AND NEVER OUTGROWS ITS BUDGET.
 *
 * The deep dive over phase 6, the same evening (migration
 * `the_attestation_restates_itself_and_never_outgrows_its_budget`). Four more
 * of the same shape:
 *
 *   1. A sanctioned change to an attested day was still a detector plus a
 *      human: the verifier raised an incident at 04:25 and somebody had to
 *      hand-write a restatement, exactly as 2026-08-31 was fixed. Now the
 *      maintenance statement restates the day ITSELF, in its own transaction,
 *      through the writer; the manifest tables refuse a hand edit or a delete;
 *      and the guard writes the restatement row, so one exists by construction.
 *   2. The one-pass verifier was linear in a journal kept for ever: 53,513 ms
 *      under evening load against the cron role's 2-minute statement_timeout -
 *      about ten weeks from failing every night. chip_ledger had no index on
 *      created_at alone (a per-day read was 30,124 ms for 24,107 legs). Now it
 *      does, and the verifier re-reads days on a rotation under a wall-clock
 *      budget, stamping last_checked_at, with `oldest_check_age_days` in the
 *      answer and a warning past 30 days.
 *   3. Every day boundary was evaluated in the caller's TimeZone. Pinned UTC.
 *   4. The old anchor append step tried to mutate source from a scheduled
 *      workflow. The audit now compares disposable output and refuses drift;
 *      reviewed source changes remain the only update path. The script's REST
 *      reads also gained a pagination guard (1,000-row cap).
 */
describe('the attestation restates itself, and never outgrows its budget', () => {
  const restate = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .find((f) => f.includes('the_attestation_restates_itself'));
  const rsql = restate ? readFileSync(join(MIGRATIONS, restate), 'utf8') : '';
  const wf = readFileSync(workflow, 'utf8');
  const js = readFileSync(anchorScript, 'utf8');

  it('the migration exists', () => {
    expect(restate, 'the restatement migration must not be deleted').toBeTruthy();
  });

  it('a sanctioned change to an attested day restates the manifest in the same transaction', () => {
    expect(rsql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_attested_day_is_restated');
    // statement-level, with transition tables, on both mutations the
    // maintenance path permits
    expect(rsql).toMatch(
      /AFTER DELETE ON public\.chip_ledger\s+REFERENCING OLD TABLE AS old_rows\s+FOR EACH STATEMENT/
    );
    expect(rsql).toMatch(
      /AFTER UPDATE ON public\.chip_ledger\s+REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows\s+FOR EACH STATEMENT/
    );
    // through the writer, with the maintenance reason - no third hash copy
    expect(rsql).toMatch(/fn_ca_ledger_day_manifest\(r\.day, 'maintenance:' \|\| v_reason\)/);
    // and it is PROVED in the migration by a rolled-back probe
    expect(rsql).toMatch(/VERIFY FAILED: a sanctioned DELETE on % left its manifest unchanged/);
    expect(rsql).toMatch(/VERIFY FAILED: the restatement for % was not written by the guard/);
    expect(rsql).toMatch(/VERIFY FAILED: the probe restatement survived the rollback/);
  });

  it('a manifest is restated, never edited, and a restatement is never edited', () => {
    expect(rsql).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_manifest_is_restated_not_edited'
    );
    expect(rsql).toMatch(/BEFORE UPDATE OR DELETE ON public\.ca_ledger_day_manifests/);
    expect(rsql).toMatch(/BEFORE UPDATE OR DELETE ON public\.ca_ledger_day_manifest_restatements/);
    // the guard writes the restatement row itself
    expect(rsql).toMatch(
      /INSERT INTO public\.ca_ledger_day_manifest_restatements[\s\S]*VALUES\s*\(OLD\.day, OLD\.row_count, NEW\.row_count, OLD\.sha256, NEW\.sha256, v_reason/
    );
    // an attested day cannot be emptied
    expect(rsql).toMatch(/an attested day cannot be emptied/);
    expect(rsql).toMatch(/VERIFY FAILED: a manifest sha was edited by hand and nothing refused it/);
    expect(rsql).toMatch(/VERIFY FAILED: a manifest was deleted and nothing refused it/);
  });

  it('the per-day read is an index range, and the days of the journal are a loose index scan', () => {
    expect(rsql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_chip_ledger_created_at\s+ON public\.chip_ledger USING btree \(created_at\)/
    );
    expect(rsql).toMatch(/VERIFY FAILED: idx_chip_ledger_created_at is missing or invalid/);
    expect(rsql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_ledger_finished_days');
    expect(rsql).toMatch(/WITH RECURSIVE d AS/);
    // the backfill and the verifier share that one definition of "which days"
    const backfill = rsql.slice(rsql.indexOf('FUNCTION public.fn_ca_ledger_day_manifest_backfill'));
    expect(backfill).toMatch(/FROM public\.fn_ca_ledger_finished_days\(\) d\(day\)/);
    expect(backfill).not.toMatch(/SELECT DISTINCT created_at::date/);
  });

  it('the verifier works under a budget and its answer says how stale the oldest re-read is', () => {
    const body = rsql.slice(
      rsql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_verify_all')
    );
    expect(body).toMatch(/p_budget_ms integer DEFAULT 60000/);
    expect(body).toMatch(/ORDER BY m\.last_checked_at ASC NULLS FIRST, m\.day ASC/);
    expect(body).toMatch(/> p_budget_ms THEN\s+v_deferred := v_deferred \+ 1;/);
    expect(body).toMatch(/SET last_checked_at = now\(\) WHERE day = r\.day/);
    expect(body).toMatch(/'deferred', v_deferred/);
    expect(body).toMatch(/'oldest_check_age_days'/);
    expect(body).toContain('manifest-rotation-stale');
    // the whole journal is NOT re-read every night any more, on purpose, and
    // the old full-table pass must not come back as the default
    expect(body).not.toMatch(/WITH actual AS \(/);
    expect(body).not.toMatch(/FULL JOIN public\.ca_ledger_day_manifests/);
    // unattested days are still counted every run
    expect(body).toContain('manifest-unattested-days');
    expect(rsql).toMatch(/VERIFY FAILED: checked % \+ deferred % <> % manifests/);
  });

  it('the writer still hashes exactly what the verifier hashes, re-proved from the catalogue', () => {
    const writer = rsql.slice(rsql.indexOf('CREATE FUNCTION public.fn_ca_ledger_day_manifest('));
    expect(writer).toContain(HASH_FINGERPRINT);
    expect(rsql).toMatch(
      /VERIFY FAILED: the writer and the verifier no longer hash the same thing/
    );
    // the (date) overload is gone, or the cron call is ambiguous
    expect(rsql).toMatch(/DROP FUNCTION IF EXISTS public\.fn_ca_ledger_day_manifest\(date\);/);
    expect(rsql).toMatch(/VERIFY FAILED: % overloads of fn_ca_ledger_day_manifest \(want 1\)/);
  });

  it('a day is a UTC day, pinned on every function that decides one', () => {
    const pins = [...rsql.matchAll(/SET timezone = 'UTC'/g)].length;
    expect(pins).toBeGreaterThanOrEqual(6);
    expect(rsql).toMatch(/VERIFY FAILED: % does not pin timezone=UTC/);
  });

  it('the daily job is unchanged in shape and schedule', () => {
    expect(rsql).toContain('cron.alter_job');
    expect(rsql).not.toMatch(/cron\.schedule\s*\(/);
    expect(rsql).toMatch(/VERIFY FAILED: the daily job does not call the backfill/);
    expect(rsql).toMatch(
      /VERIFY FAILED: extending the job dropped the verification it already did/
    );
    expect(rsql).toMatch(
      /VERIFY FAILED: extending the job dropped the manifest write it already did/
    );
  });

  it('the anchor audit cannot write source or open a pull request', () => {
    const job = wf.slice(wf.indexOf('anchor-ledger-days:'), wf.indexOf('second-writer:'));
    expect(job).toMatch(/git diff --exit-code -- docs\/attestation\//);
    expect(job).not.toMatch(/actions\/create-github-app-token/);
    expect(job).not.toMatch(/\bgit\s+(?:add|commit|push)\b/);
    expect(job).not.toMatch(/\bgh\s+pr\s+(?:create|merge)\b/);
  });

  it('the anchor refuses a truncated answer from PostgREST', () => {
    expect(js).toMatch(/Prefer: 'count=exact'/);
    expect(js).toMatch(/content-range/);
    expect(js).toMatch(/the response was truncated/);
    expect(js).toMatch(/refusing to guess whether the answer is complete/);
  });
});
