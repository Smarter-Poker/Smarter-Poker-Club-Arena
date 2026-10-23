/**
 * ===========================================================================
 *  LAW - CLUB DATA COUNTS CHICAGO DAYS; MTT WINNINGS ARE FINISHED MTTS
 * ===========================================================================
 *
 * Dan, 2026-10-22: Club Data and Union Data count days by the America/Chicago
 * calendar day (DST aware), not UTC; "MTT Winnings" covers finished MTTs only,
 * and a running MTT's entries are shown separately as "Unfinished MTT Entries".
 * Totals still reconcile: total = cash + every tournament flow.
 *
 * The bucket is fixed at the source (20261022103651): the one live writer
 * files each event under its Chicago day as well as its UTC day, in the same
 * statement. The readers (20261022120121) read that bucket. Every pin below
 * fails SILENTLY if it regresses: the page keeps rendering, a day just rolls
 * over at 7 PM again or a running MTT's entries read as a loss.
 *
 * Qualified on real Postgres, to the cent, by
 * scripts/ci/test-club-data-union-mtt-postgres.py.
 */
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring } from './helpers/migrations';

function latest(fnName: string): string {
  return functionBody(latestDeclaring(fnName).sql, fnName)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}
const squash = (s: string) => s.replace(/\s+/g, ' ');

const READERS = [
  'ca_club_data_screen',
  'ca_club_data_snapshot_v2',
  'ca_club_game_page_core_20261006',
  'ca_club_game_export_start',
  'fn_ca_club_games_searched',
  'fn_ca_club_games_unsearched',
  'fn_ca_club_cash_felt',
  'fn_ca_club_data_hand_count',
  'fn_ca_rake_felt_v2',
  'fn_ca_rake_series_v2',
  'fn_ca_rake_window_v2',
  'ca_rake_snapshot_v2',
  'ca_rake_export_start_v2',
];

describe('the live writer files every event under its Chicago day', () => {
  it('writes the Chicago bucket in the same statement as the UTC one', () => {
    const b = squash(latest('fn_ca_club_data_fact_put'));
    expect(b).toContain('INSERT INTO public.ca_club_data_fact AS f');
    expect(b).toContain('INSERT INTO public.ca_club_data_fact_ct AS c');
    expect(b).toContain('INSERT INTO public.ca_club_data_game_ct AS g');
    expect(b).toContain('public.fn_ca_chicago_day(COALESCE(p_at, now()))');
  });

  it('a Chicago day is the zone database day, DST included', () => {
    expect(squash(latest('fn_ca_chicago_day'))).toContain(
      "SELECT (p_at AT TIME ZONE 'America/Chicago')::date;"
    );
  });

  it('the rake trigger counts the raked hand for every club that shares it', () => {
    const b = squash(latest('trg_ca_club_data_fact_rake'));
    expect(b).toContain(
      'PERFORM public.fn_ca_club_data_hand_put(r.club_id, NEW.table_id, NEW.created_at);'
    );
    expect(b).toContain(
      'PERFORM public.fn_ca_club_data_hand_put(v_table_club, NEW.table_id, NEW.created_at);'
    );
  });
});

describe('every Club Data and Union Data reader counts Chicago days', () => {
  it.each(READERS)('%s never reads a UTC day', (fn) => {
    const b = latest(fn);
    expect(b).not.toMatch(/AT TIME ZONE 'UTC'/);
    expect(b).not.toMatch(/public\.ca_club_data_fact\b(?!_ct)/);
    expect(b).not.toMatch(
      /club_table_daily|ca_club_tournament_daily|ca_club_tournament_player_daily/
    );
  });

  it('"today" is the Chicago calendar day', () => {
    for (const fn of [
      'ca_club_data_screen',
      'ca_club_data_snapshot_v2',
      'ca_club_game_page_core_20261006',
      'ca_club_game_export_start',
      'ca_rake_snapshot_v2',
      'ca_rake_export_start_v2',
    ]) {
      expect(latest(fn)).toMatch(
        /v_today date ?:= ?\(now\(\) AT TIME ZONE 'America\/Chicago'\)::date;/
      );
    }
  });

  it('the pages say what they count', () => {
    expect(latest('ca_club_data_screen')).toContain("'accounting_basis', 'chicago_net_money_flow'");
    expect(latest('ca_rake_snapshot_v2')).toContain("'accounting_basis','chicago_net_money_flow'");
  });
});

describe('MTT Winnings are finished MTTs; running MTT entries are their own figure', () => {
  it('the screen splits MTTs by tournaments.status and keeps both inside the tournament total', () => {
    const b = squash(latest('ca_club_data_screen'));
    expect(b).toContain("COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)");
    expect(b).toContain("'running_mtt_entries', round(v_run_win, 2)");
    expect(b).toContain("'tournament_winnings', round(v_tour_win,2)");
    expect(b).toContain(
      "mt.tournament_type='MTT' AND NOT COALESCE(mt.status IN ('COMPLETED','CANCELLED'),false)"
    );
  });

  it('the Union Data window does the same, finding MTTs from tournaments', () => {
    // 20261022165130: fn_ca_rake_window_v2 delegates to the one-pass reader,
    // which carries the split for the whole union and for every club.
    expect(squash(latest('fn_ca_rake_window_v2'))).toContain(
      'public.fn_ca_rake_windows_v3(p_clubs, p_start, p_end, false)->\'all\''
    );
    const b = squash(latest('fn_ca_rake_windows_v3'));
    expect(b).toContain("bool_or(COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)) finished");
    expect(b).toContain("tr.tournament_type='MTT' GROUP BY");
    expect(b).toContain('FILTER (WHERE m.finished)');
    expect(b).toContain('FILTER (WHERE NOT m.finished)');
    expect(b).toContain("'running_mtt_entries',round(a.rw,2)");
  });
});

describe('the union reads count each thing once (20261022134523)', () => {
  it('the per-club list reads each club window once', () => {
    // 20261022165130: once for every club together, not once per club.
    const b = squash(latest('fn_ca_rake_by_club_v2'));
    expect(b).toContain('public.fn_ca_rake_windows_v3(p_clubs, p_start, p_end, true)->\'clubs\'');
    expect(b).not.toContain('CROSS JOIN LATERAL');
  });

  it('the union game page and game lists count hands in one grouped pass', () => {
    for (const fn of [
      'ca_club_game_page_core_20261006',
      'fn_ca_club_games_searched',
      'fn_ca_club_games_unsearched',
    ]) {
      const b = latest(fn);
      expect(b).toContain('union_hands AS MATERIALIZED');
      expect(b).not.toContain('public.fn_ca_club_data_hand_count($1');
    }
  });

  it('the legacy open-client contract still maps MTT to every tournament', () => {
    expect(squash(latest('ca_club_data_snapshot'))).toContain(
      "jsonb_build_object('mtt_winnings',r->k->'tournament_winnings','mtt_fee',r->k->'tournament_fee')"
    );
  });
});
