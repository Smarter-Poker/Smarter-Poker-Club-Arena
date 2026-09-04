/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A MUST-MOVE GAME COUNTS ITS PLAYERS LIKE A TOURNAMENT (R10, Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "0/6 SHOULD NEVER BE A THING ON MUST MOVE GAMES, IT SHOULD
 * ACT LIKE A TOURNAMENT COUNTER, AND COUNT HOW MANY PLAYERS ARE INSIDE THIS
 * GAME TYPE."
 *
 * So on the board a game is ONE row (its Main 1), its player figure is the
 * count inside the whole game, it has no capacity and no seat bar, it is
 * never FULL (a full Main opens a feeder), and how many tables are open
 * stands beside the count. The feeder and the other mains are never rows.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cashEntry,
  isClusterFront,
  isHiddenClusterMember,
  seatsTakenLabel,
  type LobbyTableRow,
} from '../src/components/lobby/lobbyEntries';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const base: LobbyTableRow = {
  id: 't-main-1',
  name: 'NLH 1/2 Action',
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 100,
  max_buy_in: 400,
  current_players: 6,
  max_players: 6,
  status: 'running',
} as LobbyTableRow;

const cluster = (over: Partial<LobbyTableRow> = {}): LobbyTableRow => ({
  ...base,
  cluster_id: 'g1',
  role: 'main',
  main_index: 1,
  lifecycle: 'live',
  cluster_must_move: true,
  cluster_template: 'action',
  cluster_state: 'live',
  cluster_players: 57,
  cluster_tables: 10,
  ...over,
});

describe('the board shows the game, not the table', () => {
  it('the players figure is the count inside the whole game, with no capacity', () => {
    const e = cashEntry(cluster());
    expect(e.players).toBe(57);
    expect(e.capacity).toBe(0);
    expect(e.game).toEqual({
      id: 'g1',
      mustMove: true,
      template: 'action',
      tables: 10,
      state: 'live',
    });
    expect(seatsTakenLabel(e)).toBe('57');
  });

  it('a full Main is not a full game: status is running or open, never full', () => {
    expect(cashEntry(cluster({ current_players: 6, max_players: 6 })).status).toBe('running');
    expect(cashEntry(cluster({ cluster_players: 0, current_players: 0 })).status).toBe('open');
    expect(cashEntry(cluster({ cluster_players: 0, current_players: 0 })).statusLabel).toBe('Open');
  });

  it('carries the MUST MOVE medallion first, with the template', () => {
    const e = cashEntry(cluster());
    expect(e.rules[0]).toMatchObject({ key: 'must_move', label: 'MUST MOVE', detail: 'ACTION' });
    const manual = cashEntry(cluster({ cluster_must_move: false }));
    expect(manual.rules[0]).toMatchObject({ key: 'manual_table', label: 'MANUAL' });
    expect(manual.game?.mustMove).toBe(false);
  });

  it('only Main 1 is a row; the feeder and the other mains are hidden', () => {
    expect(isClusterFront(cluster())).toBe(true);
    expect(isHiddenClusterMember(cluster())).toBe(false);
    expect(isHiddenClusterMember(cluster({ role: 'feeder', main_index: null }))).toBe(true);
    expect(isHiddenClusterMember(cluster({ role: 'main', main_index: 2 }))).toBe(true);
    // A fleet table is neither.
    expect(isClusterFront(base)).toBe(false);
    expect(isHiddenClusterMember(base)).toBe(false);
  });

  it('a fleet table is unchanged: its own count, its own capacity, its own status', () => {
    const e = cashEntry(base);
    expect(e.players).toBe(6);
    expect(e.capacity).toBe(6);
    expect(e.game).toBeUndefined();
    expect(e.status).toBe('full');
  });
});

describe('the wiring', () => {
  it('the club home filters hidden cluster members before building rows', () => {
    const page = read('src/pages/ClubHomePage.tsx');
    expect(page).toMatch(
      /\.filter\(\(t\) => !isHiddenClusterMember\(t as unknown as LobbyTableRow\)\)/
    );
  });

  it('the seats meter never draws a bar or a denominator for a game', () => {
    const table = read('src/components/lobby/LobbyTable.tsx');
    expect(table).toMatch(/if \(entry\.game\) return <GameCounter entry=\{entry\} \/>;/);
    const counter = table.slice(
      table.indexOf('function GameCounter'),
      table.indexOf('function SeatsMeter')
    );
    expect(counter).not.toMatch(/capacity|lt-seats__bar/);
    expect(counter).toMatch(/'Table' : 'Tables'/);
  });

  it('get_club_home carries the game-wide figures and drops closed cluster tables', () => {
    const sql = read('supabase/migrations/20260905020000_r10_a_game_counts_its_players.sql');
    for (const col of [
      'cluster_players',
      'cluster_tables',
      'cluster_must_move',
      'cluster_template',
      'cluster_state',
    ]) {
      expect(sql).toContain(`AS ${col}`);
    }
    expect(sql).toMatch(/AND COALESCE\(lifecycle, 'live'\) <> 'closed'/);
    expect(sql).toMatch(/ts\.left_at IS NULL AND t2\.lifecycle <> 'closed'/);
  });

  it('the fleet seeds a cluster table before its own clones', () => {
    const fleet = read('server/src/services/HorseFleetManager.ts');
    expect(fleet).toMatch(/Number\(!!b\.cluster_id\) - Number\(!!a\.cluster_id\)/);
  });
});
