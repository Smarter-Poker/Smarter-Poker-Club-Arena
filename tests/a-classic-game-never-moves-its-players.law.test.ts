/**
 * A CLASSIC GAME NEVER MOVES ITS PLAYERS (Dan 2026-10-24)
 *
 * "THIS HAS GOT TO BE FIXED AT ONCE, PLAYERS SHOULD NOT BE MOVING ON CLASSIC
 * GAMES PERIOD. FIX THAT BUG AT ITS ROOT CAUSE AND PREVENT IT FROM HAPPENING
 * AGAIN."
 *
 * 26 of the 50 enabled Classic games (Midway Union's Classic lineup) carried
 * must_move = true, so the cluster tick moved their players: Main seats drew
 * from the feeder ('must_move'), short tables were broken ('break') and the
 * feeders were balanced ('balance'). 20261024213758 keeps their table
 * management and removes every automatic move, and a trigger on
 * cash_seat_moves refuses any move but the player's own seat change for a
 * Classic game, whoever plans it. This law pins all of it, and the lobby card
 * that used to promise the move.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cashEntry, type LobbyTableRow } from '../src/components/lobby/lobbyEntries';
import {
  MADNESS_WITHOUT_LIGHTNING_PROFILE,
  cashGameNeverMovesPlayers,
} from '../src/config/classicNeverMovesPlayers';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261024213758_a_classic_game_never_moves_its_players.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');

describe('a Classic game never moves its players', () => {
  it('has one definition: Classic, except the Madness stand-in rules profile', () => {
    expect(SQL).toContain(
      "SELECT coalesce(p_template, '') = 'classic'\n     AND coalesce(p_ruleset->>'rules_profile', '') <> 'madness_without_lightning'"
    );
    // The post-image proves the definition says what it should.
    for (const check of [
      "IF NOT public.fn_cash_game_never_moves_players('classic', '{}'::jsonb)",
      'OR public.fn_cash_game_never_moves_players(\'classic\', \'{"rules_profile":"madness_without_lightning"}\'::jsonb)',
      "OR public.fn_cash_game_never_moves_players('madness', '{}'::jsonb)",
      "OR public.fn_cash_game_never_moves_players('action', '{}'::jsonb)",
      'OR public.fn_cash_game_never_moves_players(NULL, NULL) THEN',
    ])
      expect(SQL, check).toContain(check);
  });

  it('the tick plans no must-move, breaks only an empty table and withdraws a break under players', () => {
    expect(SQL).toContain(
      'v_classic := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);'
    );
    expect(SQL).toContain(
      "'            WHERE NOT v_classic AND c.role = ''main'' AND c.lifecycle = ''live'' AND c.open_unreserved > 0'"
    );
    expect(SQL).toContain("'     AND (NOT v_classic OR (c.seated = 0 AND c.reserved = 0))'");
    expect(SQL).toContain("'    IF v_classic THEN'");
    expect(SQL).toContain(
      "'      UPDATE public.tables SET lifecycle = ''live'', break_started_at = NULL, break_eligible_since = NULL, updated_at = now()'"
    );
    expect(SQL).toContain(
      "'      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, ''classic_break_withdrawn'');'"
    );
  });

  it('patches the live tick and balancer by asserted single anchors over a stated pre-image', () => {
    expect(SQL).toContain("IF md5(v_src) <> '801638baef58f9f44ff4e80e24c153ab' THEN");
    expect(SQL).toContain("IF md5(v_src) <> '3c4b563f1f00b4372ebd024c7494a884' THEN");
    // Tick: declaration, read, must-move, break candidate, break moves (5);
    // balancer guard (1); lobby game object (1).
    expect(SQL.match(/IF v_n <> 1 THEN RAISE EXCEPTION/g)?.length).toBe(7);
    // Every sibling step of the tick must survive the edit.
    for (const sibling of [
      "'''lightning_cluster_stands_down'''",
      "'''manual_game'''",
      "'''ticking_elsewhere'''",
      "'''feeder_abandoned'''",
      "'''table_break_completed'''",
      "'-- ── 2b. SEAT CHANGES'",
    ])
      expect(SQL, sibling).toContain(`position(${sibling} in v_src) = 0`);
  });

  it('the balancer plans nothing for a Classic game', () => {
    expect(SQL).toContain(
      'WHERE cg.id = p_game_id AND public.fn_cash_game_never_moves_players(cg.template_name, cg.ruleset_snapshot)) THEN'
    );
  });

  it('PREVENTS IT FROM HAPPENING AGAIN: the move ledger refuses every automatic Classic move', () => {
    expect(SQL).toContain(
      "IF NEW.reason IS DISTINCT FROM 'seat_change' AND EXISTS (\n       SELECT 1 FROM public.cash_games g"
    );
    expect(SQL).toContain("RAISE EXCEPTION 'CLASSIC_GAME_NEVER_MOVES_PLAYERS:");
    expect(SQL).toContain(
      'CREATE TRIGGER a_classic_game_never_moves_players\n  BEFORE INSERT OR UPDATE OF reason, game_id ON public.cash_seat_moves'
    );
    expect(SQL).toContain("AND tgname = 'a_classic_game_never_moves_players' AND tgenabled = 'O'");
  });

  it('cancels what was already planned and touches no seat, stack, wallet or hand', () => {
    expect(SQL).toContain("SET state = 'cancelled', note = 'classic_game_never_moves_players'");
    expect(SQL).toContain("AND m.reason <> 'seat_change'");
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM)\s+public\.(table_seats|club_members|chip_ledger|hand_history)/i
    );
    expect(code).not.toMatch(
      /UPDATE\s+public\.(table_seats|club_members|chip_ledger|wallets|hand_history)\b/i
    );
    expect(code).not.toMatch(/cron\./i);
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
  });

  it('is the newest definition of the tick and the balancer', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) => {
        const text = readFileSync(join(MIGRATIONS, f), 'utf8');
        return (
          text.includes('fn_cash_cluster_tick(uuid,integer)') ||
          text.includes('FUNCTION public.fn_cash_cluster_tick(') ||
          text.includes('FUNCTION public.fn_cash_cluster_balance(')
        );
      });
    // A later migration that redefines either must keep the Classic rule.
    for (const f of later)
      expect(readFileSync(join(MIGRATIONS, f), 'utf8'), f).toContain(
        'fn_cash_game_never_moves_players('
      );
  });

  it('the on-table lobby hears it from the database, which adds exactly one key', () => {
    expect(SQL).toContain("IF md5(v_src) <> '1fb26fc0037a7491d6f259d526fc0217' THEN");
    expect(SQL).toContain(
      "'                               ''never_moves_players'', public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot)),'"
    );
    const modal = readFileSync(join(ROOT, 'src/components/table/MustMoveLobbyModal.tsx'), 'utf8');
    expect(modal).toContain('const neverMoves = game?.never_moves_players === true;');
    expect(modal).toContain('{!neverMoves && (');
  });

  it('the board mirror is the same two lines as the SQL definition', () => {
    expect(cashGameNeverMovesPlayers('classic', null)).toBe(true);
    expect(cashGameNeverMovesPlayers('Classic', undefined)).toBe(true);
    expect(cashGameNeverMovesPlayers('classic', 'madness_without_lightning')).toBe(false);
    expect(cashGameNeverMovesPlayers('madness', null)).toBe(false);
    expect(cashGameNeverMovesPlayers('action', null)).toBe(false);
    expect(cashGameNeverMovesPlayers(null, null)).toBe(false);
    expect(SQL).toContain(`<> '${MADNESS_WITHOUT_LIGHTNING_PROFILE}'`);
    const home = readFileSync(join(ROOT, 'src/pages/ClubHomePage.tsx'), 'utf8');
    expect(home).toContain('rules_profile:ruleset_snapshot->>rules_profile');
    expect(home).toContain('cluster_rules_profile: game.rules_profile ?? null,');
  });

  it('the lobby never promises a Classic player a move', () => {
    const row = {
      id: 't1',
      name: 'NLH 0.25/0.50 Classic Main 1',
      game_variant: 'nlh',
      cluster_id: 'g1',
      cluster_must_move: true,
      cluster_template: 'classic',
      cluster_mode: 'must_move',
      cluster_tables: 4,
      cluster_players: 20,
      max_players: 9,
      current_players: 9,
    } as unknown as LobbyTableRow;
    const entry = cashEntry(row);
    const labels = JSON.stringify(entry.rules ?? []);
    expect(labels).not.toContain('MUST MOVE');
    expect(labels).not.toContain('Pull Players Off The Feeder');
    const madness = cashEntry({ ...row, cluster_template: 'madness' } as LobbyTableRow);
    expect(JSON.stringify(madness.rules ?? [])).not.toContain('Your Seat Is Yours');
    // Same row, same path: the pill is drawn, so the Classic assertion is not vacuous.
    expect(JSON.stringify(madness.rules ?? [])).toContain('MUST MOVE');
    expect(labels).toContain('CLASSIC');
    // The Madness stand-in is a Classic-template row with its own profile.
    const standIn = cashEntry({
      ...row,
      cluster_rules_profile: MADNESS_WITHOUT_LIGHTNING_PROFILE,
    } as LobbyTableRow);
    expect(JSON.stringify(standIn.rules ?? [])).toContain('MUST MOVE');
  });
});
