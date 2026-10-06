/**
 * A DELETED BOARD GAME IS CHECKED BY INDEX.
 *
 * The certification cleanup deletes the welcome board's tournaments, tables
 * and cash games while it holds the platform entry lock (530090,1)
 * exclusively. Three referencing columns had no index, so every delete ran a
 * full-table foreign-key scan (140-226 ms per tournament, 121-193 ms per
 * table, 184 ms per cash game on production, 2026-10-03), and blind
 * publication across the platform waited behind it. This law keeps the three
 * indexes declared, built CONCURRENTLY before the transaction, and keeps any
 * later migration from dropping them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const ALL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const NAME = ALL.filter((f) => f.endsWith('_a_deleted_board_game_is_checked_by_index.sql')).at(-1);
if (!NAME) throw new Error('the board-game FK index migration is missing');
const code = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
const INDEXES = [
  'idx_tournament_refund_entitlements_source_satellite',
  'idx_cash_seat_moves_to_table',
  'idx_cash_seat_moves_game',
];

describe('a deleted board game is checked by index', () => {
  it('builds the three FK indexes concurrently before one verifying transaction', () => {
    const sql = code(NAME);
    const begin = sql.indexOf('\nBEGIN;');
    expect(begin).toBeGreaterThan(0);
    for (const name of INDEXES) {
      const at = sql.indexOf(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}`);
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(at, name).toBeLessThan(begin);
      expect(sql.slice(begin), name).toContain(`('${name}')`);
    }
    expect(sql).toMatch(
      /ON public\.tournament_refund_entitlements \(source_satellite_id\)\s+WHERE source_satellite_id IS NOT NULL;/
    );
    expect(sql).toMatch(/ON public\.cash_seat_moves \(to_table_id\);/);
    expect(sql).toMatch(/ON public\.cash_seat_moves \(game_id\);/);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('no later migration drops them', () => {
    for (const file of ALL.slice(ALL.indexOf(NAME) + 1)) {
      const sql = code(file);
      for (const name of INDEXES) {
        expect(sql, `${file} drops ${name}`).not.toMatch(
          new RegExp(
            `DROP\\s+INDEX\\s+(CONCURRENTLY\\s+)?(IF\\s+EXISTS\\s+)?(public\\.)?${name}\\b`,
            'i'
          )
        );
      }
    }
  });
});
