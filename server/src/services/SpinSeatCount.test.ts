/**
 * Dan 2026-08-19: "SPINS ARE ALWAYS 3 HANDED."
 *
 * A Spin & Go is a three-handed hyper by definition — its multipliers, blind
 * structure and prize maths are all built around exactly three players — so the
 * seat count belongs to the FORMAT, not to the config of any one tournament.
 *
 * Production agrees today: 6,252 SPIN tournaments and all 1,772 of their tables
 * are 3-handed. These tests pin the code so it stays that way, because nothing
 * used to stop a config from declaring otherwise: createSpin passed
 * `config.maxPlayers` straight through to the insert.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SPIN_SEATS } from './TournamentRecurringService.js';

const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);

describe('SPIN_SEATS', () => {
  it('is three', () => {
    expect(SPIN_SEATS).toBe(3);
  });
});

describe('createSpin cannot build a Spin with any other seat count', () => {
  it('inserts the constant, not the config value', () => {
    // The regression: `max_players: config.maxPlayers` let a bad config through.
    expect(SRC).toMatch(/max_players:\s*SPIN_SEATS/);
    expect(SRC).toMatch(/min_players:\s*SPIN_SEATS/);
  });

  it('no longer reads the seat count off the spin config at insert time', () => {
    const spinInsert = SRC.slice(SRC.indexOf("tournament_type: 'SPIN'"), SRC.length).slice(0, 900);
    expect(spinInsert).not.toMatch(/max_players:\s*config\.maxPlayers/);
    expect(spinInsert).toMatch(/max_players:\s*SPIN_SEATS/);
  });

  it('does NOT force the seat count on SNG or MTT — they own theirs', () => {
    // Near-miss guard: a first attempt at this patched the SNG insert by
    // mistake, which would have created every future SNG 3-handed instead of
    // its configured 6. Spins are the only format whose seat count is fixed.
    const sngInsert = SRC.slice(SRC.indexOf("tournament_type: 'SNG'")).slice(0, 900);
    expect(sngInsert).toMatch(/max_players:\s*config\.maxPlayers/);
    expect(sngInsert).not.toMatch(/max_players:\s*SPIN_SEATS/);

    const mttInsert = SRC.slice(SRC.indexOf("tournament_type: 'MTT'")).slice(0, 900);
    expect(mttInsert).toMatch(/max_players:\s*config\.maxPlayers/);
    expect(mttInsert).not.toMatch(/max_players:\s*SPIN_SEATS/);
  });

  it('forces the seat count in exactly one place', () => {
    expect([...SRC.matchAll(/max_players:\s*SPIN_SEATS/g)]).toHaveLength(1);
  });

  it('reports a config that disagrees rather than obeying it silently', () => {
    expect(SRC).toMatch(/spin_seat_count_override/);
  });
});

describe('every shipped Spin config already agrees', () => {
  it('declares 3 max and 3 min on every SPIN_CONFIG', () => {
    const start = SRC.indexOf('const SPIN_CONFIGS');
    const end = SRC.indexOf('\n];', start);
    const block = SRC.slice(start, end);
    const maxes = [...block.matchAll(/maxPlayers:\s*(\d+)/g)].map((m) => Number(m[1]));
    const mins = [...block.matchAll(/minPlayers:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(maxes.length).toBeGreaterThan(0);
    for (const n of maxes) expect(n).toBe(SPIN_SEATS);
    for (const n of mins) expect(n).toBe(SPIN_SEATS);
  });
});
