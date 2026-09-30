/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE ARENA COUNTS ACTIVE PLAYERS, NOT FIXTURES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 6 ("Verify no agent panels,
 * union menus, chip metrics or synthetic players appear as real activity").
 * Migration 20260929233000_the_arena_counts_active_players_not_fixtures.
 *
 * ACTIVE on the arena's home card and lobby rail is get_club_players_playing,
 * and the rulings decided who counts: "Fixture accounts are not players;
 * horses are" (docs/DIAMOND-RULINGS.md). What this pins:
 *  - the arena's figure is counted by the arena's own seated rule
 *    (fn_diamond_arena_seated_players), the rule and the number of the
 *    Players page's At Tables, and nothing here names horses;
 *  - the new reader answers only for the one arena, and a signed-in player
 *    can call it while a visitor cannot;
 *  - get_club_players_playing changes only by asserted substitution (live md5
 *    pinned, reverse proved): the chip count is untouched, a chip club never
 *    enters the branch, and the function stays an invoker read;
 *  - the migration writes nothing, prices nothing and opens no switch;
 *  - the home card and the lobby rail still ask get_club_players_playing, so
 *    the rule reached them without a client change.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_the_arena_counts_active_players_not_fixtures.sql'))
  .at(-1);
if (!NAME) throw new Error('the arena ACTIVE migration is missing');
const MIG = migrationText(NAME);
const code = (s: string) => s.replace(/--[^\n]*/g, ' ');
const CODE = code(MIG);
const READER = code(
  sliceBetween(
    MIG,
    "-- 1. THE ARENA'S ACTIVE FIGURE",
    '-- 2. THE LOBBY COUNT ASKS IT FOR THE ARENA'
  )
);
const EDIT = sliceBetween(
  MIG,
  '-- 2. THE LOBBY COUNT ASKS IT FOR THE ARENA',
  '-- 3. THE ESTATE IS AS IT WAS'
);
const FINAL = code(sliceBetween(MIG, '-- 3. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('LAW: the arena counts active players, not fixtures', () => {
  it('writes nothing, prices nothing and opens no switch', () => {
    expect(CODE).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(CODE).not.toMatch(/cash_games_enabled\s*=\s*true|tournaments_enabled\s*=\s*true/i);
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it("counts the arena's ACTIVE figure by the arena's seated rule, and never names horses", () => {
    const body = sliceBetween(
      READER,
      'CREATE FUNCTION public.fn_diamond_arena_players_playing',
      '$fn$;'
    );
    expect(body).toContain('p_club_id = public.fn_diamond_arena_club()');
    expect(body).toContain('FROM public.fn_diamond_arena_seated_players(p_club_id)');
    expect(body, 'a club that is not the arena gets no number').not.toMatch(/\bELSE\b/);
    expect(MIG, 'a horse is a player; nothing here may filter on the horse flag').not.toMatch(
      /is_horse/i
    );
    expect(
      CODE,
      'the cert predicate matches horses and must never scope a player rule'
    ).not.toMatch(/fn_ca_is_cert_account/);
  });

  it('lets a signed-in player ask and a visitor not', () => {
    const reader = 'public.fn_diamond_arena_players_playing(uuid)';
    expect(READER).toContain('SECURITY DEFINER');
    expect(READER).toContain('SET search_path = public, pg_temp');
    expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${reader} FROM PUBLIC, anon, authenticated;`);
    expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION ${reader} TO authenticated, service_role;`);
    expect(FINAL).toContain("has_function_privilege('anon', v_reader, 'EXECUTE')");
  });

  it('changes the lobby count only by asserted substitution, and only for a diamonds club', () => {
    expect(EDIT).toContain("IF md5(v_def) <> 'd0deada158658ba9e1f88cbfba85c6ae' THEN");
    expect(EDIT).toContain('IF v_n <> 1 THEN');
    expect(EDIT).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(EDIT).toContain(
      "IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'd0deada158658ba9e1f88cbfba85c6ae' THEN"
    );
    const added = sliceBetween(EDIT, 'v_new text := $f$', '$f$;');
    expect(added).toContain("IF v_club.asset = 'diamonds' THEN");
    expect(added).toContain('RETURN public.fn_diamond_arena_players_playing(v_club.id);');
    expect(added, 'the chip count below the branch is not part of the edit').not.toMatch(
      /table_seats|fn_club_home_in_scope|union_clubs/
    );
    expect(CODE).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.get_club_players_playing/i
    );
    expect(FINAL).toContain(
      'get_club_players_playing must stay one invoker read with the grants it had'
    );
    expect(FINAL).toContain(
      "ACTIVE (% by id, % by slug, % by number) is not the arena''s seated figure"
    );
  });

  it('reaches the home card and the lobby rail through the read they already make', () => {
    const home = read('src/pages/HomePage.tsx');
    const lobby = read('src/pages/ClubHomePage.tsx');
    expect(home).toContain(
      "supabase.rpc('get_club_players_playing', { p_club_key: DIAMOND_ARENA_CLUB_ID })"
    );
    expect(lobby).toContain("supabase.rpc('get_club_players_playing', {");
    expect(`${home}\n${lobby}`).not.toContain('fn_diamond_arena_players_playing');
  });
});
