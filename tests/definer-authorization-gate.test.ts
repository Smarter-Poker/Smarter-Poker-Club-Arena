/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE GATE THAT STOPS THE NEXT UNAUTHORISED DEFINER WRITER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * scripts/ci/check-definer-authorization.mjs blocks a migration that declares a
 * SECURITY DEFINER function which writes, which a browser role can execute, and
 * which never consults auth.uid(), auth.role() or auth.jwt().
 *
 * Nineteen such functions were live on 2026-08-27. One let an ordinary member
 * rewrite a club's member_count from 592 to 10591. Another pays chips. Eighteen
 * were revoked, and the nineteenth was written the same afternoon by an author
 * who had no way to know the rule existed.
 *
 * A gate nobody has watched fail is a gate nobody knows works. These feed the
 * checker the exact shapes that shipped, including the revoke trap that made an
 * earlier fix a silent no-op, and assert on its VERDICT rather than on its
 * wording, so rephrasing the help text cannot quietly disarm it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

type Verdict = (sql: string, allowlist?: Set<string>) => string[];
let unauthorisedWriters: Verdict;

beforeAll(async () => {
  // Computed specifier: the checker is a plain ESM script with no type
  // declarations, and a static import would be a resolution error. The path is
  // built from __dirname rather than import.meta.url because the test
  // environment serves modules over http, which the ESM loader will not take.
  const href = pathToFileURL(
    resolve(__dirname, '..', 'scripts/ci/check-definer-authorization.mjs')
  ).href;
  const mod = await import(/* @vite-ignore */ href);
  unauthorisedWriters = mod.unauthorisedWriters;
});

/** The shape that shipped nineteen times: no GRANT written at all, which
 *  leaves the Postgres default of EXECUTE to PUBLIC. */
const OPEN_WRITER = `
CREATE OR REPLACE FUNCTION public.increment_member_count(p_club_id uuid, p_delta integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN UPDATE clubs SET member_count = COALESCE(member_count, 0) + p_delta WHERE id = p_club_id; END;
$function$;
`;

describe('the checker catches the shape that shipped', () => {
  it('flags a DEFINER writer with no grant statement at all', () => {
    // Silence is not safety. Postgres grants EXECUTE to PUBLIC by default and
    // every browser role inherits it, which is how most of the nineteen got there.
    expect(unauthorisedWriters(OPEN_WRITER)).toEqual(['increment_member_count']);
  });

  it('clears it once it is revoked from PUBLIC, anon and authenticated', () => {
    const fixed =
      OPEN_WRITER +
      `
REVOKE ALL ON FUNCTION public.increment_member_count(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_member_count(uuid, integer) TO service_role;
`;
    expect(unauthorisedWriters(fixed)).toEqual([]);
  });

  it('still flags it when only PUBLIC is revoked and authenticated keeps a grant', () => {
    /**
     * THE TRAP. On 2026-08-27 a column-level REVOKE was shipped against a
     * table-level grant and changed nothing, and has_column_privilege still
     * answered true afterwards. Same mistake, different privilege: revoking
     * one role while another still holds an explicit grant reads as a fix and
     * does nothing. The checker models roles separately so it cannot be fooled
     * the way a reviewer can.
     */
    const halfFixed =
      OPEN_WRITER +
      `
REVOKE ALL ON FUNCTION public.increment_member_count(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_member_count(uuid, integer) TO authenticated;
`;
    expect(unauthorisedWriters(halfFixed)).toEqual(['increment_member_count']);
  });
});

describe('the checker does not cry wolf', () => {
  it('accepts a writer that derives its actor from the request', () => {
    const guarded = `
CREATE OR REPLACE FUNCTION public.fn_save_thing(p_value text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN UPDATE things SET value = p_value WHERE owner_id = auth.uid(); END;
$function$;
`;
    expect(unauthorisedWriters(guarded)).toEqual([]);
  });

  it('is not satisfied by a comment that merely names auth.uid()', () => {
    // A body that talks about the check without making it is the failure mode
    // this whole class is made of.
    const pretend = `
CREATE OR REPLACE FUNCTION public.fn_pretend(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  -- authorisation is handled by auth.uid() upstream
  UPDATE things SET touched = now() WHERE id = p_id;
END;
$function$;
`;
    expect(unauthorisedWriters(pretend)).toEqual(['fn_pretend']);
  });

  it('ignores trigger functions, which cannot be invoked as an RPC', () => {
    const trg = `
CREATE OR REPLACE FUNCTION public.trg_touch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN INSERT INTO audit(at) VALUES (now()); RETURN NEW; END;
$function$;
`;
    expect(unauthorisedWriters(trg)).toEqual([]);
  });

  it('ignores a DEFINER function that only reads', () => {
    const ro = `
CREATE OR REPLACE FUNCTION public.fn_read_thing(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN RETURN (SELECT to_jsonb(t) FROM things t WHERE t.id = p_id); END;
$function$;
`;
    expect(unauthorisedWriters(ro)).toEqual([]);
  });

  it('honours the allowlist', () => {
    expect(unauthorisedWriters(OPEN_WRITER, new Set(['increment_member_count']))).toEqual([]);
  });
});

describe('the allowlist stays small and reasoned', () => {
  const allow = JSON.parse(
    readFileSync(
      resolve(__dirname, '..', 'scripts/ci/definer-authorization.allowlist.json'),
      'utf8'
    )
  );

  it('holds only the two functions that were read line by line', () => {
    expect(Object.keys(allow.reviewedExceptions).sort()).toEqual([
      'get_current_settlement_period',
      'recalculate_leaderboard_ranks',
    ]);
  });

  it('gives every entry a reason long enough to be a reason', () => {
    for (const [name, why] of Object.entries(allow.reviewedExceptions)) {
      expect(typeof why, name).toBe('string');
      expect((why as string).length, name).toBeGreaterThan(120);
    }
  });
});

describe('the gate is actually wired to something', () => {
  it('runs in CI as a blocking step', () => {
    const ci = readFileSync(resolve(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('node scripts/ci/check-definer-authorization.mjs');
    expect(ci).toContain('Definer Authorization');
  });

  it('runs on pre-push, because branch protection is unavailable on a private repo', () => {
    const hook = readFileSync(resolve(__dirname, '..', '.husky/pre-push'), 'utf8');
    expect(hook).toContain('check-definer-authorization.mjs');
  });
});
