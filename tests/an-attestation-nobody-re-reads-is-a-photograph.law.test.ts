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
    // CLAUDE.md 10.86 rule 3. The step must key off the anchor step itself, so
    // a failure in the commit step afterwards cannot open a tampering issue.
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
