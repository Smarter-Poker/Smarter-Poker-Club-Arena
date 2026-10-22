/**
 * A DEALING TOURNAMENT IS NEVER DARK (2026-10-21)
 *
 * Turbo Tuesday PKO bc8e3d86 dealt 20 hands a minute while its level clock was
 * held, wrote no table row and busted nobody, so fn_ca_tournament_dark_candidates
 * read it as dark. GameServer's dark sweep then rebuilt its manager every hour
 * (14:07:04 rebuild, every table stopped until 14:17), ten times in one day.
 *
 * The latest committed hand is activity. This pins the newest migration that
 * defines the function: it must still read the event's latest hand_history row,
 * through the (tournament_id, created_at DESC) index, inside last_activity.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations');

function newestDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    if (/CREATE OR REPLACE FUNCTION public\.fn_ca_tournament_dark_candidates\s*\(/.test(sql)) {
      found = { file, sql };
    }
  }
  if (!found) throw new Error('no migration defines fn_ca_tournament_dark_candidates');
  return found;
}

describe('a dealing tournament is never dark', () => {
  it('the newest definition counts the latest dealt hand as activity', () => {
    const { file, sql } = newestDefinition();
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_tournament_dark_candidates'));
    const activity = body.slice(body.indexOf('GREATEST('), body.indexOf('AS last_activity'));
    expect(activity, file).toMatch(/FROM public\.hand_history hh/);
    expect(activity, file).toMatch(/hh\.tournament_id = t\.id/);
    expect(activity, file).toMatch(/ORDER BY hh\.created_at DESC\s+LIMIT 1/);
  });

  it('table writes and busts still count, so nothing that was activity stops being activity', () => {
    const { sql } = newestDefinition();
    expect(sql).toMatch(/max\(tb\.updated_at\) FROM public\.tables tb/);
    expect(sql).toMatch(/max\(tp\.eliminated_at\) FROM public\.tournament_players tp/);
  });

  it('the index the hand read relies on exists in the migration history', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const declared = files.some((f) =>
      /idx_hand_history_tournament_created/.test(readFileSync(join(MIGRATIONS, f), 'utf8'))
    );
    expect(declared).toBe(true);
  });
});
