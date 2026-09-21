/**
 * THE OVERFLOW ANTE KEEPS ITS AUTHORED SHARE OF THE BIG BLIND
 *
 * fn_resolve_tournament_blinds's mtt_overflow branch applies a 10,000,000
 * ceiling to smallBlind, bigBlind and ante INDEPENDENTLY. On a deep overflow
 * all three saturate to the same number, and the total_chips/20 chip clamp
 * below them rescales all three by one factor, so it faithfully preserves the
 * equality it inherited. The 2026-09-09 repair
 * (ca_a_capped_blind_level_is_still_a_blind_level) restored SB < BB after the
 * clamps and left the ante alone, so two events were still dealing
 * ante = bigBlind on 2026-09-20:
 *
 *   tables.id 2c621856-e728-4e8b-bf08-4c56746a8649  sb 43875  bb 87750  ante 87750
 *   tables.id 9f30d335-8262-4872-8926-3ddf1fefe75c  sb 24375  bb 48750  ante 48750
 *
 * Both authored ante = 0.125 x bigBlind on their final level.
 *
 * The rule cannot be "the ante must be below the big blind". Two production
 * structures author ante = bigBlind on every level - a big blind ante - and
 * server/src/engine/AnteMath.ts makes `ante >= bigBlind` the engine's TYPE
 * TEST for exactly that. The rule is the authored PROPORTION, read off the
 * same anchor row the branch already grows the blinds from, and applied as a
 * ceiling that can only ever lower an ante.
 *
 * The executable red-before/green-after proof is
 * scripts/dev/probe-blind-overflow-ante-pg17.sh, which rebuilds the exact
 * production pre-image from this repository's own migration chain and then
 * compares old and new jsonb over every distinct production blind structure.
 * This file pins the contract that probe depends on.
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

const cappedPath = migrationPath('ca_a_capped_blind_level_is_still_a_blind_level.sql');
const repairPath = migrationPath('the_overflow_ante_keeps_its_authored_share_of_the_big_blind.sql');
const SQL = readFileSync(repairPath, 'utf8');
const CAPPED_SQL = readFileSync(cappedPath, 'utf8');
const RUNNER = readFileSync(
  join(repo, 'scripts', 'dev', 'probe-blind-overflow-ante-pg17.sh'),
  'utf8'
);
const FIXTURE = readFileSync(
  join(
    repo,
    'scripts',
    'dev',
    'fixtures',
    'blind-overflow-ante',
    'production-blind-structures.sql'
  ),
  'utf8'
);
const ANTE_MATH = readFileSync(join(process.cwd(), 'src', 'engine', 'AnteMath.ts'), 'utf8');

/** The plpgsql this migration splices into the overflow branch's exit. */
const PATCH = (() => {
  const open = SQL.indexOf('v_exit_patch text := $a$');
  expect(open).toBeGreaterThan(-1);
  const body = SQL.slice(open + 'v_exit_patch text := $a$'.length);
  const close = body.indexOf('$a$;');
  expect(close).toBeGreaterThan(-1);
  return body.slice(0, close);
})();

/** The production identity this repair was written against, 2026-09-20. */
const PREIMAGE_FUNCTIONDEF_MD5 = '8545c67dc20be918ada9027d88f46312';
const PREIMAGE_PROSRC_MD5 = '4f83c09a69eecc766a1f3984feeb9823';

describe('the overflow ante keeps its authored share of the big blind', () => {
  it('lands after the repair it completes, in one transaction', () => {
    expect(cappedPath < repairPath).toBe(true);
    expect(repairPath).toMatch(
      /20260920190537_the_overflow_ante_keeps_its_authored_share_of_the_big_blind\.sql(?:\.pending)?$/
    );
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '60s';");
    // One CREATE OR REPLACE, executed from the live definition: no second
    // schema-cache reload, and no hand-copied function body to drift.
    expect(SQL).toContain('EXECUTE v_new;');
    expect(SQL).not.toMatch(/^CREATE OR REPLACE FUNCTION/m);
  });

  it('pins the whole pre-image before it touches anything', () => {
    expect(SQL).toContain(`md5(pg_get_functiondef(oid)) = '${PREIMAGE_FUNCTIONDEF_MD5}'`);
    expect(SQL).toContain(`md5(prosrc) = '${PREIMAGE_PROSRC_MD5}'`);
    expect(SQL).toContain("proowner = 'postgres'::regrole");
    expect(SQL).toContain("proconfig = ARRAY['search_path=public, pg_temp']");
    expect(SQL).toContain("proacl::text = '{postgres=X/postgres}'");
    expect(SQL).toContain('prosecdef');
    expect(SQL).toContain("provolatile = 'v'");
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_PREIMAGE_CHANGED');
    // Both text anchors must be proven unique before either replace runs.
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_DECLARE_ANCHOR_NOT_UNIQUE');
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_EXIT_ANCHOR_NOT_UNIQUE');
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_ALREADY_PRESENT');
  });

  it('carries owner, ACL, search_path, volatility and security mode across', () => {
    // CREATE OR REPLACE preserves all five; the migration asserts it rather
    // than trusting it, and never issues a GRANT or REVOKE of its own.
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_POSTIMAGE_ATTRIBUTES_MOVED');
    expect(SQL).not.toMatch(/\bGRANT\b/);
    expect(SQL).not.toMatch(/\bREVOKE\b/);
  });

  it('is a ceiling on the ante and touches nothing else', () => {
    // Read the proportion off the same anchor row the branch already uses.
    expect(SQL).toContain("v_last->>'bigBlind'");
    expect(SQL).toContain("v_last->>'big_blind'");
    expect(SQL).toContain("v_last->>'ante'");
    // Multiply before dividing so an anchor like 200000/1500000 stays exact.
    expect(SQL).toContain('v_ante_ceiling := v_bb * v_anchor_ante / v_anchor_bb;');
    // Compared unrounded, assigned rounded: a level already at its authored
    // proportion is left alone instead of being shaved by the floor.
    expect(SQL).toContain('IF v_ante > v_ante_ceiling THEN');
    expect(SQL).toContain('v_ante := GREATEST(1, floor(v_ante_ceiling));');
    // It may only ever lower an ante. The spliced plpgsql assigns to nothing
    // but the ante, its ceiling, the two anchor reads and the capped flag.
    expect(PATCH).not.toContain('v_sb :=');
    expect(PATCH).not.toContain('v_bb :=');
    expect(PATCH).not.toContain('v_factor :=');
    expect(PATCH).not.toContain('v_ratio :=');
    expect(new Set((PATCH.match(/\bv_[a-z_]+ :=/g) ?? []).map((a) => a.trim()))).toEqual(
      new Set([
        'v_anchor_bb :=',
        'v_anchor_ante :=',
        'v_ante_ceiling :=',
        'v_ante :=',
        'v_capped :=',
      ])
    );
    // The 2026-09-09 invariant is the thing this patch attaches BEHIND, not
    // something it re-authors: its exit anchor is that repair's own tail, and
    // the small blind repair stays where 2026-09-09 put it.
    expect(CAPPED_SQL).toContain('v_sb := GREATEST(1, floor(v_bb / 2));');
    expect(SQL).toContain('IF v_ante IS NULL OR v_ante < 0 THEN');
    // The existing ceilings and the chip clamp are not re-authored.
    expect(PATCH).not.toContain('10000000');
    expect(PATCH).not.toContain('p_total_chips');
  });

  it('keeps a big blind ante at its big blind, because the engine types on it', () => {
    // AnteMath.ts: `ante >= bigBlind` means the structure authored a TOTAL.
    // Shaving a fraction of a chip off would recharge the table ante x seats.
    expect(ANTE_MATH).toContain('ante >= bigBlind');
    expect(ANTE_MATH).toContain('authoredAsTotal');
    expect(SQL).toContain('IF v_anchor_bb > 0 AND v_anchor_ante >= v_anchor_bb THEN');
    expect(SQL).toContain('v_ante_ceiling := v_bb;');
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_BROKE_A_BIG_BLIND_ANTE');
  });

  it('proves the two live cases inside its own transaction', () => {
    expect(SQL).toContain('2c621856-e728-4e8b-bf08-4c56746a8649');
    expect(SQL).toContain('9f30d335-8262-4872-8926-3ddf1fefe75c');
    // 1,755,000 chips -> bb 87,750 -> ante floor(87750 x 0.125) = 10,968.
    expect(SQL).toContain("(r->>'ante')::numeric <> 10968");
    // 975,000 chips -> bb 48,750 -> ante floor(48750 x 0.125) = 6,093.
    expect(SQL).toContain("(r->>'ante')::numeric <> 6093");
    // An authored, in-structure level must come back exactly as written.
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_CHANGED_AN_AUTHORED_LEVEL');
    // The small blind and the chip ceiling are re-checked after the repair.
    expect(SQL).toContain("(r->>'small_blind')::numeric <> floor((r->>'big_blind')::numeric / 2)");
    expect(SQL).toContain('floor(975000::numeric / 20)');
    // A structure with no ante never acquires one.
    expect(SQL).toContain('BLIND_OVERFLOW_ANTE_INVENTED_AN_ANTE');
  });

  it('is proven against a throwaway PG17 cluster, never against production', () => {
    expect(RUNNER).toContain('PG17_BINDIR');
    expect(RUNNER).toContain('postgresql@17');
    // Socket only, and the cluster and its PGDATA are removed on every exit.
    expect(RUNNER).toContain("-c listen_addresses=''");
    expect(RUNNER).toContain('trap cleanup EXIT');
    expect(RUNNER).toContain('pg_ctl" -D "$cluster_dir" -m immediate stop');
    expect(RUNNER).toContain('rm -rf "$probe_root"');
    // The pre-image is rebuilt from this repo's chain and pinned to the md5
    // read out of production, so a drifted chain fails instead of proving
    // something about a different function.
    expect(RUNNER).toContain(`PRODUCTION_FUNCTIONDEF_MD5='${PREIMAGE_FUNCTIONDEF_MD5}'`);
    expect(RUNNER).toContain(`PRODUCTION_PROSRC_MD5='${PREIMAGE_PROSRC_MD5}'`);
    expect(RUNNER).toContain('BLIND_OVERFLOW_ANTE_PG17_OK');
  });

  it('proves the unchanged authored levels exhaustively, over real structures', () => {
    // Every distinct production blind_structure, captured read-only.
    expect(FIXTURE).toContain('CREATE TABLE probe_structures');
    expect((FIXTURE.match(/^\('[0-9a-f]{8}',/gm) ?? []).length).toBe(21);
    expect(RUNNER).toContain("'production structures loaded'");
    expect(RUNNER).toContain("$(q 'SELECT count(*) FROM probe_structures;')\" '21'");
    expect(RUNNER).toContain("$(q 'SELECT sum(n_levels) FROM probe_structures;')\" '370'");
    // Every level in them x seven chip totals x both variants, old vs new.
    expect(RUNNER).toContain("'authored in-structure levels whose jsonb changed'");
    expect(RUNNER).toContain("$(q 'SELECT count(*) FROM probe_pair WHERE authored;')\" '5180'");
    // Red before green, on the same two live inputs.
    expect(RUNNER).toContain("'live 2c621856 reproduces sb/bb/ante'");
    expect(RUNNER).toContain("'43875/87750/87750'");
    expect(RUNNER).toContain("'live 2c621856 now sane (0.125 x bb)'");
    expect(RUNNER).toContain("'43875/87750/10968'");
    expect(RUNNER).toContain("'24375/48750/48750'");
    expect(RUNNER).toContain("'24375/48750/6093'");
    // The invariants the repair must not break.
    for (const guard of [
      "'rows where the ante increased'",
      "'rows where the ante exceeds the big blind'",
      "'overflow rows with sb >= bb'",
      "'big-blind-ante rows changed at all'",
      "'anteless structures that gained an ante'",
      "'clamped overflow rows not on the total_chips/20 ceiling'",
      "'overflow rows still dealing ante = big blind on a per-player ladder'",
    ]) {
      expect(RUNNER).toContain(guard);
    }
  });
});
