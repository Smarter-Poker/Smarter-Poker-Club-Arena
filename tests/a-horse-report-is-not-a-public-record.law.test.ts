/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW - A HORSE REPORT IS NOT A PUBLIC RECORD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE
 * OR USE A DEVELOPER TOOL AND FIND THIS OUT."
 *
 * The 2026-09-02 closure covered the column, the RPCs that return it and the
 * Realtime publication. A sweep of every relation and function a player may
 * read (2026-09-07) found three it did not reach, each measured as a real
 * non-staff player inside a rolled-back probe:
 *
 *   - `horse_bug_reports`: policy "Anyone can read bug reports" (USING true,
 *     role public) - 16,101 rows naming 202 horses, readable signed out.
 *   - `club_memberships`: a security_invoker view over club_members exposing
 *     `is_bot`, which is `is_horse` mirrored by trigger; a dead alias nothing
 *     reads.
 *   - `fn_club_union_join_blockers(club_id)`: returned `horse_count` and
 *     `horse_wallets` for any club to any authenticated caller, unguarded.
 *
 * The migration pinned here closes all three and asserts its own effect. This
 * law keeps the closing text present and keeps anyone from "restoring" the
 * public read policy, which is how it got there.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const MIG_DIR = join(root, 'supabase/migrations');
const CLOSER =
  '20260908021100_horse_reports_dead_alias_and_join_blockers_are_not_player_readable.sql';

const read = (name: string) => readFileSync(join(MIG_DIR, name), 'utf8');

describe('LAW: a horse report is not a public record', () => {
  it('the closing migration exists and drops the unconditional read policy', () => {
    const sql = read(CLOSER);
    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Anyone can read bug reports" ON public.horse_bug_reports'
    );
    expect(sql).toMatch(
      /CREATE POLICY horse_bug_reports_admin_read[\s\S]*USING \(public\.fn_is_horse_admin\(\)\)/
    );
    expect(sql).toContain('REVOKE ALL ON TABLE public.horse_bug_reports FROM anon');
  });

  it('the dead club_memberships alias and the join-blockers function are off the player grants', () => {
    const sql = read(CLOSER);
    expect(sql).toContain('REVOKE ALL ON public.club_memberships FROM anon, authenticated');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_club_union_join_blockers(uuid) FROM PUBLIC, anon, authenticated'
    );
  });

  it('asserts its own effect rather than trusting the statements ran', () => {
    const sql = read(CLOSER);
    expect(sql).toContain("has_table_privilege('anon', 'public.horse_bug_reports', 'SELECT')");
    expect(sql).toContain(
      "has_function_privilege('authenticated', 'public.fn_club_union_join_blockers(uuid)', 'EXECUTE')"
    );
    expect(sql).toMatch(
      /RAISE EXCEPTION 'horse_bug_reports still has an unconditional read policy'/
    );
  });

  it('no later migration reopens the public read or re-grants the two revokes', () => {
    const later = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith('.sql') && f > CLOSER)
      .map((f) => [f, read(f)] as const);
    for (const [name, sql] of later) {
      expect(sql, `${name} recreates the public horse_bug_reports read`).not.toMatch(
        /CREATE POLICY[^;]*ON public\.horse_bug_reports[^;]*FOR SELECT[^;]*USING \(true\)/i
      );
      expect(sql, `${name} re-grants club_memberships to players`).not.toMatch(
        /GRANT[^;]*ON (TABLE )?public\.club_memberships[^;]*TO[^;]*(anon|authenticated)/i
      );
      expect(sql, `${name} re-grants fn_club_union_join_blockers to players`).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.fn_club_union_join_blockers[^;]*TO[^;]*(anon|authenticated)/i
      );
    }
  });
});

describe('LAW: a horse avatar does not live at a path that says horse', () => {
  /* 541 of 1,000 horse profiles carried `avatar_url` under
     `social-media/horse-avatars-v2/` or `social-media/avatars/horse_avatar_*`
     and no human did - the flag spelled out in the <img src> of every seat
     and post. The copies live where human uploads live (`avatars/<uuid>/`),
     the migration repoints and asserts, and the script that copied them is
     kept so the next generator run can be checked against it. */
  const AVATARS = '20260908022510_a_horse_avatar_does_not_live_at_a_path_that_says_horse.sql';

  it('the repointing migration derives the neutral key and proves the copy exists first', () => {
    const sql = read(AVATARS);
    expect(sql).toContain("p.id::text || '/avatar.' ||");
    expect(sql).toContain("o.bucket_id = 'avatars' AND o.name = m.new_key");
    expect(sql).toMatch(
      /RAISE EXCEPTION 'PRE-FLIGHT: % destination objects are not in storage\.objects/
    );
    expect(sql).toMatch(
      /RAISE EXCEPTION 'POST-FLIGHT: % horse profiles still carry a horse-named avatar'/
    );
    expect(sql).toContain("settings = settings - '_snapshot' - 'snapshot'");
  });

  it('the copy script exists and writes to the human convention', () => {
    const script = readFileSync(
      join(root, 'scripts/ops/copy-horse-avatars-to-neutral-paths.mjs'),
      'utf8'
    );
    expect(script).toContain("destinationBucket: 'avatars'");
    expect(script).toContain('`${row.id}/avatar.${ext}`');
    expect(script).not.toMatch(/horse-avatars-v2\/\$\{/);
  });
});
