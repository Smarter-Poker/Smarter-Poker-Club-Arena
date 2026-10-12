/**
 * THE SEPTEMBER 8 GAMES COMMIT THE LAUNCH THEIR ENGINE LOST (2026-10-01)
 *
 * Twenty-six Spins and heads-up Sit & Gos were dealt on
 * 2026-09-08, lost their engine before the launch's RUNNING commit, and sat in
 * REGISTERING for three weeks holding 1,223.10 chips of finalized pools. The
 * repair commits exactly the lost step through the launch's own door and lets
 * the finish authorities pay each event in its own transaction. These pins
 * keep the file from ever becoming a hand-written payout.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  'supabase/migrations/20261001225325_the_september_eight_games_commit_the_launch_their_engine_los.sql',
  'utf8'
);
const body = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

/** Seat-first duel satellites: their pre-agreement entry fee has no custody
 * route through the satellite authority, so a launch would strand them
 * RUNNING. They stay REGISTERING and out of this file. */
const SATELLITES = ['097e3601', '20c75b67', '92c93927', 'a4262ba0'];

const STRANDED = [
  '00f57d7b',
  '106c4e13',
  '2aa4cba1',
  '2d6dadb7',
  '3843907b',
  '44d7e2d8',
  '482e90bb',
  '659d3ec6',
  '6d359f61',
  '7284506c',
  '8904c10b',
  '8c6a20c5',
  '8d5969da',
  '90c4d93f',
  '95e43b6e',
  '9cecb4fa',
  'ab4125bc',
  'b3b65e07',
  'b5fae1b3',
  'b67ab0cb',
  'c2fd1c7e',
  'dae6db50',
  'e62a97cc',
  'efd5455d',
  'f58d6375',
  'f5a6896b',
];

describe('the September 8 stranded games commit their lost launch', () => {
  it('declares a live proof a reader can run', () => {
    expect(MIGRATION).toMatch(/^-- @live-proof: .+$/m);
  });

  it('names exactly the twenty-six Spins and Sit & Gos, each with a pre-image and a start before its first bust', () => {
    const ids = [
      ...body.matchAll(
        /"id":"([0-9a-f]{8})-[0-9a-f-]{27}","preimage":"[0-9a-f]{32}","started_at":"2026-09-08 [0-9:.]+\+00"/g
      ),
    ].map((m) => m[1]);
    expect(ids.sort()).toEqual([...STRANDED].sort());
    for (const satellite of SATELLITES) expect(body).not.toContain(satellite);
    expect(body).toContain('v_n <> 26 OR v_total IS DISTINCT FROM 1223.10');
    expect(body).toContain('SEP8_LAUNCH_PREIMAGE_CHANGED');
    expect(body).toMatch(/v_row\.started_at >= \(SELECT min\(p\.eliminated_at\)/);
  });

  it('goes through the launch door: an immutable receipt and the exact launch marker', () => {
    expect(body).toContain(
      'INSERT INTO public.tournament_launch_receipts(tournament_id, launch_id, started_at)'
    );
    expect(body).toMatch(
      /set_config\('app\.atomic_tournament_launch',\s*v_row\.tournament_id::text \|\| ':' \|\| v_launch::text, true\)/
    );
    expect(body).toMatch(
      /SET status = 'RUNNING', started_at = v_row\.started_at\s+WHERE id = v_row\.tournament_id AND status = 'REGISTERING' AND started_at IS NULL/
    );
    expect(body).toContain('SET completed_at = transaction_timestamp()');
    expect(body).toContain('fn_ca_break_window_refuses_migrations(now())');
  });

  it('pays nobody itself: the finish authorities own every credit', () => {
    for (const forbidden of [
      'fn_complete_tournament_terminal',
      'fn_settle_satellite_tournament',
      'fn_settle_tournament_places',
      'fn_credit_and_log',
      'INSERT INTO public.tournament_payouts',
      'UPDATE public.tournament_players',
      'UPDATE public.tournament_escrow',
      'UPDATE public.club_members',
      'ca.break_window_migration_override',
      'pg_sleep',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).toContain('SEP8_LAUNCH_POSTIMAGE');
    expect((body.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((body.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });
});
