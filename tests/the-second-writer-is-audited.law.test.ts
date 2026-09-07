/**
 * THE SECOND WRITER IS AUDITED AGAINST THE REGISTER (phase 7, roadmap 9.6).
 *
 * Phase 5 registered every money door in the database. The World Hub, in
 * another repository, calls those doors by name over PostgREST, and nothing
 * had ever compared the two. The first comparison (2026-09-07) found two
 * routes calling doors closed four days earlier and three calls whose
 * parameter NAMES matched no live signature. What this pins:
 *
 *   1. fn_ca_second_writer_check exists, names every finding kind, and
 *      counts what it could NOT check;
 *   2. the generic doors carry an allowlist and are registered;
 *   3. scripts/ci/audit-second-writer.mjs scans the World Hub's routes, asks
 *      the register, refuses an empty directory or an unreadable answer, and
 *      fails on any error or direct balance write;
 *   4. the check runs on the workflow's existing schedules with the estate's
 *      App token, and its failure has a named reader.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .find((f) => f.includes('the_second_writer_is_audited_against_the_register'));
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';
/** increment_column's body alone - the header describes what it USED to do. */
const incr = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.increment_column('),
  sql.indexOf('REVOKE ALL ON FUNCTION public.increment_column')
);
const script = readFileSync(join(ROOT, 'scripts/ci/audit-second-writer.mjs'), 'utf8');
const wf = readFileSync(join(ROOT, '.github/workflows/schema-manifest-refresh.yml'), 'utf8');

describe('the second writer is audited against the register', () => {
  it('the migration exists', () => {
    expect(file, 'the second-writer migration must not be deleted').toBeTruthy();
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_second_writer_check(p_calls jsonb)'
    );
  });

  it('every finding kind is named, and coverage travels with the answer', () => {
    for (const k of [
      'missing_function',
      'closed_door',
      'not_executable_by_service_role',
      'signature_mismatch',
      'unregistered_writer',
    ]) {
      expect(sql).toContain(`'${k}'`);
    }
    expect(sql).toMatch(/'unchecked', v_unchecked/);
    expect(sql).toMatch(/VERIFY FAILED: the check miscounted its own coverage/);
    // PostgREST resolves overloads by NAMED parameters; the check must too
    expect(sql).toMatch(/v_keys <@ COALESCE\(p\.proargnames\[1:p\.pronargs\]/);
    expect(sql).toMatch(/a\.i <= p\.pronargs - p\.pronargdefaults/);
  });

  it('the generic doors carry an allowlist and are registered', () => {
    expect(incr).toMatch(/VALUES \('table_templates', 'use_count'\)/);
    expect(incr).not.toMatch(/EXCEPTION WHEN OTHERS THEN NULL/);
    expect(sql).toMatch(/\('increment_column', 'approved'/);
    expect(sql).toMatch(/\('fn_atomic_increment_field', 'approved'/);
    expect(sql).toMatch(/VERIFY FAILED: increment_column reached club_members\.chip_balance/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.increment_column\(text, text, uuid\) FROM PUBLIC, anon, authenticated;/
    );
  });

  it('the script refuses to call nothing clean, and fails on what it finds', () => {
    expect(script).toMatch(/holds no route files - refusing to call that clean/);
    expect(script).toMatch(/refusing to treat an unreadable answer as a clean one/);
    expect(script).toMatch(/the answer carries no coverage/);
    expect(script).toMatch(/sent \$\{allCalls\.length\} calls, the database counted/);
    expect(script).toMatch(/direct_balance_write/);
    expect(script).toMatch(/rest\/v1\/rpc\/fn_ca_second_writer_check/);
    expect(script).toMatch(/errors\.length > 0 \|\| allDirect\.length > 0/);
    expect(script).toMatch(/process\.exit\(1\)/);
  });

  it('the check rides existing schedules with the App token and has a reader', () => {
    const job = wf.slice(wf.indexOf('second-writer:'), wf.indexOf('definer-exposure:'));
    expect(job).toMatch(/repository: Smarter-Poker\/Smarter-Poker-World-Hub/);
    expect(job).toMatch(/repositories: Smarter-Poker-World-Hub/);
    expect(job).toMatch(
      /node scripts\/ci\/audit-second-writer\.mjs --routes world-hub\/pages\/api\/club-arena/
    );
    expect(job).toMatch(/Second writer: a World Hub route disagrees with the money-door register/);
    expect(job).toMatch(/if: failure\(\) && steps\.audit\.outcome == 'failure'/);
    expect(job).toMatch(/Close the alarm when both repos agree again/);
    const crons = [...wf.matchAll(/- cron:/g)].length;
    expect(crons, 'no new scheduled trigger (CLAUDE.md 10.85)').toBeLessThanOrEqual(2);
  });
});
