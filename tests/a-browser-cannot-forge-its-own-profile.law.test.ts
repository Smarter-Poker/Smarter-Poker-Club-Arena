/**
 * LAW - A BROWSER CANNOT DELETE OR FORGE ITS OWN PROFILE, AND dblink IS NOT ON THE DATA API
 *
 * Launch audit 2026-10-05. Read on production before the fix:
 *
 *   profiles ACL           authenticated=adxtm  (table-level INSERT and DELETE)
 *   profiles_delete        USING (auth.uid() = id)
 *   profiles_insert_self   WITH CHECK (auth.uid() = id)
 *   privileged-column guard: BEFORE UPDATE only
 *
 * so a signed-in account could DELETE its own row and INSERT it again with
 * role = 'god' and a diamond balance; fn_is_platform_admin() reads that
 * column. Migration 20260827214020 tried to close it with a column-level
 * REVOKE INSERT, which does nothing under a table-level grant.
 *
 * Separately, dblink sat in the exposed `public` schema, executable by `anon`
 * through /rest/v1/rpc.
 *
 * The unit suite has no database, so this pins what it can: the closing
 * migrations exist, close the doors themselves, assert their own effect, and
 * no later migration hands the capability back. Live behaviour is read back
 * at install time and recorded in docs/changelog.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');
/* Statements only: a migration's prose may quote the thing it forbids. */
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const PROFILE = '20261005220434_a_browser_cannot_delete_or_forge_its_own_profile.sql';
const DBLINK = '20261005221203_dblink_leaves_the_schema_the_data_api_serves.sql';
const later = (than: string) => files.filter((f) => f > than);

describe('LAW: a browser cannot delete or forge its own profile', () => {
  it('the closing migration exists', () => {
    expect(files, `${PROFILE} is missing - the escalation is open again`).toContain(PROFILE);
  });

  it('takes DELETE on profiles away from both browser roles', () => {
    expect(code(read(PROFILE))).toMatch(
      /REVOKE DELETE ON public\.profiles FROM authenticated, anon;/
    );
  });

  it('guards the INSERT itself, for every privileged column, in a browser context only', () => {
    const sql = code(read(PROFILE));
    expect(sql).toMatch(
      /CREATE TRIGGER trg_guard_profile_privileged_columns_on_insert\s+BEFORE INSERT ON public\.profiles\s+FOR EACH ROW/
    );
    for (const column of [
      'role',
      'is_admin',
      'is_vip',
      'vip_tier',
      'vip_expires_at',
      'diamonds',
      'diamond_balance',
      'diamond_multiplier',
      'kyc_status',
      'age_verified',
      'mfa_required',
      'email_verified',
      'phone_verified',
    ]) {
      expect(sql, `the insert guard does not judge ${column}`).toContain(`NEW.${column}`);
    }
    /* Server-side creators (handle_new_user, the horse seeders, service-role
       routes) must pass untouched, or signup itself breaks. */
    expect(sql).toContain('public.fn_is_service_context() IS TRUE');
    expect(sql).toContain("NOT IN ('anon', 'authenticated')");
    expect(sql).toContain("ERRCODE = '42501'");
  });

  it("takes the KYC, age, MFA and farming flags out of the player's own hands", () => {
    const sql = code(read(PROFILE));
    const revoke = sql.slice(sql.indexOf('REVOKE UPDATE ('));
    for (const column of [
      'kyc_status',
      'kyc_completed_at',
      'kyc_inquiry_id',
      'kyc_provider',
      'kyc_rejection_reason',
      'age_verified',
      'age_verified_at',
      'mfa_required',
      'is_farming_flagged',
    ]) {
      expect(revoke.slice(0, revoke.indexOf(';')), column).toContain(column);
    }
  });

  it('asserts its own effect rather than describing it', () => {
    const sql = code(read(PROFILE));
    expect(sql).toContain("has_table_privilege('authenticated', 'public.profiles', 'DELETE')");
    expect(sql).toContain("has_column_privilege('authenticated', 'public.profiles', c, 'UPDATE')");
    expect(sql).toContain('the profile insert guard is not armed');
    expect(sql.match(/RAISE EXCEPTION/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('no later migration hands the capability back', () => {
    for (const f of later(PROFILE)) {
      const sql = code(read(f));
      expect(sql, `${f} grants DELETE or ALL on profiles to a browser role`).not.toMatch(
        /GRANT\s+(?:[A-Z,\s]*\bDELETE\b[A-Z,\s]*|ALL(?:\s+PRIVILEGES)?)\s+ON\s+(?:TABLE\s+)?public\.profiles\s+TO\s+[^;]*\b(?:authenticated|anon|PUBLIC)\b/i
      );
      expect(sql, `${f} removes the profile insert guard`).not.toMatch(
        /DROP TRIGGER[^;]*trg_guard_profile_privileged_columns_on_insert/i
      );
      expect(sql, `${f} disables the profile insert guard`).not.toMatch(
        /DISABLE TRIGGER[^;]*trg_guard_profile_privileged_columns_on_insert/i
      );
    }
  });
});

describe('LAW: dblink is not served by the Data API', () => {
  it('the closing migration exists', () => {
    expect(files, `${DBLINK} is missing - dblink is back on /rest/v1/rpc`).toContain(DBLINK);
  });

  it('moves the extension out of the exposed schema and re-points its one caller in the same transaction', () => {
    const sql = code(read(DBLINK));
    expect(sql).toContain('ALTER EXTENSION dblink SET SCHEMA extensions;');
    expect(sql).toContain("replace(v_def, 'public.dblink', 'extensions.dblink')");
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('ALTER EXTENSION dblink'));
    expect(sql.lastIndexOf('COMMIT;')).toBeGreaterThan(sql.indexOf('EXECUTE v_new'));
  });

  it('asserts its own effect rather than describing it', () => {
    const sql = code(read(DBLINK));
    expect(sql).toContain('dblink functions are still in the public schema');
    expect(sql).toContain('fn_ca_ledger_refusal_record still names public.dblink');
  });

  it('no later migration brings dblink back into public', () => {
    for (const f of later(DBLINK)) {
      const sql = code(read(f));
      expect(sql, `${f} moves or creates dblink in public`).not.toMatch(
        /(?:ALTER EXTENSION\s+dblink\s+SET SCHEMA\s+public|CREATE EXTENSION[^;]*\bdblink\b(?![^;]*SCHEMA\s+extensions))/i
      );
      expect(sql, `${f} calls public.dblink`).not.toMatch(/\bpublic\.dblink/i);
    }
  });
});
