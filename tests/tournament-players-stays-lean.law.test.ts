/**
 * LAW: TOURNAMENT_PLAYERS STAYS LEAN (2026-10-15).
 *
 * tournament_players is updated on every tournament hand. With the default
 * fillfactor half its updates could not be HOT, so each wrote into all 15
 * indexes, and the default autovacuum scale factor let 18% of the table sit
 * dead. Migration 20261015103046 leaves room on each page (fillfactor 85),
 * vacuums after 2% plus 1,000 dead rows, and rebuilds the six bloated plain
 * indexes online, swapping each in only when it is valid and identical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';

const SQL = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20261015103046_tournament_players_stays_lean.sql'),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');
const REBUILT = [
  'idx_tournament_players_basis',
  'idx_tournament_players_registered_at',
  'idx_tournament_players_chips',
  'idx_tournament_players_club',
  'idx_tournament_players_status',
  'idx_tourn_players_tourn',
];

describe('tournament_players stays lean', () => {
  it('rebuilds only in the admitted concurrent preamble, then one transaction', () => {
    const split = splitConcurrentPreamble(SQL);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.indexes.map((i) => i.name)).toEqual(REBUILT.map((n) => `${n}_rebuilt`));
    expect(split.indexes.every((i) => i.table === 'tournament_players')).toBe(true);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });

  it('swaps an index in only when it is valid, identical and not a constraint', () => {
    expect(CODE).toContain("SET LOCAL lock_timeout = '2s';");
    expect(CODE).toContain('tournament_players_lean_index_missing_or_invalid');
    expect(CODE).toContain('tournament_players_lean_definition_differs');
    expect(CODE).toContain('tournament_players_lean_index_is_a_constraint');
    expect(CODE).toContain("replace(new_def, n || '_rebuilt', n) IS DISTINCT FROM old_def");
    for (const n of REBUILT) expect(CODE).toContain(`'${n}'`);
    expect(CODE).not.toMatch(
      /tournament_players_pkey|tournament_id_user_id_key|one_finish_position|one_elimination_sequence/
    );
  });

  it('leaves room for HOT updates and vacuums before a fifth of the table is dead', () => {
    for (const option of [
      'fillfactor = 85',
      'autovacuum_vacuum_scale_factor = 0.02',
      'autovacuum_vacuum_threshold = 1000',
      'autovacuum_analyze_scale_factor = 0.02',
      'autovacuum_analyze_threshold = 1000',
    ])
      expect(CODE).toContain(option);
  });

  it('reads and writes no row', () => {
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});
