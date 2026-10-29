/**
 * The owner's switch-off door answers a replayed request from its own ledger
 * (2026-10-25, 20261025025922).
 *
 * fn_cash_game_switch_off used to answer a replay by reading the cluster
 * event log: game_id through cash_cluster_events_by_game, then kind and
 * request_id in the heap. One Lightning game holds over a million of those
 * rows, the lookup took 41.8 s to find nothing, and the 8 s budget refused the
 * pilot switch-off (20261024213143) twice and the owner's app call for any
 * busy game. These pins keep the slow read from coming back.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const files = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const read = (f: string) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');

/** The newest non-superseded migration that (re)defines the door is the live one. */
const latestDoor = (): { file: string; body: string } => {
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_cash_game_switch_off\s*\(/i;
  for (const f of files().reverse()) {
    const sql = read(f);
    // The marker is the file's first line by convention (check-migrations-are-live).
    if (/^--\s*SUPERSEDED BY\s+\d{14}/.test(sql.split('\n', 1)[0])) continue;
    if (re.test(sql)) return { file: f, body: sql.slice(sql.search(re)) };
  }
  throw new Error('no migration defines fn_cash_game_switch_off');
};

describe('the owner switch-off answers a replay from its own ledger', () => {
  it('the live door reads its ledger by primary key, never the cluster event log', () => {
    const { file, body } = latestDoor();
    const fn = body.slice(0, body.indexOf('$fn$;') + 5);
    expect(fn, `${file} must define the door with a $fn$ body`).toContain('$fn$');
    expect(fn, `${file}: the replay lookup is back on cash_cluster_events`).not.toMatch(
      /FROM\s+public\.cash_cluster_events/i
    );
    expect(fn).toMatch(
      /FROM\s+public\.cash_game_switch_off_requests\s+r\s+WHERE\s+r\.game_id\s*=\s*p_game_id\s+AND\s+r\.request_id\s*=\s*p_request_id/i
    );
  });

  it('the live door writes its ledger row with the event it records', () => {
    const { body } = latestDoor();
    const fn = body.slice(0, body.indexOf('$fn$;') + 5);
    const event = fn.search(/INSERT\s+INTO\s+public\.cash_cluster_events/i);
    const ledger = fn.search(/INSERT\s+INTO\s+public\.cash_game_switch_off_requests/i);
    expect(event).toBeGreaterThan(0);
    expect(ledger).toBeGreaterThan(event);
  });

  it('the ledger carries no foreign key to a hot table', () => {
    const sql = read(
      files().find((f) => f.endsWith('_the_owner_switch_off_answers_a_replay_from_its_own_ledger.sql'))!
    );
    const table = sql.slice(
      sql.indexOf('CREATE TABLE public.cash_game_switch_off_requests'),
      sql.indexOf(');', sql.indexOf('CREATE TABLE public.cash_game_switch_off_requests'))
    );
    expect(table).toContain('PRIMARY KEY (game_id, request_id)');
    expect(table).not.toMatch(/REFERENCES/i);
  });

  it('the refused pilot switch-off is marked superseded by the file that replaced it', () => {
    const old = read('20261024213143_lightning_pilot_games_switch_off_so_the_horses_stand_up.sql');
    expect(old.split('\n')[0]).toMatch(/^-- SUPERSEDED BY 20261025025922\b/);
    expect(files().some((f) => f.startsWith('20261025025922_'))).toBe(true);
  });
});
