import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Telemetry Exposure run 37071022389 found increment_reel_count and
 * decrement_reel_count SECURITY DEFINER, executable by `authenticated`, and
 * blind to the caller: one logged-in account could set any reel's like, comment,
 * share or view count to anything, on anybody's reel.
 *
 * The counters that have a table of truth (social_likes, social_comments, each
 * with a trigger) are service-side only. The two a viewer legitimately moves,
 * share_count and view_count, stay open to a signed-in browser, which is every
 * field the World Hub's reel player actually passes.
 *
 * These pins fail if the caller check is dropped, if the browser regains the
 * derived counters, or if anon is granted EXECUTE again.
 */
const MIGRATION = '20261002225448_a_browser_moves_only_the_reel_counters_it_is_the_evidence_fo.sql';
const source = readFileSync(resolve(__dirname, '../../supabase/migrations', MIGRATION), 'utf8');
const body = source.slice(source.indexOf('\nBEGIN;'));

const routineBody = (name: string) => {
  const start = body.indexOf(
    `CREATE OR REPLACE FUNCTION public.${name}(p_reel_id uuid, p_field text)`
  );
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
};

describe('a browser moves only the reel counters it is the evidence for', () => {
  for (const name of ['increment_reel_count', 'decrement_reel_count']) {
    it(`${name} consults the caller before it writes`, () => {
      const routine = routineBody(name);
      expect(routine).toContain('auth.role()');
      expect(routine).toContain('auth.uid() IS NULL');
      expect(routine).toContain("IF v_request_role IN ('anon', 'authenticated') THEN");
      expect(routine).toContain("IF p_field NOT IN ('share_count', 'view_count') THEN");
      expect(routine).toContain("USING ERRCODE = '42501'");
    });

    it(`${name} keeps the field allowlist, the alias canonicalisation and the floor`, () => {
      const routine = routineBody(name);
      expect(routine).toContain(
        "ARRAY['like_count','comment_count','share_count','view_count']::text[]"
      );
      expect(routine).toContain(
        'LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id'
      );
      expect(routine).toContain('COALESCE(a.canonical_reel_id, p_reel_id)');
      expect(routine).toContain('GREATEST(COALESCE(%I, 0)');
      expect(routine).toContain('SECURITY DEFINER');
    });

    it(`${name} is reachable by exactly the roles it was reachable by before`, () => {
      expect(body).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(uuid, text) FROM PUBLIC, anon;`
      );
      expect(body).toContain(
        `GRANT EXECUTE ON FUNCTION public.${name}(uuid, text) TO authenticated, service_role;`
      );
      expect(body).not.toMatch(
        new RegExp(`GRANT[^;]*ON FUNCTION public\\.${name}\\(uuid, text\\)[^;]*\\banon\\b`)
      );
    });
  }

  it('is one transaction and carries its live proof', () => {
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(source).toMatch(/^-- @live-proof:/m);
  });
});
