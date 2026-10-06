import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Telemetry Exposure run 37071022389 found increment_reel_count and
 * decrement_reel_count SECURITY DEFINER, executable by `authenticated`, and
 * blind to the caller. #5876 landed its own answer in the same half hour, so the
 * install reconciled the two: a browser caller is admitted here and then routed
 * through fn_count_content_engagement, which records one view or one share for
 * auth.uid() at most once a day, and a browser never decrements at all.
 *
 * The file is therefore the TEXT THAT RAN (schema_migrations 20261002232859).
 * This pins that, so the repository and the database cannot drift apart again,
 * and so neither half of the reconciliation can be dropped by an edit that only
 * remembers one of them.
 */
const MIGRATION = '20261002225448_a_browser_moves_only_the_reel_counters_it_is_the_evidence_fo.sql';
const source = readFileSync(resolve(__dirname, '../../supabase/migrations', MIGRATION), 'utf8');
const applied = source.slice(source.indexOf('-- 20261002225448_a_browser_moves', 10));

describe('a browser moves only the reel counters it is the evidence for', () => {
  it('still carries the exact bytes production ran', () => {
    const body = applied.endsWith('\n') ? applied.slice(0, -1) : applied;
    expect(Buffer.byteLength(body, 'utf8')).toBe(4546);
    expect(createHash('md5').update(body, 'utf8').digest('hex')).toBe(
      'bffd1d417d4472e9bccebd84ebab8e7f'
    );
  });

  for (const name of ['increment_reel_count', 'decrement_reel_count']) {
    it(`${name} consults the caller and refuses the derived counters`, () => {
      const start = applied.indexOf(
        `CREATE OR REPLACE FUNCTION public.${name}(p_reel_id uuid, p_field text)`
      );
      expect(start).toBeGreaterThan(-1);
      const routine = applied.slice(start, applied.indexOf('$function$;', start));
      expect(routine).toContain("COALESCE(auth.role(), 'service_role') <> 'service_role'");
      expect(routine).toContain('auth.uid() IS NULL');
      expect(routine).toContain("IF p_field NOT IN ('share_count', 'view_count') THEN");
      expect(routine).toContain("USING ERRCODE = '42501'");
      expect(routine).toContain('SECURITY DEFINER');
      expect(routine).toContain(
        'LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id'
      );
    });

    it(`${name} is reachable by exactly the roles it was reachable by before`, () => {
      expect(applied).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(uuid, text) FROM PUBLIC, anon;`
      );
      expect(applied).toContain(
        `GRANT EXECUTE ON FUNCTION public.${name}(uuid, text) TO authenticated, service_role;`
      );
    });
  }

  it("keeps #5876's receipt door on the increment and refuses a browser decrement outright", () => {
    expect(applied).toContain("fn_count_content_engagement(p_reel_id, 'view', 'reels')");
    expect(applied).toContain("fn_count_content_engagement(p_reel_id, 'share', 'reels')");
    expect(applied).toContain(
      "RAISE EXCEPTION 'decrement_reel_count: a count is not a browser''s to take down'"
    );
  });

  it('is one transaction and carries its live proof', () => {
    expect(applied.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(applied.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(source).toMatch(/^-- @live-proof:/m);
    expect(source).toMatch(/^-- THIS FILE IS THE TEXT THAT RAN\./m);
  });
});
