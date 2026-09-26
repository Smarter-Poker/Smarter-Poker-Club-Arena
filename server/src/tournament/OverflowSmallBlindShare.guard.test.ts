/**
 * THE OVERFLOW SMALL BLIND KEEPS ITS AUTHORED SHARE OF THE BIG BLIND
 *
 * fn_resolve_tournament_blinds's mtt_overflow branch grows the anchor level's
 * small blind, big blind and ante by ONE shared factor and then applies a hard
 * 10,000,000 ceiling to each of the three INDEPENDENTLY. Two of the three
 * relationships that ceiling breaks were already repaired:
 * 20260909223919 caught the fully saturated SB = BB case, and
 * the_overflow_ante_keeps_its_authored_share_of_the_big_blind held the ante to
 * its authored ante:bigBlind share. This is the small blind's turn.
 *
 * THE BAND. The 2026-09-09 repair fires only on `v_sb >= v_bb`. Between the
 * level where the BIG blind reaches the ceiling and the level where the SMALL
 * blind reaches it too, the big blind is pinned at 10,000,000 while the small
 * blind is still growing underneath it - SB < BB the whole way, so nothing
 * fires. Calling the LIVE function on 2026-09-21 with an authored anchor of
 * sb 2,000,000 / bb 4,000,000 returned:
 *
 *   level 4   sb 4,740,740.74   bb  9,481,481.48   ratio 0.5000   capped false
 *   level 5   sb 6,320,987.65   bb 10,000,000      ratio 0.6321   capped false
 *   level 6   sb 8,427,983.54   bb 10,000,000      ratio 0.8428   capped false
 *   level 7   sb 5,000,000      bb 10,000,000      ratio 0.5000   capped TRUE
 *
 * Levels 5 and 6 are the defect: a small blind 26% and 69% above the level the
 * structure authored, reported as `blind_capped: false`.
 *
 * PRODUCTION, 2026-09-21. Of 37,293 published tournaments.blind_level_state
 * rows, 12,371 sit past the end of their ladder and 5,298 of those carry a
 * small blind above its authored share - 4,770 at SB = BB exactly and 528
 * inside the band (428 at 0.5000-0.5051, 52 at 0.6973, 48 at 0.9762). 0 of the
 * 24,922 in-structure levels drift at all. All 21 blind structures on the
 * platform author sb:bb = 0.5000 exactly.
 *
 * The executable proof lives in the migration's own post-image block, which
 * calls the patched function nine times inside the transaction that patched it
 * and refuses to commit unless every answer is exact. This file pins the
 * contract that block states, and the TypeScript half of the same shape.
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

const antePath = migrationPath('the_overflow_ante_keeps_its_authored_share_of_the_big_blind.sql');
const guardPath = migrationPath('the_overflow_small_blind_keeps_its_authored_share_of_the_big.sql');
const SQL = readFileSync(guardPath, 'utf8');
const ESCALATION = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'blindEscalation.ts'),
  'utf8'
);
const MANAGER = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'TournamentManagerBase.ts'),
  'utf8'
);

/** The plpgsql this migration splices in after the 2026-09-09 SB < BB repair. */
const PATCH = (() => {
  const open = SQL.indexOf('v_exit_patch text := $a$');
  expect(open).toBeGreaterThan(-1);
  const body = SQL.slice(open + 'v_exit_patch text := $a$'.length);
  const close = body.indexOf('$a$;');
  expect(close).toBeGreaterThan(-1);
  return body.slice(0, close);
})();

/** The production identity this repair was written against, 2026-09-21. */
const PREIMAGE_FUNCTIONDEF_MD5 = 'd757c59c5af645d176263c23c6b3af19';
const PREIMAGE_PROSRC_MD5 = '3e0dcf6bc533bbe203434d53a559ef91';

describe('the overflow small blind keeps its authored share of the big blind', () => {
  it('lands after the ante repair it completes, in one transaction', () => {
    expect(antePath < guardPath).toBe(true);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '60s';");
    // One CREATE OR REPLACE, executed from the live definition: no second
    // schema-cache reload, and no hand-copied function body to drift.
    expect(SQL).toContain('EXECUTE v_new;');
    expect(SQL).not.toMatch(/^CREATE OR REPLACE FUNCTION/m);
    // The estate forbids these outright in a migration.
    expect(SQL).not.toMatch(/\bCONCURRENTLY\b/);
    expect(SQL).not.toMatch(/\bVACUUM\b/);
    // It creates no catalogue object, so it declares its own liveness proof.
    expect(SQL).toContain(
      "-- @live-proof: (SELECT position('v_sb_ceiling numeric;' in p.prosrc) > 0"
    );
    expect(SQL).toContain(
      "-- @live-proof: (SELECT position('v_sb_ceiling := v_bb * v_anchor_sb / v_anchor_bb;' in p.prosrc) > 0"
    );
  });

  it('pins the whole pre-image before it touches anything', () => {
    expect(SQL).toContain(`md5(pg_get_functiondef(oid)) = '${PREIMAGE_FUNCTIONDEF_MD5}'`);
    expect(SQL).toContain(`md5(prosrc) = '${PREIMAGE_PROSRC_MD5}'`);
    expect(SQL).toContain("proowner = 'postgres'::regrole");
    expect(SQL).toContain("proconfig = ARRAY['search_path=public, pg_temp']");
    // This function's live ACL is postgres only - it carries no service_role
    // grant, and the assertion states what production actually has.
    expect(SQL).toContain("proacl::text = '{postgres=X/postgres}'");
    expect(SQL).toContain('prosecdef');
    expect(SQL).toContain("provolatile = 'v'");
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_PREIMAGE_CHANGED');
    // Both anchors proven unique, and the patch proven absent, before the
    // replace runs - so a replay cannot double-apply it.
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_DECLARE_ANCHOR_NOT_UNIQUE');
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_EXIT_ANCHOR_NOT_UNIQUE');
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_ALREADY_PRESENT');
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_REPLACEMENT_MADE_NO_CHANGE');
  });

  it('carries owner, ACL, search_path, volatility and security mode across', () => {
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_POSTIMAGE_ATTRIBUTES_MOVED');
    expect(SQL).not.toMatch(/\bGRANT\b/);
    expect(SQL).not.toMatch(/\bREVOKE\b/);
  });

  it('holds the small blind to the anchor share, and only ever lowers it', () => {
    // The share is read off the same anchor row the branch already grew the
    // small and big blind from.
    expect(PATCH).toContain('v_sb_ceiling := v_bb * v_anchor_sb / v_anchor_bb;');
    // A CEILING, never a floor: strictly greater, and the assignment only
    // ever reduces.
    expect(PATCH).toContain('IF v_sb > v_sb_ceiling THEN');
    expect(PATCH).toContain('v_sb := GREATEST(1, floor(v_sb_ceiling));');
    // An anchor that authors sb >= bb is left to the 2026-09-09 repair.
    expect(PATCH).toContain('AND v_anchor_sb < v_anchor_bb');
    // The level says so when the ceiling bit, which the band did not.
    expect(PATCH).toContain('v_capped := true;');
    // It must not touch the ante - that repair is finished.
    expect(PATCH).not.toContain('v_ante :=');
  });

  it('proves the measured band, the control levels and the untouched siblings', () => {
    // The two band levels, by the numbers they actually returned.
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_BAND_LEVEL_5_WRONG');
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_BAND_LEVEL_6_WRONG');
    // Levels below the ceiling must not move, and must stay uncapped.
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_DISTURBED_AN_UNCAPPED_LEVEL');
    // An authored, in-structure level is the persisted branch and is exact.
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_CHANGED_AN_AUTHORED_LEVEL');
    // Past the band the 2026-09-09 repair must go on holding the line.
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_SATURATED_CASE_WRONG');
    // bb/2 is not the rule; a structure authoring a third keeps its third.
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_IGNORED_THE_AUTHORED_SHARE');
    // The two repairs it must leave exactly alone.
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_DISTURBED_THE_ANTE_REPAIR');
    expect(SQL).toContain('BLIND_OVERFLOW_SMALL_BLIND_DISTURBED_THE_CHIP_CLAMP');
  });
});

describe('the TypeScript half of the same shape', () => {
  it('applies MAX_BLIND_VALUE once, where the share can still be read', () => {
    // escalatedBlindLevel used to saturate each of the three numbers on its
    // own before enforcePlayableBlindLevel could see how far past the ceiling
    // the level really was.
    expect(ESCALATION).not.toContain(
      'Math.round(Math.min((Number.isFinite(n) ? n : 0) * factor, MAX_BLIND_VALUE))'
    );
    expect(ESCALATION).toContain('const grown = (Number.isFinite(n) ? n : 0) * factor;');
    // The anchor row is handed over as the share source, because the grown
    // pair are two independently rounded products.
    expect(ESCALATION).toContain(
      'authoredShareFrom?: { smallBlind?: unknown; bigBlind?: unknown; ante?: unknown }'
    );
    expect(ESCALATION).toContain('const shareSource = authoredShareFrom ?? level;');
    // The share ceiling applies only where the ceiling actually bit, so whole
    // chips (2026-09-11) is not mistaken for this defect.
    expect(ESCALATION).toContain('levelBigBlind > MAX_BLIND_VALUE');
    expect(ESCALATION).toContain(
      'const ceiling = (bigBlind * requestedSmallBlind) / requestedBigBlind;'
    );
  });

  it('the publisher no longer clamps its three numbers independently', () => {
    // The last thing before fn_publish_tournament_blind_level used to be
    // three separate Math.min(..., 10_000_000) calls - which is how 25 RUNNING
    // Spin events came to publish 10,000,000/10,000,000 on 2026-09-21.
    expect(MANAGER).not.toContain('smallBlind: Math.min(resolved.smallBlind ?? 0, 10_000_000)');
    expect(MANAGER).not.toContain(
      'const smallBlind = Math.min(level.smallBlind ?? 0, 10_000_000);'
    );
    expect(MANAGER).toContain('const playable = enforcePlayableBlindLevel(resolved);');
    expect(MANAGER).toContain(
      'const { smallBlind, bigBlind, ante } = enforcePlayableBlindLevel(level);'
    );
    expect(MANAGER).toContain('  enforcePlayableBlindLevel,');
  });
});
