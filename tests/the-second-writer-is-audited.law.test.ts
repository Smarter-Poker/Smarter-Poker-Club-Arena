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
    // balanced braces: nested object keys never leak into the parameter list
    expect(script).toMatch(/function objectBody\(/);
    expect(script).toMatch(/function topLevelKeys\(/);
    // a written exemption is reported, never counted as fine
    expect(script).toMatch(/second-writer-exempt:/);
    expect(script).toMatch(/exempt by annotation/);
    // and the scanner is importable without running the audit
    expect(script).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    expect(script).toMatch(/refusing to treat an unreadable answer as a clean one/);
    expect(script).toMatch(/the answer carries no coverage/);
    expect(script).toMatch(/sent \$\{sent\.length\} calls, the database counted/);
    expect(script).toMatch(/direct_balance_write/);
    expect(script).toMatch(/rest\/v1\/rpc\/fn_ca_second_writer_check/);
    expect(script).toMatch(/errors\.length > 0 \|\| allDirect\.length > 0/);
    // severity is the database's word: a non-money mismatch is a warning there
    const money = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .find((f) => f.includes('the_second_writer_check_speaks_about_money_doors'));
    expect(money, 'the money-scoped severity migration must not be deleted').toBeTruthy();
    const msql = readFileSync(join(MIGRATIONS, money!), 'utf8');
    expect(msql).toMatch(/v_money := \(v_status IS NOT NULL\) OR COALESCE\(v_writes, false\);/);
    expect(msql).toMatch(/'kind', 'closed_door', 'severity', 'error', 'money', true/);
    expect(msql).toMatch(/VERIFY FAILED: a non-money mismatch is not a warning/);
    expect(msql).toMatch(/VERIFY FAILED: a money-door mismatch is not an error/);
    expect(script).toMatch(/process\.exit\(1\)/);
  });

  it('the check rides existing schedules with the App token and has a reader', () => {
    const job = wf.slice(wf.indexOf('second-writer:'), wf.indexOf('definer-exposure:'));
    expect(job).toMatch(/repository: Smarter-Poker\/Smarter-Poker-World-Hub/);
    expect(job).toMatch(/repositories: Smarter-Poker-World-Hub/);
    // the whole server side, not one directory (phase 7 deep dive)
    expect(job).toMatch(
      /node scripts\/ci\/audit-second-writer\.mjs --routes world-hub\/pages\/api --routes world-hub\/src\/lib --routes world-hub\/lib/
    );
    expect(job).toMatch(/sparse-checkout: \|\s+pages\/api\s+src\/lib\s+lib/);
    expect(job).toMatch(/Second writer: a World Hub route disagrees with the money-door register/);
    expect(job).toMatch(/if: failure\(\) && steps\.audit\.outcome == 'failure'/);
    expect(job).toMatch(/Close the alarm when both repos agree again/);
    const crons = [...wf.matchAll(/- cron:/g)].length;
    expect(crons, 'no new scheduled trigger (CLAUDE.md 10.85)').toBeLessThanOrEqual(2);
  });
});

/**
 * THE ROLE THE CALL RUNS AS (2026-09-19).
 *
 * Every EXECUTE verdict was asked of `service_role`, because almost every
 * World Hub route holds the service key. Five do not: they build a client from
 * the anon key and forward the caller's Authorization header, so the RPC runs
 * as `authenticated` and the door reads auth.uid().
 *
 * Measured over 1,159 files and 332 calls: 41 service-role, 5 user-scoped, 286
 * whose client is not resolvable from the call site. The wrong role was wrong
 * both ways.
 *
 *   FALSE POSITIVE  send_wallet_diamond_transfer is granted to authenticated
 *                   and deliberately not to service_role. The audit called a
 *                   working route "permission denied on every call". It was
 *                   the only error in the run and it kept Schema Integrity
 *                   Audit red.
 *   FALSE NEGATIVE  fn_mint_chips_from_diamonds and send_stream_gift are
 *                   approved money doors on user-scoped routes. The grant they
 *                   actually need is to authenticated, and nothing asked.
 *                   Revoking it would have broken the mint, green.
 *
 * The part that keeps this safe is the fallback. Unknown is service_role,
 * which is what all 332 calls were before, so this narrows nothing.
 */
describe('a user-scoped route is checked as the role it uses', () => {
  const roleFile = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .find((f) => f.includes('a_user_scoped_route_is_checked_as_the_role_it_uses'));
  const roleSql = roleFile ? readFileSync(join(MIGRATIONS, roleFile), 'utf8') : '';

  it('the migration exists and edits the live body with an asserted match count', () => {
    expect(roleFile, 'the role-aware migration must not be deleted').toBeTruthy();
    // ca_patch refuses rather than half-patching a body that has moved on.
    expect(roleSql).toContain('CREATE FUNCTION pg_temp.ca_patch(');
    expect([...roleSql.matchAll(/pg_temp\.ca_patch\('fn_ca_second_writer_check'/g)]).toHaveLength(
      4
    );
  });

  it('the privilege question names the role instead of one hard-coded role', () => {
    expect(roleSql).toContain("bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')),");
    expect(roleSql).toContain("bool_or(has_function_privilege(v_role, p.oid, 'EXECUTE')),");
    // And the finding says which role it asked about, because a permission
    // error pointing at the wrong role is what cost the last ten days.
    expect(roleSql).toContain("'kind', 'not_executable_by_' || v_role");
  });

  it('it fails closed: an unknown role is service_role, exactly as before', () => {
    expect(roleSql).toMatch(
      /v_role := c->>'role';[\s\S]{0,400}NOT IN \('service_role', 'authenticated'\)[\s\S]{0,200}v_role := 'service_role';/
    );
  });

  it('the migration proves both directions against the real call before it commits', () => {
    // One direction alone proves nothing: passing the user-scoped call is also
    // what a blanket "always true" would do.
    expect(roleSql).toContain('send_wallet_diamond_transfer');
    expect(roleSql).toMatch(/jsonb_set\(v_payload, '\{0,role\}', '"authenticated"'::jsonb\)/);
    expect(roleSql).toMatch(/failed: the user-scoped diamond transfer call still reports/);
    expect(roleSql).toMatch(/a call with no declared role must still be checked as service_role/);
  });

  it('the scanner reads which client the call was made on, structurally', () => {
    expect(script).toContain('export function clientRoleOf(source, receiver)');
    // Balanced brackets, not a fixed window: a client written over several
    // lines would otherwise lose its Authorization header and be downgraded.
    expect(script).toMatch(/objectBody\(source, m\.index \+ m\[0\]\.length - 1\)/);
    expect(script).toMatch(/SERVICE_ROLE\|serviceRole/);
    expect(script).toMatch(/ANON_KEY\|anonKey/);
    // And it travels with the call, all the way to the database.
    expect(script).toMatch(/role: clientRoleOf\(source, recv \? recv\[1\] : null\)/);
    expect(script).toMatch(
      /\.map\(\(\{ file, line, fn, keys, role \}\) => \(\{ file, line, fn, keys, role \}\)\)/
    );
  });

  it('the rpc pattern itself was not widened, because that is how a call stops being seen', () => {
    // The receiver is read backwards from the match. Folding it into the rpc
    // regex would silently drop every call whose receiver is an expression.
    expect(script).toContain(
      'const rpcRe = /\\.rpc\\(\\s*[\'"]([A-Za-z0-9_]+)[\'"]\\s*(,\\s*)?/g;'
    );
  });
});
