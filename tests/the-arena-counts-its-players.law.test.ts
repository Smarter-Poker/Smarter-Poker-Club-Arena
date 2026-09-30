/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE ARENA COUNTS ITS PLAYERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 3 ("Show real
 * member/online/seated/table counts with meaningful zero/error states") and
 * the Players-page half of line 6 ("no agent panels, union menus, chip metrics
 * or synthetic players as real activity"). Migration
 * 20260929214500_the_arena_counts_its_players.
 *
 * What this pins:
 *  - who is a player is written once (fn_diamond_arena_is_player): live
 *    sign-in, open account, not a certification fixture; horses are never
 *    named, so they can never be left out (CLAUDE.md 10.5);
 *  - every figure is read through that rule, and each is a number or NULL
 *    with a named reason; a failed read never becomes 0;
 *  - online is a number only while the presence feed shows the caller;
 *  - a roster row carries seven fields and no chip, hierarchy or horse field;
 *  - the arena's Players door opens the Diamond page by the server's
 *    entitlement, and a chip club still gets the chip roster.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_the_arena_counts_its_players.sql'))
  .at(-1);
if (!NAME) throw new Error('the arena-counts migration is missing');
const MIG = migrationText(NAME);
const code = (s: string) => s.replace(/--[^\n]*/g, ' ');
const CODE = code(MIG);
const section = (from: string, to: string) => code(sliceBetween(MIG, from, to));
const RULES = section('-- 1. THE ARENA, AND WHO PLAYS IN IT', '-- 3. THE FOUR FIGURES');
const COUNTS = section('-- 3. THE FOUR FIGURES', '-- 4. THE ROSTER');
const ROSTER = section('-- 4. THE ROSTER', '-- 5. THE ESTATE IS AS IT WAS');
const FINAL = section('-- 5. THE ESTATE IS AS IT WAS', 'RAISE NOTICE');

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const tsCode = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('LAW: the arena counts its players', () => {
  it('writes nothing, prices nothing and opens no switch', () => {
    expect(CODE).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(CODE).not.toMatch(/cash_games_enabled\s*=\s*true|tournaments_enabled\s*=\s*true/i);
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('leaves the chip roster readers alone', () => {
    for (const chip of [
      'ca_club_members_summary',
      'ca_club_members_page',
      'get_club_players_playing',
    ]) {
      expect(CODE, `${chip} must not be touched by this migration`).not.toContain(chip);
    }
  });

  it('writes who is a player once: live sign-in, open account, not a fixture, horses never named', () => {
    const rule = sliceBetween(RULES, 'CREATE FUNCTION public.fn_diamond_arena_is_player', '$fn$;');
    expect(rule).toContain('JOIN auth.users u ON u.id = pr.id');
    expect(rule).toContain('u.deleted_at IS NULL');
    expect(rule).toContain("pr.status IS DISTINCT FROM 'deleted'");
    expect(rule).toContain('NOT public.fn_ca_is_fixture_account(pr.id)');
    expect(MIG, 'a horse is a player; nothing here may filter on the horse flag').not.toMatch(
      /is_horse/i
    );
    expect(CODE).not.toMatch(/fn_ca_is_cert_account/);
  });

  it('reads every figure through that rule', () => {
    const seated = sliceBetween(
      RULES,
      'CREATE FUNCTION public.fn_diamond_arena_seated_players',
      '$fn$;'
    );
    expect(seated).toContain('public.fn_diamond_arena_is_player(ts.user_id)');
    expect(seated).toContain('ts.left_at IS NULL');
    const open = sliceBetween(
      RULES,
      'CREATE FUNCTION public.fn_diamond_arena_open_tables',
      '$fn$;'
    );
    expect(open).toContain("t.status IN ('waiting', 'running')");
    expect(open).toContain("t.lifecycle IS DISTINCT FROM 'closed'");
    expect(open).toContain('t.is_deleted IS NOT TRUE');
    expect(COUNTS).toContain('WHERE public.fn_diamond_arena_is_player(pr.id);');
    expect(COUNTS).toContain('FROM public.fn_diamond_arena_open_tables(v_arena)');
    expect(COUNTS).toContain('FROM public.fn_diamond_arena_seated_players(v_arena)');
    expect(ROSTER).toContain('WHERE public.fn_diamond_arena_is_player(pr.id)');
    expect(ROSTER).toContain('FROM public.fn_diamond_arena_seated_players(v_arena)');
  });

  it('answers each figure as a number or NULL with a named reason, never a made-up zero', () => {
    for (const figure of ['members', 'tables', 'seated', 'online']) {
      expect(COUNTS).toContain(`v_${figure} := NULL;`);
      expect(COUNTS).toContain(`jsonb_build_object('${figure}', 'read_failed_' || SQLSTATE)`);
    }
    expect(COUNTS.match(/EXCEPTION WHEN OTHERS THEN/g)).toHaveLength(4);
    expect(COUNTS, 'no figure may be coalesced to a zero').not.toMatch(
      /coalesce\(\s*v_(members|online|seated|tables)/i
    );
    expect(COUNTS).toContain("'members', 'arena_not_identified'");
    expect(COUNTS).toContain("'unknown', v_unknown");
  });

  it('counts online only while the presence feed shows the caller', () => {
    const witness = sliceBetween(COUNTS, 'IF v_uid IS NULL THEN', 'RETURN jsonb_build_object(');
    expect(witness).toContain("jsonb_build_object('online', 'no_caller_to_witness')");
    expect(witness).toContain(
      "SELECT coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'"
    );
    expect(witness).toContain('WHERE pr.id = v_uid;');
    const counted = witness.indexOf('SELECT count(*) INTO v_online');
    expect(counted).toBeGreaterThan(witness.indexOf('IF coalesce(v_witness, false) THEN'));
    expect(counted).toBeLessThan(
      witness.indexOf("jsonb_build_object('online', 'presence_not_reported')")
    );
  });

  it('gives a roster row seven fields and nothing chip, hierarchical or horse', () => {
    const row = sliceBetween(ROSTER, 'SELECT jsonb_agg(jsonb_build_object(', 'ORDER BY p.rn)');
    const keys = [...row.matchAll(/'([a-z_]+)', p\./g)].map((m) => m[1]).sort();
    expect(keys).toEqual(
      [
        'alias',
        'avatar_url',
        'is_online',
        'is_seated',
        'player_number',
        'user_id',
        'username',
      ].sort()
    );
    const shape = sliceBetween(ROSTER, 'rows AS MATERIALIZED (', '), page AS MATERIALIZED');
    expect(`${shape}\n${row}`).not.toMatch(
      /\b(role|upline|downline|fees?|rake|wallet|chip_balance|credit|agent|ca_club_roster_rows)/i
    );
    expect(ROSTER).toContain("IF v_filter NOT IN ('all', 'seated') THEN");
  });

  it('opens the two readers to signed-in players only and keeps the rules internal', () => {
    for (const reader of [
      'public.fn_diamond_arena_counts()',
      'public.fn_diamond_arena_roster(text, text, jsonb, integer)',
    ]) {
      expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${reader} FROM PUBLIC, anon;`);
      expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION ${reader} TO authenticated, service_role;`);
    }
    for (const rule of [
      'public.fn_diamond_arena_club()',
      'public.fn_diamond_arena_is_player(uuid)',
      'public.fn_diamond_arena_open_tables(uuid)',
      'public.fn_diamond_arena_seated_players(uuid)',
    ]) {
      expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${rule} FROM PUBLIC, anon, authenticated;`);
    }
    expect(COUNTS).toContain('SECURITY DEFINER');
    expect(ROSTER).toContain('SECURITY DEFINER');
    expect(RULES).not.toContain('SECURITY DEFINER');
    expect(COUNTS).toContain("RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';");
    expect(ROSTER).toContain("RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';");
  });

  it('opens the Diamond Players page by the server entitlement and leaves chip clubs on the chip roster', () => {
    const app = tsCode(read('src/App.tsx'));
    const route = sliceBetween(app, 'path="clubs/:clubId/members"', '/>\n                <Route');
    expect(route).toContain('<ClubMemberGuard>');
    expect(route).toContain('<ClubPlayersDoor />');
    const door = tsCode(read('src/pages/ClubPlayersDoor.tsx'));
    expect(door).toContain(
      'return useAutomaticArenaMembership() ? <DiamondPlayersPage /> : <ClubMembersPage />;'
    );
    expect(door).not.toMatch(/useParams|useLocation|isDiamondArenaClubKey|pathname/);
  });

  it('the Diamond page reads only the Diamond readers', () => {
    const page = tsCode(read('src/pages/DiamondPlayersPage.tsx'));
    const service = tsCode(read('src/services/DiamondArenaRosterService.ts'));
    expect(page).not.toMatch(/ClubRosterService|ca_club_members|supabase/);
    expect(page).not.toMatch(/is_horse|HORSE/);
    expect([...service.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([
      'fn_diamond_arena_counts',
      'fn_diamond_arena_roster',
    ]);
  });
});
