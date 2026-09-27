import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260926165100_create_club_replay_precedes_mutable_admission.sql'
  ),
  'utf8'
);

describe('committed Create Club requests replay before mutable admission', () => {
  it('pins the current body and moves exactly one receipt lookup ahead of rollout', () => {
    expect(sql).toContain("md5(v_old) <> 'c7c3d085e4cbd08af4f46974eca7ac3b'");
    const replacement = sql.slice(
      sql.indexOf('$after_request$'),
      sql.lastIndexOf('$after_request$')
    );
    expect(replacement.indexOf('fn_club_membership_lock(v_uid)')).toBeLessThan(
      replacement.indexOf('SELECT club_id INTO v_existing')
    );
    expect(replacement.indexOf('SELECT club_id INTO v_existing')).toBeLessThan(
      replacement.indexOf('fn_club_creation_open(v_uid)')
    );
    expect(sql).toContain('CREATE_CLUB_REPLAY_PATCH_DID_NOT_PRODUCE_ONE_EARLY_LOOKUP');
  });

  it('keeps the private implementation private', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_create_club_atomic_membership_impl\([\s\S]*FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).not.toMatch(/GRANT EXECUTE[\s\S]*authenticated/);
  });
});
