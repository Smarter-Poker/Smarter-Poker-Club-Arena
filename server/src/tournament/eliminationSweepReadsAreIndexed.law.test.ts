/**
 * LAW: the elimination sweep reads the atomic standings source and never
 * reconciles it from live seats.
 *
 * Every tournament hand now mirrors its settled seat stacks into
 * tournament_players inside the same database transaction. Reading seats in
 * the later five-second sweep and writing a second copy introduced both stale
 * overwrite races and a repair loop. The sweep may decide eliminations from
 * tournament_players; it may not repair that source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const sweep = source
  .slice(
    source.indexOf('protected startEliminationChecker()'),
    source.indexOf('private async tryTournamentRebuys(')
  )
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const tables = readFileSync(join(__dirname, '../services/supabase/tables.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('LAW: elimination consumes the atomic standings mirror', () => {
  it('has no seat-to-standings reconciler or strike-based repair writer', () => {
    expect(sweep).not.toContain('fn_sync_tournament_chips');
    expect(sweep).not.toContain('seatlessPlayingStrikes');
    expect(sweep).not.toContain('SEATLESS_PHANTOM_STRIKES');
    expect(sweep).not.toContain(".from('table_seats')");
  });

  it('has no secondary post-hand standings sync helper', () => {
    expect(tables).not.toContain('syncTournamentChips');
  });

  it('still reads every busted entry from the authoritative standings rows', () => {
    expect(sweep).toMatch(
      /\.from\('tournament_players'\)[\s\S]*?\.eq\('tournament_id', this\.tournamentId\)[\s\S]*?\.eq\('status', 'playing'\)[\s\S]*?\.lte\('chips', 0\)/
    );
  });
});
