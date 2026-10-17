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

/* UPDATED 2026-10-17 (20261017161545) with the change it pins. The cash live
   writer moved from the rake_records trigger to the rake_attributions insert,
   because the attribution row is the money record that names the club the
   rake was taken for; #7262's guess (the player's newest seat at ANY table)
   credited one table's rake to another table's club. */
describe('cash rake reaches Club Data in the transaction that writes it', () => {
  it('the attribution insert writes the cash rollup, sharing the reporting lock', () => {
    const b = latest('trg_ca_club_data_cash_attribution_insert');
    expect(b).toContain('INSERT INTO public.club_table_daily');
    expect(b).toContain('INSERT INTO public.ca_club_table_player_daily');
    expect(b).toContain('pg_advisory_xact_lock_shared(918273645)');
    expect(b).not.toMatch(/pg_advisory_xact_lock\(918273645\)/);
    expect(b).toContain("RAISE WARNING 'Club Data cash attribution rollup failed");
  });

  it('the live writer attributes exactly like the rebuild', () => {
    const live = latest('trg_ca_club_data_cash_attribution_insert');
    const stage = latest('fn_ca_club_data_stage');
    for (const b of [live, stage]) {
      expect(b).toContain('THEN a.club_id');
      expect(b).toContain('public.fn_ca_cash_hand_club(r.table_id, a.player_id, r.created_at)');
    }
    // the rake_records trigger no longer writes cash at all
    const rake = latest('trg_ca_reporting_rake_insert');
    expect(rake).not.toContain('fn_ca_club_table_daily_add_rake');
    expect(rake).toContain('fn_ca_club_data_tournament_fee_split(NEW.id)');
  });

  it("a player's club is read at THE table where the hand was played", () => {
    const b = latest('fn_ca_cash_hand_club');
    expect(b).toContain('ts.table_id = p_table AND ts.user_id = p_user');
    expect(b).toContain('cl.table_id = p_table');
    // the union decides which clubs are possible at a union table
    expect(b).toContain('uc.union_id = v_union');
    // never the newest seat at any table
    expect(b).not.toMatch(/WHERE ts\.user_id = p_user AND ts\.club_id IS NOT NULL/);
    const old = latest('fn_ca_cash_reporting_club');
    expect(old).not.toContain('table_seats');
  });
});

describe('cash buy-ins and cash-outs reach Club Data live', () => {
  it('the wallet insert trigger writes the cash table row for the club at that table', () => {
    const b = latest('trg_ca_reporting_wallet_insert');
    expect(b).toContain('INSERT INTO public.club_table_daily');
    expect(b).toContain('public.fn_ca_cash_hand_club(NEW.table_id, NEW.user_id, NEW.created_at)');
    // its own block, so a failure never costs the player rollup
    expect(b).toContain("RAISE WARNING 'Club Data cash table rollup failed");
  });
});

describe('a tournament is credited to the club the entry was paid from', () => {
  it('fees come from the accounting fee source, live and on rebuild', () => {
    expect(latest('trg_ca_club_data_tournament_fee_insert')).toContain('SUM(f.rake_credit)');
    expect(latest('fn_ca_club_data_stage')).toContain(
      'JOIN public.accounting_tournament_fee_sources f ON f.rake_record_id = r.id'
    );
  });

  it('results go to ONE club, the entry club, never every membership', () => {
    const b = latest('trg_ca_reporting_wallet_insert');
    expect(b).toContain('public.fn_ca_tournament_entry_club(NEW.related_entity_id, NEW.user_id)');
    expect(b).not.toContain('ca_reporting_tournament_clubs_for_user');
    expect(latest('fn_ca_tournament_entry_club')).toContain('tp.tournament_id = p_tournament AND tp.user_id = p_user');
  });
});

describe('the hourly job never rewrites the live day', () => {
  it('the rebuild declines today unless the one-off seed opts in', () => {
    const b = latest('fn_club_table_daily_refresh_day');
    expect(b).toContain("current_setting('ca.club_data_seed_live_day', true)");
    expect(b).toContain("'skipped', 'live_day_is_kept_by_triggers'");
    expect(b.indexOf('live_day_is_kept_by_triggers')).toBeLessThan(
      b.indexOf('fn_ca_club_data_stage')
    );
  });

  it('a deliberate re-count of the live day holds the reporting lock only for its swap', () => {
    const b = latest('fn_ca_club_data_rebuild_day');
    const lock = b.indexOf('pg_advisory_xact_lock(918273645)');
    expect(lock).toBeGreaterThan(b.indexOf("clock_timestamp() - interval '5 minutes'"));
    expect(lock).toBeLessThan(b.lastIndexOf('fn_ca_club_data_publish(p_day, true, true)'));
  });

  it('publishing replaces only rows that changed', () => {
    const b = latest('fn_ca_club_data_publish');
    expect(b).toContain('ON CONFLICT (club_id, table_id, stat_date) DO UPDATE');
    expect(b).toMatch(/IS DISTINCT FROM/);
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

describe('the everyday screen wears the Smarter.Poker look (Dan 2026-10-15)', () => {
  const css = readFileSync(resolve(__dirname, '../src/pages/club/ClubDataSimplePage.module.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  it('uses the strict house palette, never the PokerBros gold', () => {
    expect(css).not.toMatch(/#f4b52a|#ffd24d|#d9901a|#3b3f86/i);
    expect(css).toContain('--cd-accent: #6fdcff;');
    expect(css).toContain('--cd-action: #1877f2;');
  });
  it('builds every frame from the three-layer depth recipe', () => {
    expect(css).toMatch(/--cd-bevel:\s*inset 0 1px 0/);
    expect(css).toMatch(/\.stats\s*\{[^}]*box-shadow:\s*var\(--cd-bevel\), var\(--cd-cast-high\)/);
    expect(css).toMatch(/\.row\s*\{[^}]*box-shadow:\s*var\(--cd-bevel\), var\(--cd-cast\)/);
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
    expect(PAGE).toContain("summary ? formatTotal(summary.total_winnings) : '-'");
    // the exact figure is never lost: it is the tile's title and accessible name
    expect(PAGE).toContain('aria-label={summary ? formatMoney(summary.total_winnings) : undefined}');
  });
});
