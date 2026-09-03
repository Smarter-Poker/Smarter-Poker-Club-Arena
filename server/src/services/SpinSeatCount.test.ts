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
import { SPIN_SEATS, SPIN_CONFIGS } from './TournamentRecurringService.js';

const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);

describe('SPIN_SEATS', () => {
  it('is three', () => {
    expect(SPIN_SEATS).toBe(3);
  });
});

/**
 * The insert object for one tournament type, bounded by where it actually
 * ends rather than by a fixed character count.
 *
 * These three windows used to be `.slice(0, 900)`. That is a guess about how
 * long the block is, and on 2026-08-20 it stopped being true: a few added
 * comment lines pushed `max_players: SPIN_SEATS` past character 900 and the
 * guard failed against code that was entirely correct. A test that breaks when
 * a comment is added is a test people learn to ignore.
 */
function insertBlock(src: string, tournamentType: string): string {
  const start = src.indexOf(`tournament_type: '${tournamentType}'`);
  expect(start, `no ${tournamentType} insert`).toBeGreaterThan(-1);
  const end = src.indexOf('.select()', start);
  expect(end, `${tournamentType} insert does not end in .select()`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('createSpin cannot build a Spin with any other seat count', () => {
  it('inserts the constant, not the config value', () => {
    // The regression: `max_players: config.maxPlayers` let a bad config through.
    expect(SRC).toMatch(/max_players:\s*SPIN_SEATS/);
    expect(SRC).toMatch(/min_players:\s*SPIN_SEATS/);
  });

  it('no longer reads the seat count off the spin config at insert time', () => {
    const spinInsert = insertBlock(SRC, 'SPIN');
    expect(spinInsert).not.toMatch(/max_players:\s*config\.maxPlayers/);
    expect(spinInsert).toMatch(/max_players:\s*SPIN_SEATS/);
  });

  it('does NOT force the seat count on SNG or MTT - they own theirs', () => {
    // Near-miss guard: a first attempt at this patched the SNG insert by
    // mistake, which would have created every future SNG 3-handed instead of
    // its configured 6. Spins are the only format whose seat count is fixed.
    const sngInsert = insertBlock(SRC, 'SNG');
    expect(sngInsert).toMatch(/max_players:\s*config\.maxPlayers/);
    expect(sngInsert).not.toMatch(/max_players:\s*SPIN_SEATS/);

    const mttInsert = insertBlock(SRC, 'MTT');
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
  /**
   * Dan 2026-08-21: this used to SCRAPE THE SOURCE for `maxPlayers: <digits>`
   * and assert every literal was 3. That worked while the configs were five
   * hand-written objects, and broke the moment the spin board became generated
   * (buy-in ladder x variants) - because the generator writes the CONSTANT,
   * `maxPlayers: SPIN_SEATS`, which matches no digit. The regex found zero
   * entries and the `toBeGreaterThan(0)` guard failed against code that is
   * strictly MORE correct than what it was written to police: a literal can
   * drift from SPIN_SEATS, the constant cannot.
   *
   * It asserts the real exported array now. Same intent, no dependence on how
   * the configs happen to be written.
   */
  it('declares 3 max and 3 min on every SPIN_CONFIG', () => {
    expect(SPIN_CONFIGS.length).toBeGreaterThan(0);
    for (const c of SPIN_CONFIGS) {
      expect(c.maxPlayers, `${c.name} maxPlayers`).toBe(SPIN_SEATS);
      expect(c.minPlayers, `${c.name} minPlayers`).toBe(SPIN_SEATS);
    }
  });

  /**
   * The board must never start a game the instant it is created - Dan
   * 2026-08-21: "the tables just stay open until players sit down". A full
   * horse fill is what made every spin RUNNING and nothing joinable.
   */
  it('leaves at least one seat open for a human', () => {
    for (const c of SPIN_CONFIGS) {
      expect(c.horsesToRegister, `${c.name} horsesToRegister`).toBeLessThan(SPIN_SEATS);
    }
  });

  /** Every price point on the board is a whole number of chips. */
  it('prices every spin in whole chips', () => {
    for (const c of SPIN_CONFIGS) {
      expect(Number.isInteger(c.buyIn), `${c.name} buyIn ${c.buyIn}`).toBe(true);
      expect(c.buyIn).toBeGreaterThan(0);
    }
  });

  /** Names are the board's identity key - ensureBoardOpen dedupes on them. */
  it('gives every board entry a unique name', () => {
    const names = SPIN_CONFIGS.map((c) => c.name);
    expect(new Set(names).size, 'duplicate spin config names').toBe(names.length);
  });
});
