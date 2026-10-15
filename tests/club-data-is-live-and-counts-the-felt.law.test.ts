/**
 * LAW: CLUB DATA IS LIVE, AND IT COUNTS THE FELT (Dan 2026-10-14, binding)
 * ===========================================================================
 * Dan: "THE DATA PAGE IS NOT ACCURATE ... MAKE SURE THAT ALL THE DATA IS
 * REAL TIME ACCURATE DATA."
 *
 * Read from production on 2026-10-15 00:59 UTC:
 *   1. Cash rake, cash buy-ins and cash-outs reached club_table_daily only
 *      through an hourly rebuild at :25. A hand raked at :26 was invisible for
 *      59 minutes, and "1 Day" was empty for the first 25 minutes of a day.
 *   2. Cash winnings were cash-outs minus buy-ins, so every chip still in front
 *      of a seated player read as a loss (SHARK CLUB: -120,379.07 on a day with
 *      53,904.92 on its players' seats).
 *
 * The fix is at the writer: the insert triggers that already fed the
 * tournament rollup now write the cash rollup in the same transaction, the
 * hourly job no longer rewrites the live day, and the snapshot adds the felt.
 * This file pins all of it against the NEWEST definition of each function, so
 * a later migration that quietly drops the live writer fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { functionBody } from './helpers/migrations';
import { migrationsMentioning } from './helpers/migrationCorpus';

function latest(fnName: string): string {
  const hits = migrationsMentioning(`FUNCTION public.${fnName}(`);
  if (hits.length === 0) throw new Error(`${fnName} is not defined by any migration`);
  return functionBody(hits[hits.length - 1].sql, fnName)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

const PAGE = readFileSync(
  resolve(__dirname, '../src/pages/club/ClubDataSimplePage.tsx'),
  'utf8'
);
const APP = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');

describe('cash rake reaches Club Data in the transaction that writes it', () => {
  it('the rake insert trigger writes the cash rollup for a cash hand', () => {
    const b = latest('trg_ca_reporting_rake_insert');
    expect(b).toContain('fn_ca_club_table_daily_add_rake(NEW.table_id');
    // and still only SHARES the reporting lock
    expect(b).toContain('pg_advisory_xact_lock_shared(918273645)');
    expect(b).not.toMatch(/pg_advisory_xact_lock\(918273645\)/);
  });

  it('the live writer attributes exactly like the rebuild', () => {
    const b = latest('fn_ca_club_table_daily_add_rake');
    expect(b).toContain('INSERT INTO public.club_table_daily');
    expect(b).toContain('fn_ca_cash_reporting_club(v_union, v_table_club');
    expect(b).toContain('fn_ca_launch_accounting_accepts(r.club_id, p_at)');
    // a raked hand with no usable contribution is the table club's, whole
    expect(b).toContain('SELECT NULL::text, 1::numeric, 1::numeric');
    const club = latest('fn_ca_cash_reporting_club');
    expect(club).toContain('ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id');
  });
});

describe('cash buy-ins and cash-outs reach Club Data live', () => {
  it('the wallet insert trigger writes the cash table row', () => {
    const b = latest('trg_ca_reporting_wallet_insert');
    expect(b).toContain('INSERT INTO public.club_table_daily');
    expect(b).toContain('v_table_row_club := COALESCE(v_club, v_table_club);');
    // its own block, so a failure never costs the player rollup
    expect(b).toContain("RAISE WARNING 'Club Data cash table rollup failed");
  });
});

describe('the hourly job never rewrites the live day', () => {
  it('the rebuild declines today unless the one-off seed opts in', () => {
    const b = latest('fn_club_table_daily_refresh_day');
    expect(b).toContain("current_setting('ca.club_data_seed_live_day', true)");
    expect(b).toContain("'skipped', 'live_day_is_kept_by_triggers'");
    expect(b.indexOf('live_day_is_kept_by_triggers')).toBeLessThan(
      b.indexOf('DELETE FROM club_table_daily')
    );
  });

  it('a rebuild merges with a trigger that lands while it runs', () => {
    const b = latest('fn_club_table_daily_refresh_day');
    expect(b).toContain('ON CONFLICT (club_id, table_id, stat_date) DO UPDATE');
    expect(b).toContain('DELETE FROM ca_club_table_player_daily WHERE stat_date = p_day');
  });
});

describe('a seated stack is part of the result, not a loss', () => {
  it('the snapshot adds the felt to winnings, totals and rows alike', () => {
    const b = latest('ca_club_data_snapshot');
    expect(b).toContain('fn_ca_club_cash_felt(p_club_id,v_start,v_end');
    expect(b).toContain('fn_ca_club_cash_felt(p_club_id,v_pstart,v_pend');
    expect(b).toContain("'on_felt'");
    expect(b).toContain("'live',true");
  });

  it('the felt is every live seat of the club, horse or human', () => {
    const b = latest('fn_ca_club_cash_felt');
    expect(b).toContain('s.left_at IS NULL');
    expect(b).not.toMatch(/is_horse/);
  });
});

describe('the everyday screen lists what was played, live first', () => {
  it('ranks by activity inside the window, never by a table creation date', () => {
    const b = latest('ca_club_data_screen');
    expect(b).toContain('ca_can_view_club_finances(p_club_id)');
    expect(b).toContain('ORDER BY live DESC, activity_at DESC NULLS LAST');
    expect(b).toContain('fn_ca_club_cash_felt(p_club_id, v_start, v_end');
    expect(b).toContain('fn_ca_club_game_summary(p_club_id, v_start, v_end');
  });
});

describe('the everyday screen reads live and stays simple', () => {
  it('is the screen at clubs/:clubId/data, with the full report one tap away', () => {
    expect(APP).toMatch(/path="clubs\/:clubId\/data"[\s\S]{0,300}<ClubDataSimplePage \/>/);
    expect(APP).toMatch(/path="clubs\/:clubId\/data\/advanced"[\s\S]{0,300}<ClubDataPage \/>/);
  });

  it('re-reads on a short clock and never paints zeros for a failed read', () => {
    expect(PAGE).toContain("supabase.rpc('ca_club_data_screen'");
    expect(PAGE).toContain('preset === 1 ? 15_000 : 60_000');
    expect(PAGE).toContain('Showing The Last Good Figures.');
    expect(PAGE).toContain("summary ? formatMoney(summary.total_winnings) : '-'");
  });
});
