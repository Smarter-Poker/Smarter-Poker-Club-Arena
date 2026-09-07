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
