/**
 * ===========================================================================
 *  LAW: THE HAND PRUNE RESUMES WHERE IT LEFT OFF
 * ===========================================================================
 *
 * sp_prune_hand_history runs every 30 seconds with a 20 second budget. Its
 * candidate set is ORDER BY created_at LIMIT 250, so each round started at the
 * OLDEST row and walked forward through every row older than the retention
 * boundary - including the ~219,000 that a guard retains on purpose (a cash
 * hand with no provenance receipt, a hand of an unsettled tournament) and
 * whose answer cannot change between rounds. Measured on production
 * 2026-10-26 (EXPLAIN ANALYZE of the candidate query): "Rows Removed by
 * Filter: 219000 ... Execution Time: 7218.996 ms" to find 250 rows. The pass
 * ran 90.4% of the day, median 30.1 s a run against its 30 s timeout, 221
 * hours of database time since 2026-10-04 (7.0% of everything the database
 * did), and was six hours behind its own boundary.
 *
 * Migration 20261026133101 gives the pass a cursor
 * (smarter_private.hand_history_prune_cursor): the scan starts after the
 * newest created_at the pass has examined, a round that finds nothing between
 * the cursor and the boundary parks the cursor at the boundary, and a pass
 * lasts at most 60 minutes before the next run starts over from the oldest
 * row. A retained row is evaluated once per pass instead of once per round;
 * a hand whose guard releases is pruned within the hour. WHICH hands prune is
 * unchanged: the guards, the owner's eight-day config row, the batch cap,
 * FOR UPDATE SKIP LOCKED and the disposals are the installed ones, and the
 * cursor is written in the same transaction as the deletes.
 *
 * WHY A LAW. A later agent rewriting the pruner in full (the 2026-10-12 shape)
 * will start from the newest CREATE OR REPLACE in the corpus, which predates
 * the cursor, and the re-scan comes back silently: nothing fails, the job just
 * takes 90% of the day again. This pins the cursor's three parts in the
 * installing migration and requires every later redefinition to keep them.
 */
import { describe, it, expect } from 'vitest';
import { migrationCorpus, type MigrationFile } from './helpers/migrationCorpus';

const INSTALLS = '20261026133101';
const LOWER_BOUND = "hh.created_at>COALESCE(v_resume_after,''-infinity''::timestamptz)";
const LOWER_BOUND_IN_DEFINITION = "hh.created_at>COALESCE(v_resume_after,'-infinity'::timestamptz)";

const codeOnly = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

const version = (m: MigrationFile): string => m.name.slice(0, m.name.indexOf('_'));

/** A literal digest comparison only observes the installed pruner (same test as
 * a-retention-pass-never-deletes-a-recorded-earning-source). */
const redefinesThePruner = (m: MigrationFile): boolean =>
  /sp_prune_hand_history/.test(
    codeOnly(m.sql).replace(
      /md5\s*\(\s*pg_get_functiondef\s*\(\s*'public\.sp_prune_hand_history\(integer\)'\s*::\s*regprocedure\s*\)\s*\)\s+IS\s+DISTINCT\s+FROM\s+'[a-f0-9]{32}'/gi,
      ''
    )
  );

describe('the hand prune resumes where it left off', () => {
  const installer = migrationCorpus().find((m) => m.name.startsWith(INSTALLS));

  it('the installing migration is in the repo and pins the pruner it patched', () => {
    expect(installer, `migration ${INSTALLS} must be recorded in supabase/migrations`).toBeTruthy();
    const sql = installer!.sql;
    // the preimage it patched, so the splice cannot land on a different body
    expect(sql).toContain(
      "md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))"
    );
    expect(sql).toContain("IS DISTINCT FROM '3f42f51cbc26e7af58fe54ed1fa11a44'");
    // every anchor must be unique before it is spliced
    expect(sql).toContain('PRUNER_ANCHOR_NOT_UNIQUE');
    // and the result is checked before COMMIT
    expect(sql).toContain('PRUNER_CURSOR_NOT_INSTALLED');
  });

  it('the scan is bounded below by the cursor, right beside the retention boundary', () => {
    const sql = installer!.sql;
    // the lower bound is spliced immediately after the upper (age) bound, so
    // both sit on idx_hand_history_created
    expect(sql).toContain("E'         AND hh.created_at<now()-v_window\\n'");
    expect(sql).toContain(LOWER_BOUND);
    // the candidate set carries created_at out so the round knows how far it got
    expect(sql).toContain('max(created_at)');
    expect(sql).toContain('INTO v_doomed,v_keepers,v_reached FROM classified;');
  });

  it('a pass is bounded: it starts over within the hour, so a released guard is not a permanent skip', () => {
    const sql = installer!.sql;
    expect(sql).toContain("v_pass_length constant interval := interval ''60 minutes'';");
    expect(sql).toMatch(
      /v_pass_started<clock_timestamp\(\)-v_pass_length THEN\\n' \|\|\s*E'\s+v_resume_after := NULL;/
    );
  });

  it('an empty round parks the cursor at the boundary and advances it only to rows actually examined', () => {
    const sql = installer!.sql;
    expect(sql).toContain('v_resume_after := now()-v_window;');
    expect(sql).toContain(
      "v_resume_after := GREATEST(COALESCE(v_resume_after,''-infinity''::timestamptz),v_reached);"
    );
  });

  it('the cursor is persisted in the same transaction as the deletes, before RETURN', () => {
    const sql = installer!.sql;
    expect(sql).toMatch(
      /UPDATE smarter_private\.hand_history_prune_cursor\\n' \|\|\s*E'\s+SET resume_after=v_resume_after,pass_started_at=v_pass_started,updated_at=clock_timestamp\(\)\\n' \|\|\s*E'\s+WHERE singleton;\\n' \|\|\s*a_return/
    );
  });

  it('what prunes is unchanged: the owner config row, the guards and the lock mode are required to survive', () => {
    const sql = codeOnly(installer!.sql);
    for (const kept of [
      'horse_retention_days',
      'FOR UPDATE SKIP LOCKED',
      'f06_hand_cards_unresolved',
      'original_inventory_restoration_cases',
    ])
      expect(sql, `the migration must require ${kept} to survive`).toContain(kept);
    // and it never gives the attribution DELETE back (10.5: the rakeback basis)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+(?:public\.)?rake_attributions/i);
  });

  it('the cursor table is private to the job: RLS on, no browser or service role grant, no foreign key', () => {
    const sql = codeOnly(installer!.sql);
    expect(sql).toContain('CREATE TABLE smarter_private.hand_history_prune_cursor(');
    expect(sql).toContain(
      'ALTER TABLE smarter_private.hand_history_prune_cursor ENABLE ROW LEVEL SECURITY;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON smarter_private.hand_history_prune_cursor FROM PUBLIC,anon,authenticated,service_role;'
    );
    // a cursor table never carries a foreign key to a hot table (DDL policy 7)
    expect(sql).not.toMatch(/REFERENCES\s+public\./i);
  });

  it('no later redefinition of the pruner drops the cursor', () => {
    const offenders = migrationCorpus()
      .filter((m) => version(m) > INSTALLS)
      .filter(redefinesThePruner)
      .filter((m) => {
        const code = codeOnly(m.sql);
        // a full CREATE OR REPLACE must carry the bound as it appears in the
        // definition; a spliced patch must either carry it literally or leave
        // the installed body (which has it) alone
        const rewritesBody =
          /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?sp_prune_hand_history/i.test(code);
        if (!rewritesBody) return false;
        const tupleCursor =
          code.includes('WITH scanned AS MATERIALIZED') &&
          code.includes("hh.created_at>=COALESCE(v_resume_after,'-infinity'::timestamptz)") &&
          code.includes('(hh.created_at,hh.id)>(v_resume_after,v_resume_id)') &&
          code.includes('resume_id=v_resume_id');
        return (
          !tupleCursor && !code.includes(LOWER_BOUND_IN_DEFINITION) && !code.includes(LOWER_BOUND)
        );
      })
      .map((m) => m.name);
    expect(
      offenders,
      'These migrations rewrite sp_prune_hand_history without the resume cursor ' +
        `(${LOWER_BOUND_IN_DEFINITION}). Without it every 30-second round re-evaluates ` +
        'every retained row from the oldest forward: 219,000 rows and 7.2 s per round, ' +
        '90% of the day, measured 2026-10-26. Keep the cursor, or move the pin.'
    ).toEqual([]);
  });
});
