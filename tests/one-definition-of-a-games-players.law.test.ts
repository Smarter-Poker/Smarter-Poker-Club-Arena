/**
 * ONE DEFINITION OF A GAME'S PLAYERS AND TABLES (2026-09-06).
 *
 * Three places answered "how many players and tables are in this cash game"
 * and all three answered differently. `fn_cash_cluster_census` is
 * authoritative - it is what `fn_cash_cluster_tick` reads to decide what the
 * game IS: how many tables it has, which is Main 1, when a feeder opens and
 * when one breaks. A read path that disagrees with it shows the player a
 * different game from the one the controller is running.
 *
 *                          is_deleted   status IN (...)   lifecycle <> closed
 *   fn_cash_cluster_census    yes            yes                 yes
 *   get_club_home.players     NO             NO                  yes
 *   get_club_home.tables      NO             yes                 yes
 *   fn_cash_game_lobby        yes            NO                  yes
 *
 * `get_club_home` disagreed WITH ITSELF: a seat on a table it did not count
 * as a table was still counted as a player, which is the shape of the
 * original "50 players, one sitting" complaint.
 *
 * Migration 20260906163151 gives all three the census predicate. On the board
 * the day it shipped nothing changed (108 games, zero counts moved) - they
 * agreed by luck, and this is what makes them agree by construction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase/migrations/20260906163151_one_definition_of_a_games_players_and_tables.sql'
  ),
  'utf8'
);

/* The file carries three things that all mention the predicate: the header
   prose, the two function bodies, and the VERIFY block. Only the BODIES are
   the rule, so each window is the function it is about - never the file, and
   never a byte count (tests/helpers/sourceWindow). */
const fnBody = (name: string): string => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not re-emitted by this migration`).toBeGreaterThan(-1);
  const open = SQL.indexOf('$function$', start);
  const close = SQL.indexOf('$function$', open + '$function$'.length);
  expect(close).toBeGreaterThan(open);
  return SQL.slice(open, close);
};
const CLUB_HOME = fnBody('get_club_home');
const LOBBY = fnBody('fn_cash_game_lobby');

describe('all three carry the census predicate', () => {
  it('get_club_home filters is_deleted in BOTH cluster subqueries', () => {
    const hits = CLUB_HOME.match(/COALESCE\(t2\.is_deleted, false\) = false/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('get_club_home filters status in BOTH cluster subqueries', () => {
    const hits = CLUB_HOME.match(/t2\.status IN \('waiting','running','active'\)/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('fn_cash_game_lobby lists only tables the controller counts', () => {
    expect(LOBBY).toContain("AND t.status IN ('waiting', 'running', 'active')");
    expect(LOBBY).toContain('coalesce(t.is_deleted, false) = false');
  });

  it('every one of them still excludes a closed lifecycle', () => {
    expect((CLUB_HOME.match(/lifecycle <> 'closed'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(LOBBY).toContain("lifecycle <> 'closed'");
  });
});

describe('the migration proves it against the live board, not just its own text', () => {
  it('asserts every enabled game agrees with fn_cash_cluster_census', () => {
    expect(SQL).toContain('public.fn_cash_cluster_census(g.id)');
    expect(SQL).toContain('still disagrees with fn_cash_cluster_census');
    // Every enabled game, not a sample.
    expect(SQL).toContain('FROM public.cash_games g\n     WHERE g.enabled');
  });

  it('is one transaction, as the production DDL policy requires', () => {
    expect((SQL.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((SQL.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });
});
