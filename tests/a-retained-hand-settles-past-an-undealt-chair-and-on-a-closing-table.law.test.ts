/**
 * A RETAINED HAND SETTLES PAST AN UNDEALT CHAIR, AND ON A CLOSING TABLE (2026-09-29)
 *
 * public.fn_ca_resume_hand_submission refused two finished, conserving cash
 * hands on every table start: 6c9ee4b6 because two horses sat down before the
 * deal but were not dealt in, and 499aa67a because the table was 'breaking'.
 * Both tables crash-looped. 20260929022629 relaxes exactly those two admission
 * clauses by verified string replacement of the live body.
 *
 * These laws pin that migration: the pre-image and post-image are pinned by
 * md5; each replacement targets one exact clause; an undealt chair is admitted
 * only when the hand's own record never names its player and every named
 * player is in the stacks; a player seated twice still refuses; only a CASH
 * table may be 'breaking' and 'closed' is never admitted; the grants stay
 * service_role only.
 *
 * docs/changelog/2026-09-29-a-retained-hand-settles-past-an-undealt-chair-and-on-a-closing-table.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260929022629_a_retained_hand_settles_past_an_undealt_chair_and_on_a_closi.sql'
  ),
  'utf8'
);

const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

/** The replacement text for clause i (1-based): what lands in the live body. */
function replacement(i: number): string {
  const tags = [...FILE.matchAll(/\$n\$([\s\S]*?)\$n\$/g)].map((m) => m[1]);
  expect(tags.length, 'three replacement clauses').toBe(3);
  return tags[i - 1];
}
function original(i: number): string {
  const tags = [...FILE.matchAll(/\$o\$([\s\S]*?)\$o\$/g)].map((m) => m[1]);
  expect(tags.length, 'three original clauses').toBe(3);
  return tags[i - 1];
}

describe('a retained hand settles past an undealt chair and on a closing table', () => {
  it('installs only over the verified live body and only the proved result', () => {
    const c = code(FILE);
    expect(c).toContain("md5(p.prosrc) = '32cfcc987acdab387067f80ec3704c9b'");
    expect(c).toContain("IS DISTINCT FROM 'e2c4c0da28aa24c244951906f0d9d9b6'");
    expect(c).toMatch(/IF n <> 1 THEN\s+RAISE EXCEPTION 'CLAUSE %/);
    expect(c).toContain('EXECUTE d;');
    expect(c).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });

  it('admits a breaking CASH table only; closed and tournament rules are unchanged', () => {
    const next = code(replacement(1));
    expect(original(1)).toContain(
      "AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))"
    );
    expect(next).toContain(
      "AND (lifecycle='live' OR (tour IS NULL AND lifecycle='breaking') OR (tour IS NOT NULL AND lifecycle IS NULL)))"
    );
    expect(next).not.toMatch(/'closed'/);
    expect(next).not.toMatch(/tour IS NOT NULL AND lifecycle='breaking'/);
  });

  it('admits a chair present at the deal only when the hand never names its player', () => {
    const next = code(replacement(3));
    // Present at the deal still refuses when the hand's record names the player...
    expect(next).toContain("late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz");
    expect(next).toContain("strpos((q->'p_hand_row')::text,late.user_id::text)>0");
    // ...or when the record is not a player array, or names a player missing from the stacks.
    expect(next).toContain("jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'");
    expect(next).toMatch(
      /EXISTS\(SELECT 1 FROM jsonb_array_elements\(q->'p_hand_row'->'players'\) hp\s+WHERE NOT EXISTS\(SELECT 1 FROM jsonb_array_elements\(q->'p_stacks'\) x WHERE x->>'user_id'=hp->>'userId'\)\)/
    );
    // A hand player seated twice always refuses.
    expect(next).toContain(
      "OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))"
    );
  });

  it('keeps the door service_role only', () => {
    const c = code(FILE);
    expect(c).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(c).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO service_role;'
    );
  });
});
