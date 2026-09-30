/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND TABLE RANKS ITS OWN HANDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 1 ("Scope histories/replays,
 * earnings, stats, leaderboards and wallet records to Diamond"). Migration
 * 20260930043000_a_diamond_table_ranks_its_own_hands.
 *
 * The table Leaderboard read player_stats, which never holds a Diamond hand,
 * so at a Diamond table it was empty for ever. The Diamond stat rows keep only
 * a player's newest 1,000 hands per asset, so a window cannot be read back
 * from them either. What this pins:
 *  - the post-commit projection folds each Diamond cash hand into private
 *    per-player, per-day running totals from that hand's own Diamond stat
 *    rows, by asserted substitution (live md5 pinned, reverse proved), keeping
 *    chip Projection 2's population (cash hands, seats with a profile);
 *  - the Diamond board is the chip profit board clause for clause (window,
 *    score, order, ties, activity rule, rank change), read from those totals,
 *    with fixture accounts out and horses in;
 *  - a signed-in player may read it and a visitor may not; the chip board is
 *    not touched, and nothing is priced or opened;
 *  - a Diamond table asks the Diamond board through the one arena source the
 *    table already has, with loading, empty and could-not-tell states, and a
 *    chip table asks and renders exactly as before.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText, migrationsMentioning } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_table_ranks_its_own_hands.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond board migration is missing');
const MIG = migrationText(NAME);
const code = (s: string) => s.replace(/--[^\n]*/g, ' ');
const squash = (s: string) => s.replace(/\s+/g, '');
const CODE = code(MIG);
const TOTALS = sliceBetween(
  MIG,
  '-- 2. THE DIAMOND RUNNING TOTALS',
  '-- 3. THE PROJECTION FOLDS EACH DIAMOND CASH HAND'
);
const FOLD = sliceBetween(
  MIG,
  '-- 3. THE PROJECTION FOLDS EACH DIAMOND CASH HAND',
  '-- 4. THE DIAMOND BOARD'
);
const READER = code(sliceBetween(MIG, '-- 4. THE DIAMOND BOARD', '-- 5. THE ESTATE IS AS IT WAS'));
const FINAL = code(sliceBetween(MIG, '-- 5. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const CHIP_HEAD = 'CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_period_v2(';
const CHIP_MIG = migrationsMentioning(CHIP_HEAD)
  .filter((m) => m.name !== NAME)
  .at(-1);
if (!CHIP_MIG) throw new Error('the chip board definition is missing from the corpus');
const CHIP = squash(sliceBetween(CHIP_MIG.sql, CHIP_HEAD, '$function$;'));

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('LAW: a Diamond table ranks its own hands', () => {
  it('prices nothing, opens no switch and leaves the chip board as it was', () => {
    expect(CODE).not.toMatch(/cash_games_enabled\s*=\s*true|tournaments_enabled\s*=\s*true/i);
    expect(CODE).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_club_leaderboard_period_v2/i
    );
    expect(FINAL).toContain("<> 'b44ad44876dbf9bb20b85193ae794013'");
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('keeps the running totals private, one row per player per day', () => {
    expect(TOTALS).toContain('PRIMARY KEY (user_id, stat_date)');
    expect(TOTALS).toContain('ALTER TABLE public.ca_diamond_player_day ENABLE ROW LEVEL SECURITY;');
    expect(TOTALS).toContain(
      'REVOKE ALL ON TABLE public.ca_diamond_player_day FROM PUBLIC, anon, authenticated;'
    );
    expect(TOTALS).not.toMatch(/CREATE\s+POLICY|TO\s+(anon|authenticated)/i);
    expect(FINAL).toContain('the Diamond running totals must be private to the server');
  });

  it('folds each Diamond cash hand once, from its own stat rows, by asserted substitution', () => {
    expect(FOLD).toContain("IF md5(v_def) <> 'daf6adcc7fb0784004f60a28a70b97cb' THEN");
    expect(FOLD).toContain('IF v_n <> 1 THEN');
    expect(FOLD).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(FOLD).toContain(
      "IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'daf6adcc7fb0784004f60a28a70b97cb' THEN"
    );
    const added = sliceBetween(FOLD, 'v_new text := $f$', '$f$;');
    expect(added).toContain(
      'IF COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL AND v_club IS NOT NULL THEN'
    );
    expect(added).toContain('FROM public.ca_hand_player_stat s');
    expect(added).toContain("WHERE s.hand_id=v_h.id AND s.asset='diamonds' AND s.is_cash");
    expect(added).toContain('AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.user_id)');
    expect(added).toContain('s.won_amt,s.invested_actions+s.my_blind');
    expect(added).toContain('ORDER BY s.user_id');
    expect(added, 'a Diamond figure never reaches a chip table').not.toMatch(
      /player_stats\b|club_member_daily_stats/
    );
    expect(FINAL).toContain(
      'the post-commit projection does not fold a Diamond cash hand exactly once'
    );
  });

  it.each([
    'FROMpublic.fn_leaderboard_period_window(p_period,0)bounds;',
    'ELSE(c.p_win-c.p_loss)END)ASprev_score',
    'row_number()OVER(ORDERBYs.scoreDESCNULLSLAST,s.uid)ASrn_now',
    'rank()OVER(ORDERBYs.scoreDESCNULLSLAST)ASrk_now',
    'count(*)OVER()AStotal_active',
    'CASEWHENs.prev_scoreISNULLTHENNULLELSErank()OVER(ORDERBYs.prev_scoreDESCNULLSLAST)ENDASrk_old',
    'WHERE(s.d_hands>0ORs.d_twon>0ORs.d_win<>0ORs.d_loss<>0)',
    'COALESCE((r.rk_old-r.rk_now)::integer,0)',
    'r.rk_now::integer,r.total_active::integer',
    'ORDERBYr.rn_nowLIMITp_limitOFFSETGREATEST(COALESCE(p_offset,0),0);',
  ])('ranks as the chip board does: %s', (clause) => {
    expect(CHIP).toContain(clause);
    expect(squash(READER)).toContain(clause);
  });

  it('scores profit as the chip board does, in the Diamond record, with fixtures out and horses in', () => {
    expect(CHIP).toContain('ELSE(c.d_win-c.d_loss)END)ASscore');
    expect(squash(READER)).toContain('(c.d_win-c.d_loss)ASscore');
    expect(READER).toContain('FROM public.ca_diamond_player_day d');
    expect(READER).toContain("AND (tp.position = 1 OR tp.status = 'winner')");
    expect(READER).toContain('WHERE NOT public.fn_ca_is_fixture_account(coalesce(dy.uid, w.uid))');
    expect(READER, 'no chip record is read').not.toMatch(/player_stats|club_member_daily_stats/);
    expect(MIG, 'a horse is a player; nothing here may filter on the horse flag').not.toMatch(
      /is_horse/i
    );
    expect(
      CODE,
      'the cert predicate matches horses and must never scope a player rule'
    ).not.toMatch(/fn_ca_is_cert_account/);
  });

  it('lets a signed-in player read the board and a visitor not', () => {
    const reader = 'public.fn_diamond_arena_leaderboard_period(text, integer, integer)';
    expect(READER).toContain('SECURITY DEFINER');
    expect(READER).toContain('SET search_path = public, pg_temp');
    expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${reader} FROM PUBLIC, anon, authenticated;`);
    expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION ${reader} TO authenticated, service_role;`);
    expect(FINAL).toContain("has_function_privilege('anon', v_reader, 'EXECUTE')");
  });

  it('asks the Diamond board at a Diamond table and the chip board, as before, at a chip one', () => {
    const page = read('src/pages/TablePage.tsx');
    const board = sliceBetween(
      page,
      "// THE DIAMOND ARENA'S BOARD",
      '// Sound & vibration preferences'
    );
    expect(board).toContain("const leaderboardIsDiamond = tableState.arenaAsset === 'diamonds';");
    expect(board).toContain('? await LeaderboardService.getDiamondArenaLeaderboard(');
    expect(board).toContain(': await LeaderboardService.getClubLeaderboard(');
    expect(board).toContain("setDiamondLeaderboardState('failed');");
    expect(board).toContain('[showLeaderboard, leaderboardPeriod, userId, leaderboardIsDiamond]');
    expect(page).toContain(
      'leaderboardDiamondState={leaderboardIsDiamond ? diamondLeaderboardState : undefined}'
    );

    const service = read('src/services/LeaderboardService.ts');
    const door = sliceBetween(
      service,
      'async getDiamondArenaLeaderboard(',
      'async getGlobalLeaderboard('
    );
    expect(door).toContain("supabase.rpc('fn_diamond_arena_leaderboard_period', {");
    expect(door, 'a failed read is could-not-tell, never an empty board').toContain('throw ');
    expect(door).toContain("decorateWithProfiles(data as PlayerStatsRow[], 'profit')");

    const layer = read('src/components/table/TableModalsLayer.tsx');
    expect(layer).toContain("isLoading={leaderboardDiamondState === 'loading'}");
    expect(layer).toContain("unavailable={leaderboardDiamondState === 'failed'}");
    expect(layer).toContain("currency={leaderboardDiamondState ? 'Diamonds' : undefined}");

    const panel = read('src/components/table/LeaderboardPanel.tsx');
    const couldNotTell = sliceBetween(panel, ') : unavailable ? (', ') : players.length === 0 ? (');
    expect(couldNotTell).toContain('Rankings Unavailable');
    expect(couldNotTell).toContain(
      'The Rankings Could Not Be Read. Close And Reopen To Try Again.'
    );
    expect(couldNotTell).not.toContain(String.fromCharCode(0x2014));
  });
});
