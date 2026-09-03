/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HEADS-UP GAME IS NOT SHORT OF PLAYERS. IT IS FULL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TournamentManagerBase.start() refused to start any tournament with fewer
 * than THREE registered players. The literal 3 was written for Spins, which
 * have three seats. A heads-up game has TWO, so it could never satisfy the
 * gate no matter who registered -- it was rejected for being full.
 *
 * Measured in production on 2026-08-23: SEVENTEEN heads-up games (every one
 * on the platform) sat in REGISTERING for FIFTY HOURS. Each had two paid
 * entrants, zero tables ever created, and was re-examined every five seconds
 * by the discovery loop, which stood it down every single time and then asked
 * the top-up to find a third player for a two-seat table.
 *
 * The companion fault is the counter. tournaments.current_players was
 * maintained by hand at every call site, so it drifted, and two things read
 * it: the lobby (which advertised free seats in a full game -- how Dan was
 * admitted as a fourth entrant to a three-handed Spin) and the engine's
 * "is it full?" test (so a game with every seat sold never started). Two
 * Spins were live in that state, stuck ten and fourteen hours with three
 * bodies in three seats behind a counter that said 2.
 *
 * It is now COUNTED by the database, not narrated by callers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const base = read('server/src/tournament/TournamentManagerBase.ts');
const baseCode = stripComments(base);

const migrationsDir = resolve(root, 'supabase/migrations');
const counterMigration = readdirSync(migrationsDir)
  .filter((f) => f.includes('current_players_is_counted'))
  .map((f) => readFileSync(resolve(migrationsDir, f), 'utf8'))
  .join('\n');

describe('the start gate is capped by the seats the game actually has', () => {
  it('no longer refuses a field with the bare literal three', () => {
    expect(baseCode).not.toMatch(/if\s*\(\(regCount\s*\|\|\s*0\)\s*<\s*3\)/);
  });

  it('derives the required field from max_players', () => {
    expect(baseCode).toMatch(/const\s+requiredField\s*=/);
    expect(baseCode).toMatch(/Math\.min\(\s*3\s*,\s*seatsAvailable\s*\)/);
  });

  it('compares the head count against that derived field, not a constant', () => {
    expect(baseCode).toMatch(/\(regCount\s*\|\|\s*0\)\s*<\s*requiredField/);
  });

  it('never lets the floor fall below two -- a game of one is not a game', () => {
    expect(baseCode).toMatch(
      /Math\.max\(\s*2\s*,\s*Math\.min\(\s*3\s*,\s*seatsAvailable\s*\)\s*\)/
    );
  });

  it('keeps the Spin floor at three when max_players is missing or zero', () => {
    // `Number(x) || 0` collapses null/undefined/0 alike, and the ternary then
    // falls back to 3 -- so a malformed row can never lower the Spin bar.
    expect(baseCode).toMatch(/seatsAvailable\s*>\s*0\s*\?\s*Math\.max\(\s*2\s*,[\s\S]{0,40}:\s*3/);
  });

  it('says how big the field needs to be when it stands down', () => {
    expect(base).toMatch(/of \$\{requiredField\} player\(s\)/);
  });

  it('reads max_players off the tournament row it already fetched', () => {
    expect(baseCode).toMatch(/const\s+seatsAvailable\s*=\s*Number\(tournament\.max_players\)/);
  });
});

describe('the required field, evaluated the way the engine evaluates it', () => {
  const requiredField = (maxPlayers: number | null | undefined) => {
    const seatsAvailable = Number(maxPlayers) || 0;
    return seatsAvailable > 0 ? Math.max(2, Math.min(3, seatsAvailable)) : 3;
  };

  it('a heads-up game needs two, which is exactly what it can hold', () => {
    expect(requiredField(2)).toBe(2);
  });

  it('a Spin still needs three -- Dan’s rule is untouched', () => {
    expect(requiredField(3)).toBe(3);
  });

  it('an MTT still needs three, exactly as before', () => {
    expect(requiredField(50)).toBe(3);
    expect(requiredField(9)).toBe(3);
  });

  it('a malformed row falls back to three, never lower', () => {
    expect(requiredField(null)).toBe(3);
    expect(requiredField(undefined)).toBe(3);
    expect(requiredField(0)).toBe(3);
  });

  it('a one-seat row cannot start a game with one player', () => {
    expect(requiredField(1)).toBe(2);
  });
});

describe('current_players is counted by the database, not narrated by callers', () => {
  it('ships a trigger that recomputes it from the registration rows', () => {
    expect(counterMigration).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_sync_tournament_current_players/i
    );
    expect(counterMigration).toMatch(/CREATE\s+TRIGGER\s+trg_sync_tournament_current_players/i);
  });

  it('fires on every shape of change a registration can undergo', () => {
    expect(counterMigration).toMatch(
      /AFTER\s+INSERT\s+OR\s+DELETE\s+OR\s+UPDATE\s+OF\s+status,\s*tournament_id/i
    );
  });

  it('counts registered AND playing -- a player mid-start is still an entrant', () => {
    expect(counterMigration).toMatch(/status\s+IN\s*\(\s*'registered',\s*'playing'\s*\)/i);
  });

  it('only reconciles before the game starts, so payout math is never disturbed', () => {
    // Once RUNNING, current_players means TOTAL ENTRANTS and is read by the
    // fee and prize calculations long after players have busted. Recomputing
    // it there would shrink the entrant total on every elimination.
    expect(counterMigration).toMatch(/AND\s+status\s+IN\s*\(\s*'ANNOUNCED',\s*'REGISTERING'\s*\)/i);
  });

  it('repairs the rows that had already drifted', () => {
    expect(counterMigration).toMatch(/UPDATE\s+public\.tournaments/i);
    expect(counterMigration).toMatch(/was\s+IS\s+DISTINCT\s+FROM\s+truth\.is_really/i);
  });

  it('refuses to apply if any pre-start row still disagrees with its field', () => {
    expect(counterMigration).toMatch(/RAISE\s+EXCEPTION\s+'current_players still disagrees/i);
  });
});
