/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND CASH BUY-IN REACHES THE WALLET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 11 of the Diamond Arena programme, line 2 (concurrency, duplicate
 * delivery and crash recovery). The concurrency suite drove the Diamond cash
 * buy-in from a player's own session against production's function text and
 * found it refused twice before it could move a Diamond: the profile guard
 * did not name the buy-in route that writes the wallet, and the arena guard
 * read the four stored generated columns of public.tables as a structural
 * change because a BEFORE trigger sees them as NULL.
 *
 * Both guards change by asserted substitution - live md5 pinned, the marker
 * found exactly once, the reverse substitution proved - and the route the
 * profile guard admits is pinned too, so the guard admits only the route that
 * was reviewed. Both redefinitions are declared to the guard watch. Nothing is
 * opened, nothing is priced.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_cash_buy_in_reaches_the_wallet.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond cash buy-in migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const PROFILE = sliceBetween(
  MIG,
  '-- 1. THE PROFILE GUARD NAMES THE DIAMOND CASH BUY-IN',
  '-- 2. THE ARENA GUARD LEAVES GENERATED COLUMNS OUT OF ITS COMPARISON'
);
const ARENA = sliceBetween(
  MIG,
  '-- 2. THE ARENA GUARD LEAVES GENERATED COLUMNS OUT OF ITS COMPARISON',
  '-- 3. THE ESTATE IS AS IT WAS'
);
const FINAL = sliceBetween(MIG, '-- 3. THE ESTATE IS AS IT WAS', 'COMMIT;');

describe('LAW: a Diamond cash buy-in reaches the wallet', () => {
  it('opens nothing and declares its own proof of being live', () => {
    expect(code(MIG)).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*:?=\s*true/i);
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(MIG).toMatch(
      /^-- @live-proof: .*fn_poker_diamond_buyin.*fn_guard_profile_privileged_columns/m
    );
    expect(MIG).toMatch(/^-- @live-proof: .*attgenerated.*fn_poker_guard_arena_structure/m);
  });

  it('the profile guard names the buy-in route, in place, pinned and proved in reverse', () => {
    expect(PROFILE).toContain("IF md5(v_def) <> '5ec21958ce25b6a88a0f370b4050b542' THEN");
    expect(PROFILE).toContain(
      "IF md5(replace(v_after, v_new, v_old)) <> '5ec21958ce25b6a88a0f370b4050b542' THEN"
    );
    expect(PROFILE).toContain(
      "RAISE EXCEPTION 'guard marker found % time(s), expected 1', v_hits;"
    );
    expect(PROFILE).toContain(
      "OR v_stack ~ 'function (public[.])?fn_poker_diamond_buyin[(]'$new$;"
    );
    expect(PROFILE).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(PROFILE).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',"
    );
  });

  it('the route the guard admits is the reviewed one: owner-only, reached through a live, own-account door, journaled first', () => {
    expect(PROFILE).toContain("IF md5(v_route) <> '2f76148f74df8766a958cdd403582e24'");
    expect(PROFILE).toContain("IF md5(v_route) <> '2f8b47a714db3f297aff3f7a2e814c44'");
    expect(PROFILE).toContain("IF md5(v_route) <> 'cf2150429728d8d796711e9bdbb22f51'");
    expect(PROFILE).toContain("position('public.fn_caller_session_is_live()' IN v_route) = 0");
    expect(PROFILE).toContain("position('Cannot buy in for another user' IN v_route) = 0");
    expect(PROFILE).toContain(
      "OR has_function_privilege('authenticated', 'public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)', 'EXECUTE')"
    );
    expect(PROFILE).toContain(
      "OR has_function_privilege('authenticated', 'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)', 'EXECUTE')"
    );
    expect(PROFILE).toContain(
      "> position('UPDATE public.profiles SET diamonds=diamonds-p_amount::integer' IN v_route)"
    );
  });

  it('the arena guard leaves stored generated columns out of both sides of its comparison, in place', () => {
    expect(ARENA).toContain("IF md5(v_def) <> 'f17675dd0b647abda7b0b9d8772c9c0e' THEN");
    expect(ARENA).toContain(
      "IF md5(replace(v_after, v_new, v_old)) <> 'f17675dd0b647abda7b0b9d8772c9c0e' THEN"
    );
    const generated =
      "- ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a\n                                WHERE a.attrelid = TG_RELID AND a.attgenerated <> '' AND NOT a.attisdropped))";
    expect(ARENA.split(generated).length - 1).toBe(2);
    expect(ARENA).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_poker_guard_arena_structure',"
    );
  });

  it('asserts at the end that both edits landed, both guards still refuse, the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain(
      'the profile guard does not name the buy-in route and still refuse every other write'
    );
    expect(FINAL).toContain(
      'the arena guard does not leave generated columns out of both sides and still refuse structure'
    );
    expect(FINAL).toContain('Diamond Games Require Platform Operations');
    expect(FINAL).toContain(
      'IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN'
    );
    expect(FINAL).toContain("RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;");
  });
});
