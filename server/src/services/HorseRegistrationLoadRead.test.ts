/**
 * THE REGISTRATION-LOAD READ STARTS FROM THE OPEN EVENTS (2026-10-02).
 *
 * horseLoadMap's registration half read `tournament_players` ordered by
 * user_id and joined each of the ~2,000 open rows (most of them registrations
 * in RUNNING events, which the join then discards) to `tournaments` one
 * primary-key probe at a time. PostgREST puts LIMIT/OFFSET inside that join,
 * so the planner could never turn it around. Measured on production:
 * 110,931 calls, mean 422 ms, ~18,000 buffers a call, 13 hours of database
 * time in four days, and at each maintenance-break thaw it hit the 8 s
 * statement timeout 23 to 43 times in one minute
 * (`horse_load_registrations_failed`), so every waiting seat-first board got
 * "top-up added 0 of 1 needed" (`seat_first_human_waiting`).
 *
 * Starting from the ~350 ANNOUNCED/REGISTERING/BAGGED events inside the
 * booking horizon and reading their registrations through the
 * (tournament_id, status) index answers the same question in ~2,000 buffers
 * and ~11 ms warm. Same rows, same rule, no new timeout.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { flattenOpenEventRegistrations } from './TournamentRecurringService.js';

const loadBody = (): string => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
    'utf8'
  );
  const start = src.indexOf('private async horseLoadMap');
  return src.slice(start, src.indexOf('private static atCapacity', start));
};

describe('the horse registration-load read', () => {
  it('is driven from the open events, not from every open registration', () => {
    const body = loadBody();
    expect(body).not.toMatch(/\.from\('tournament_players'\)/);
    expect(body).toContain(
      ".select('id, tournament_players!tournament_players_tournament_id_fkey!inner(user_id)')"
    );
    expect(body).toContain(".in('status', ['ANNOUNCED', 'REGISTERING', 'BAGGED'])");
    expect(body).toContain(".in('tournament_players.status', ['registered', 'playing'])");
    expect(body).toMatch(/\.or\(`start_time\.is\.null,start_time\.lte\.\$\{horizonIso\}`\)/);
    expect(body).toContain(".order('id', { ascending: true })");
  });

  it('yields one load reference per registration, keyed by its event', () => {
    expect(
      flattenOpenEventRegistrations([
        { id: 't1', tournament_players: [{ user_id: 'h1' }, { user_id: 'h2' }] },
        { id: 't2', tournament_players: [{ user_id: 'h1' }] },
        { id: 't3', tournament_players: [] },
        { id: 't4', tournament_players: null },
      ])
    ).toEqual([
      { user_id: 'h1', tournament_id: 't1' },
      { user_id: 'h2', tournament_id: 't1' },
      { user_id: 'h1', tournament_id: 't2' },
    ]);
  });

  it('reads a to-one shaped embed rather than losing the registration', () => {
    expect(
      flattenOpenEventRegistrations([{ id: 't9', tournament_players: { user_id: 'h7' } }])
    ).toEqual([{ user_id: 'h7', tournament_id: 't9' }]);
  });
});
