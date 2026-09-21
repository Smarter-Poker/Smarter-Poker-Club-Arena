/**
 * A PUBLISHED ANTE NEVER EXCEEDS ITS BIG BLIND
 *
 * fn_publish_tournament_blind_level is the authority that writes an authored
 * blind level onto tournaments.blind_level_state and every live row in
 * public.tables. Its validation block bounds each argument on its own and
 * relates exactly ONE pair - the small blind to the big blind. The ante had
 * no relational check at all, so measured against production on 2026-09-21:
 *
 *   (..., sb 100, bb 200, ante 500) -> 42501 TOURNAMENT_MANAGER_FENCED
 *   (..., sb 300, bb 200, ante   0) -> 22023 Invalid tournament blind transition
 *
 * The first one is the defect: an ante two and a half times its big blind was
 * accepted by validation and stopped only by the lease fence, so a caller
 * holding a live lease could author a level nobody can play. The sibling
 * repair 20260920190537_the_overflow_ante_keeps_its_authored_share_of_the_big_blind
 * clamps the ante in fn_resolve_tournament_blinds, but the publisher takes
 * its numbers from the manager rather than from the resolver - and
 * blindEscalation.ts carries the same independent-ceiling shape in
 * TypeScript - so the source side needs its own guard.
 *
 * THE CEILING IS ONE BIG BLIND, NOT LESS. Read off production 2026-09-21, the
 * ante:bigBlind ratio has never exceeded 1.0 anywhere: 0 of 370 authored
 * levels in 21 structures, 0 of 2,176 commander levels, 0 of 37,286 published
 * blind_level_state rows, 0 of 273,161 tables rows. But equality is common and
 * legitimate - two structures (978824ab, 4f8ff2b0) are genuine big blind antes
 * authoring ante = bigBlind on 30 of their 32 levels, and AnteMath.ts makes
 * `ante >= bigBlind` the engine's TYPE TEST for them. So the rule refuses
 * ante > bigBlind and nothing else.
 *
 * The executable proof lives in the migration's own post-image block, which
 * calls the patched function eight times inside the same transaction that
 * patched it and refuses to commit unless every answer is exact. This file
 * pins the contract that block states.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(process.cwd(), '..');
const migrations = join(repo, 'supabase', 'migrations');

const migrationPath = (suffix: string): string => {
  const matches = readdirSync(migrations)
    .filter((name) => name.endsWith(`_${suffix}`) || name.endsWith(`_${suffix}.pending`))
    .map((name) => join(migrations, name));
  expect(matches, `expected exactly one staged-or-promoted ${suffix}`).toHaveLength(1);
  return matches[0] ?? '';
};

const siblingPath = migrationPath('the_overflow_ante_keeps_its_authored_share_of_the_big_blind.sql');
const guardPath = migrationPath('a_published_ante_never_exceeds_its_big_blind.sql');
const SQL = readFileSync(guardPath, 'utf8');
const ANTE_MATH = readFileSync(join(process.cwd(), 'src', 'engine', 'AnteMath.ts'), 'utf8');
const ESCALATION = readFileSync(join(process.cwd(), 'src', 'tournament', 'blindEscalation.ts'), 'utf8');

/** The plpgsql this migration splices into the validation block's tail. */
const PATCH = (() => {
  const open = SQL.indexOf('v_patch text := $a$');
  expect(open).toBeGreaterThan(-1);
  const body = SQL.slice(open + 'v_patch text := $a$'.length);
  const close = body.indexOf('$a$;');
  expect(close).toBeGreaterThan(-1);
  return body.slice(0, close);
})();

/** The production identity this guard was written against, 2026-09-21. */
const PREIMAGE_FUNCTIONDEF_MD5 = '6d88ca5594c72e7b6757e65d2972461a';
const PREIMAGE_PROSRC_MD5 = 'ea893550ec280993c522bb8dfb78fcd3';
const SIGNATURE =
  'public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)';

describe('a published ante never exceeds its big blind', () => {
  it('lands after the resolver repair it completes, in one transaction', () => {
    expect(siblingPath < guardPath).toBe(true);
    expect(guardPath).toMatch(
      /20260921094352_a_published_ante_never_exceeds_its_big_blind\.sql(?:\.pending)?$/
    );
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '60s';");
    // One CREATE OR REPLACE, executed from the live definition: no second
    // schema-cache reload, and no hand-copied function body to drift.
    expect(SQL).toContain('EXECUTE v_new;');
    expect(SQL).not.toMatch(/^CREATE OR REPLACE FUNCTION/m);
    // It creates no catalogue object, so it declares its own liveness proof.
    expect(SQL).toContain("-- @live-proof: (SELECT position('IF p_ante>p_big_blind THEN' in p.prosrc) > 0");
  });

  it('pins the whole pre-image before it touches anything', () => {
    expect(SQL).toContain(`md5(pg_get_functiondef(oid)) = '${PREIMAGE_FUNCTIONDEF_MD5}'`);
    expect(SQL).toContain(`md5(prosrc) = '${PREIMAGE_PROSRC_MD5}'`);
    expect(SQL).toContain("proowner = 'postgres'::regrole");
    expect(SQL).toContain("proconfig = ARRAY['search_path=public, pg_temp']");
    expect(SQL).toContain("proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(SQL).toContain('prosecdef');
    expect(SQL).toContain("provolatile = 'v'");
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_PREIMAGE_CHANGED');
    // The anchor must be proven unique, and the patch proven absent, before
    // the replace runs.
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_ANCHOR_NOT_UNIQUE');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_ALREADY_PRESENT');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_REPLACEMENT_MADE_NO_CHANGE');
  });

  it('carries owner, ACL, search_path, volatility and security mode across', () => {
    // CREATE OR REPLACE preserves all five; the migration asserts it rather
    // than trusting it, and never issues a GRANT or REVOKE of its own.
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_POSTIMAGE_ATTRIBUTES_MOVED');
    expect(SQL).not.toMatch(/\bGRANT\b/);
    expect(SQL).not.toMatch(/\bREVOKE\b/);
  });

  it('refuses an ante above the big blind, and names the rule when it does', () => {
    expect(PATCH).toContain('IF p_ante>p_big_blind THEN');
    // Same class of refusal as the p_small_blind>p_big_blind line it joins,
    // so an errcode-driven caller sees no change.
    expect(PATCH).toContain("USING ERRCODE='22023'");
    // A refusal that points at eight unrelated bounds is not diagnostic; this
    // one states the rule and the two numbers that broke it.
    expect(PATCH).toContain(
      "RAISE EXCEPTION 'Invalid tournament blind transition: ante % exceeds big blind %'"
    );
  });

  it('refuses ONLY a strictly larger ante, and assigns nothing', () => {
    // Strictly greater. `>=` would refuse every big blind ante in production.
    expect(PATCH).not.toContain('p_ante>=p_big_blind');
    expect(PATCH).not.toContain('p_ante >= p_big_blind');
    // The guard is a refusal, not a repair: it must not silently rewrite an
    // argument the caller will then be told was published.
    expect(PATCH).not.toMatch(/\bp_ante\s*:?=[^=]/);
    expect(PATCH).not.toMatch(/\bp_big_blind\s*:?=[^=]/);
    expect(PATCH).not.toMatch(/\bp_small_blind\s*:?=[^=]/);
    expect(PATCH.match(/RAISE EXCEPTION/g)).toHaveLength(2);
    // The bounds it is appended behind are carried through unedited.
    expect(PATCH).toContain('OR p_ante IS NULL OR p_ante<0 OR p_ante>10000000 THEN');
    expect(PATCH).toContain(
      "RAISE EXCEPTION 'Invalid tournament blind transition' USING ERRCODE='22023';"
    );
  });

  it('keeps a big blind ante publishable, because the engine types on it', () => {
    // AnteMath.ts: `ante >= bigBlind` means the structure authored a TOTAL.
    // Refusing equality would refuse those two formats outright.
    expect(ANTE_MATH).toContain('ante >= bigBlind');
    expect(ANTE_MATH).toContain('authoredAsTotal');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_BROKE_A_BIG_BLIND_ANTE');
    // The TypeScript side still clamps the ante independently of the big
    // blind, which is why the saturated level below must stay publishable.
    expect(ESCALATION).toContain('Math.min(rawAnte, MAX_BLIND_VALUE)');
  });

  it('proves every edge inside its own transaction, against the patched function', () => {
    // Refused: 2.5x the big blind, and the smallest possible violation.
    expect(SQL).toContain('PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,500);');
    expect(SQL).toContain('PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,201);');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_DID_NOT_REFUSE_ANTE_OVER_BB');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_MISSED_THE_BOUNDARY');
    // Accepted: a big blind ante, the estate's usual 0.125 x bb per-player
    // ante, no ante at all, and the 10,000,000 saturation point where
    // blindEscalation.ts already hands this function sb = bb = ante.
    expect(SQL).toContain('PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,200);');
    expect(SQL).toContain('PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,25);');
    expect(SQL).toContain('PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,0);');
    expect(SQL).toContain(
      'PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,10000000,10000000,10000000);'
    );
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_REFUSED_A_PER_PLAYER_ANTE');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_REFUSED_A_LEVEL_WITH_NO_ANTE');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_REFUSED_THE_SATURATED_LEVEL');
    // An accepted level is one the lease fence stops, which is how the proof
    // distinguishes "validation let it through" from "validation refused it"
    // without writing anything.
    expect(SQL.match(/42501 TOURNAMENT_MANAGER_FENCED%/g)?.length).toBe(4);
    // The checks that were already there are re-proven, unchanged.
    expect(SQL).toContain('PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,300,200,0);');
    expect(SQL).toContain(
      'PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,20000000);'
    );
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_DISTURBED_THE_SMALL_BLIND_CHECK');
    expect(SQL).toContain('PUBLISHED_ANTE_CEILING_DISTURBED_THE_ANTE_BOUND');
  });

  it('leaves the resolver repair and everything downstream of it alone', () => {
    // fn_resolve_tournament_blinds is finished; this migration names it in
    // its note and resolves nothing but its own function.
    expect(SQL).toContain('fn_resolve_tournament_blinds is finished and is not touched');
    expect(SQL).not.toContain("to_regprocedure('public.fn_resolve");
    expect(SQL.match(/to_regprocedure\('([^']+)'\)/g) ?? []).toEqual(
      Array(4).fill(`to_regprocedure('${SIGNATURE}')`)
    );
    // The publisher's fencing, locking, replay and receipt paths are not
    // re-authored - the patch only appends to the validation block.
    expect(PATCH).not.toContain('pg_advisory_xact_lock_shared');
    expect(PATCH).not.toContain('engine_tournament_leases');
    // The spliced plpgsql writes nothing and reads no row: it is two bounds
    // checks and a RAISE. (Its note cites the production counts by name, so
    // these look for the statements, not for the words.)
    expect(PATCH).not.toMatch(/\bUPDATE\b/);
    expect(PATCH).not.toMatch(/\bSELECT\b/);
    expect(PATCH).not.toMatch(/\bPERFORM\b/);
    expect(PATCH).not.toMatch(/\bv_state\b/);
    expect(PATCH).not.toMatch(/\bv_t\./);
    // The 279 live tables rows carrying ante = big_blind are legal under this
    // rule and are not repaired here.
    expect(SQL).not.toMatch(/UPDATE\s+public\.tables/);
  });
});
